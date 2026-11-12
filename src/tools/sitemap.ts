import { z } from 'zod';
import { markdownTable } from '../format.js';
import { InputError, finish, getDisk, handle, siteUrl, READ_ONLY, warningsField } from './shared.js';
import type { Registration } from './index.js';

const KINDS = ['categories', 'shops', 'items'] as const;
type Kind = (typeof KINDS)[number];

const ITEMS_PER_FILE = 50_000;
const TTL = 24 * 3600 * 1000;

const PATHS: Record<Kind, string> = { categories: 'kategori', shops: 'butikk', items: 'produkt' };

/** Parsed sitemap file, stored on disk as parallel arrays to keep 50k-entry files small. */
interface IdList {
  ids: string[];
  lastmod: string[];
}

const output = z.object({
  kind: z.enum(KINDS),
  offset: z.number(),
  limit: z.number(),
  total: z.number(),
  total_is_lower_bound: z.boolean(),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  entries: z.array(z.object({ id: z.string(), url: z.string(), lastmod: z.string().optional() })),
  ...warningsField,
});

/** Regex scan of <url>/<sitemap> blocks; avoids building a DOM for multi-megabyte files. */
export function parseSitemapEntries(xml: string, kind: Kind | 'index'): IdList & { locs: string[] } {
  const ids: string[] = [];
  const lastmod: string[] = [];
  const locs: string[] = [];
  const idRe = kind === 'index' ? undefined : new RegExp(`/${PATHS[kind]}/(\\d+)`);
  const block = /<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/g;
  for (let m = block.exec(xml); m; m = block.exec(xml)) {
    const body = m[1] ?? '';
    const loc = /<loc>\s*([^<]*?)\s*<\/loc>/.exec(body)?.[1];
    if (!loc) continue;
    locs.push(loc);
    const mod = /<lastmod>\s*([^<]*?)\s*<\/lastmod>/.exec(body)?.[1] ?? '';
    if (idRe) {
      const id = idRe.exec(loc)?.[1];
      if (!id) continue;
      ids.push(id);
      lastmod.push(mod);
    }
  }
  return { ids, lastmod, locs };
}

const MEMORY_FILES = 4;

// Process-wide (servers are created per HTTP request), keyed by data dir so instances stay isolated.
/** Concurrent callers share one download per key. */
const inflight = new Map<string, Promise<unknown>>();
/** Fallback when the disk cache cannot be written (e.g. read-only data dir): newest MEMORY_FILES files. */
const memory = new Map<string, { value: unknown; at: number }>();
const diskWarned = new Set<string>();

export const registerSitemapTools: Registration = (server, ctx) => {
  async function cached<T>(rawKey: string, load: () => Promise<T>, warnings: string[], keepInMemory = false): Promise<T> {
    const disk = getDisk(ctx);
    const key = `${ctx.config.dataDir}|${rawKey}`;
    const hit = await disk.get<T>(rawKey, TTL);
    if (hit !== undefined) return hit;
    const mem = memory.get(key);
    if (mem && Date.now() - mem.at < TTL) return mem.value as T;
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = (async () => {
        const value = await load();
        try {
          await disk.set(rawKey, value);
        } catch {
          if (keepInMemory) {
            memory.delete(key);
            memory.set(key, { value, at: Date.now() });
            while (memory.size > MEMORY_FILES) memory.delete(memory.keys().next().value as string);
          }
          if (!diskWarned.has(ctx.config.dataDir)) {
            diskWarned.add(ctx.config.dataDir);
            warnings.push('disk cache is not writable; sitemap files are kept in memory only');
          }
        }
        return value;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  const fetchXml = (path: string, big: boolean) => ctx.client.getHtml(path, { noCache: big });

  const sitemapFiles = (warnings: string[]): Promise<{ categories: string; shops: string; items: Array<{ start: number; path: string }> }> =>
    cached('sitemap:index:v1', async () => {
      const { locs } = parseSitemapEntries(await fetchXml('/sitemap.xml', false), 'index');
      const paths = locs.map((l) => new URL(l, 'https://x/').pathname);
      const items = paths
        .map((p) => ({ p, m: /sitemap\.items\.(\d+)\.xml$/.exec(p) }))
        .filter((x): x is { p: string; m: RegExpExecArray } => x.m !== null)
        .map((x) => ({ start: Number(x.m[1]), path: x.p }))
        .sort((a, b) => a.start - b.start);
      return {
        categories: paths.find((p) => /sitemap\.categories\.xml$/.test(p)) ?? '/sitemap.categories.xml',
        shops: paths.find((p) => /sitemap\.shops\.xml$/.test(p)) ?? '/sitemap.shops.xml',
        items,
      };
    }, warnings, true);

  const idList = (kind: Kind, path: string, warnings: string[]): Promise<IdList> =>
    cached(
      `sitemap:${path}:v1`,
      async () => {
        const { ids, lastmod } = parseSitemapEntries(await fetchXml(path, kind === 'items'), kind);
        return { ids, lastmod };
      },
      warnings,
      true,
    );

  server.registerTool(
    'list_sitemap',
    {
      title: 'List sitemap ids',
      description:
        'Enumerate raw category, shop or product ids from the godpris.no sitemaps, paged by offset and limit. Use only to discover ids in bulk; item sitemaps are large and cached on disk for 24 hours.',
      inputSchema: {
        kind: z.enum(KINDS).describe('Which sitemap: categories, shops or items (products).'),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0).describe('Entries to skip.'),
        limit: z.coerce.number().int().min(1).max(1000).default(100).describe('Max entries to return (1-1000).'),
      },
      outputSchema: output,
      annotations: READ_ONLY,
    },
    handle('list_sitemap', async ({ kind, offset, limit }: { kind: Kind; offset: number; limit: number }) => {
      const warnings: string[] = [];
      const entries: Array<{ id: string; lastmod?: string }> = [];
      let total: number;
      let lowerBound = false;

      if (kind === 'items') {
        const files = (await sitemapFiles(warnings)).items;
        if (!files.length) throw new InputError('The sitemap index lists no item sitemaps.');
        const last = files[files.length - 1]!;
        let fetchedLast = false;
        let lastCount = 0;
        for (const f of files) {
          if (entries.length >= limit) break;
          const rel = offset + entries.length - f.start;
          if (rel >= ITEMS_PER_FILE) continue;
          const list = await idList('items', f.path, warnings);
          if (f === last) {
            fetchedLast = true;
            lastCount = list.ids.length;
          }
          for (let i = Math.max(0, rel); i < list.ids.length && entries.length < limit; i++) {
            entries.push({ id: list.ids[i]!, ...(list.lastmod[i] ? { lastmod: list.lastmod[i]! } : {}) });
          }
        }
        lowerBound = !fetchedLast;
        total = fetchedLast ? last.start + lastCount : Math.max(last.start, offset + entries.length);
        if (lowerBound) warnings.push(`total is a lower bound (${total}); the last items sitemap was not fetched`);
      } else {
        const idx = await sitemapFiles(warnings);
        const list = await idList(kind, idx[kind], warnings);
        total = list.ids.length;
        for (let i = offset; i < total && entries.length < limit; i++) {
          entries.push({ id: list.ids[i]!, ...(list.lastmod[i] ? { lastmod: list.lastmod[i]! } : {}) });
        }
      }

      const next = offset + entries.length;
      const hasMore = entries.length > 0 && (lowerBound || next < total);
      const rows = entries.map((e) => ({ id: e.id, url: siteUrl(`/${PATHS[kind]}/${e.id}`), ...(e.lastmod ? { lastmod: e.lastmod } : {}) }));
      const text = [
        `# Sitemap: ${kind} (${rows.length} entries from offset ${offset}, ${lowerBound ? 'at least ' : ''}${total} total)`,
        '',
        rows.length ? markdownTable(['ID', 'URL', 'Last modified'], rows.map((r) => [r.id, r.url, r.lastmod ?? ''])) : 'No entries at this offset.',
        hasMore ? `\nMore: call again with offset=${next}.` : '',
      ].join('\n');
      return finish(
        text,
        output,
        { kind, offset, limit, total, total_is_lower_bound: lowerBound, has_more: hasMore, ...(hasMore ? { next_offset: next } : {}), entries: rows },
        warnings,
      );
    }),
  );
};

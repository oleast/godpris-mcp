import { z } from 'zod';
import { formatKr, markdownTable } from '../format.js';
import { NotFoundError } from '../http/client.js';
import { parseProductPage, type ProductPage } from '../parsers/product.js';
import { getWatchlist, type WatchItem } from '../store/watchlist.js';
import type { Registration } from './index.js';
import { CoreDataMissingError, finish, handle, nowOf, productIdInput, productUrl, progress, warningsField } from './shared.js';

const MAX_CHECK = 30;

const LOCAL_NOTE =
  'Local watchlist stored on the server (no godpris.no account); it replaces godpris price alerts, which need a login.';

const itemSchema = z.object({
  product_id: z.string(),
  title: z.string(),
  url: z.string(),
  target_price: z.number().optional(),
  note: z.string().optional(),
  added_at: z.string(),
  last_checked_at: z.string().optional(),
  last_price: z.number().optional(),
  last_shop: z.string().optional(),
  lowest_seen: z.number().optional(),
  lowest_seen_at: z.string().optional(),
});

const addOutput = z.object({
  created: z.boolean(),
  item: itemSchema,
  target_hit: z.boolean().optional(),
  count: z.number(),
  ...warningsField,
});
const removeOutput = z.object({ product_id: z.string(), removed: z.boolean(), count: z.number(), ...warningsField });
const listOutput = z.object({ items: z.array(itemSchema), count: z.number(), ...warningsField });
const checkOutput = z.object({
  checked: z.number(),
  results: z.array(
    z.object({
      product_id: z.string(),
      title: z.string(),
      url: z.string(),
      price: z.number().optional(),
      shop: z.string().optional(),
      target_price: z.number().optional(),
      target_hit: z.boolean().optional(),
      new_low: z.boolean().optional(),
      lowest_seen: z.number().optional(),
      previous_price: z.number().optional(),
      change_abs: z.number().optional(),
      change_pct: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
  requests_used: z.number(),
  ...warningsField,
});

/** Lowest in-stock private-customer offer if there is one, otherwise the lowest offer. */
function currentPrice(p: ProductPage): { price: number; shop: string } {
  const offers = p.offers.length ? p.offers : [];
  const pool = (list: typeof offers) => list.filter((o) => !o.business_only);
  const base = pool(offers).length ? pool(offers) : offers;
  const stocked = base.filter((o) => o.in_stock);
  const best = (stocked.length ? stocked : base).reduce<(typeof offers)[number] | undefined>(
    (a, o) => (!a || o.price < a.price ? o : a),
    undefined,
  );
  if (best) return { price: best.price, shop: best.shop };
  if (p.lowest_price !== undefined) return { price: p.lowest_price, shop: p.lowest_shop ?? '' };
  throw new CoreDataMissingError('prices');
}

const hasShop = (s: string) => (s ? { last_shop: s } : {});

function itemText(i: WatchItem): string[] {
  return [
    `[${i.title}](${i.url}) (id ${i.product_id})`,
    i.last_price !== undefined ? formatKr(i.last_price) : '',
    i.target_price !== undefined ? formatKr(i.target_price) : '',
    i.lowest_seen !== undefined ? formatKr(i.lowest_seen) : '',
    i.last_checked_at ?? '',
    i.note ?? '',
  ];
}

export const registerWatchlistTools: Registration = (server, ctx) => {
  const store = () => getWatchlist(ctx);

  server.registerTool(
    'watchlist_add',
    {
      title: 'Add to watchlist',
      description: `Start watching a product, optionally with a target price and a note; adding an existing product updates it. ${LOCAL_NOTE}`,
      inputSchema: {
        product_id: productIdInput,
        target_price: z.coerce.number().int().min(1).max(10_000_000).optional().describe('Alert threshold in NOK: watchlist_check flags the product when its price is at or below this.'),
        note: z.string().max(500).optional().describe('Free-text note shown with the item.'),
      },
      outputSchema: addOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handle(
      'watchlist_add',
      async ({ product_id, target_price, note }: { product_id: string; target_price?: number | undefined; note?: string | undefined }) => {
        const warnings: string[] = [];
        const p = parseProductPage(await ctx.client.getHtml(`/produkt/${product_id}`, { notFoundOn500: true, noCache: true }));
        warnings.push(...p.warnings);
        if (!p.title) throw new CoreDataMissingError('product title');
        const cur = currentPrice(p);
        const nowIso = nowOf(ctx).toISOString();
        const url = p.url ?? productUrl(product_id);

        const { created, item, count } = await store().update((items) => {
          const prev = items.find((i) => i.product_id === product_id);
          const lowest = prev?.lowest_seen !== undefined ? Math.min(prev.lowest_seen, cur.price) : cur.price;
          const next: WatchItem = {
            ...prev,
            product_id,
            title: p.title,
            url,
            added_at: prev?.added_at ?? nowIso,
            last_checked_at: nowIso,
            last_price: cur.price,
            ...hasShop(cur.shop),
            lowest_seen: lowest,
            lowest_seen_at: prev?.lowest_seen !== undefined && prev.lowest_seen <= cur.price ? prev.lowest_seen_at ?? nowIso : nowIso,
          };
          if (target_price !== undefined) next.target_price = target_price;
          if (note !== undefined) next.note = note;
          if (prev) items[items.indexOf(prev)] = next;
          else items.push(next);
          return { created: !prev, item: next, count: items.length };
        }, warnings);

        const hit = item.target_price !== undefined ? cur.price <= item.target_price : undefined;
        const text = [
          `${created ? 'Added' : 'Updated'} [${item.title}](${item.url}) on the watchlist.`,
          `Current lowest price: ${formatKr(cur.price)}${cur.shop ? ` at ${cur.shop}` : ''}.`,
          item.target_price !== undefined ? `Target: ${formatKr(item.target_price)}${hit ? ' (already reached)' : ''}.` : '',
          `Watchlist now has ${count} item${count === 1 ? '' : 's'}.`,
        ]
          .filter(Boolean)
          .join('\n');
        return finish(text, addOutput, { created, item, ...(hit !== undefined ? { target_hit: hit } : {}), count }, warnings);
      },
    ),
  );

  server.registerTool(
    'watchlist_remove',
    {
      title: 'Remove from watchlist',
      description: `Stop watching a product. ${LOCAL_NOTE}`,
      inputSchema: { product_id: productIdInput },
      outputSchema: removeOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('watchlist_remove', async ({ product_id }: { product_id: string }) => {
      const warnings: string[] = [];
      const { removed, count } = await store().update((items) => {
        const idx = items.findIndex((i) => i.product_id === product_id);
        if (idx >= 0) items.splice(idx, 1);
        return { removed: idx >= 0, count: items.length };
      }, warnings);
      return finish(
        removed ? `Removed product ${product_id} from the watchlist (${count} left).` : `Product ${product_id} was not on the watchlist.`,
        removeOutput,
        { product_id, removed, count },
        warnings,
      );
    }),
  );

  server.registerTool(
    'watchlist_list',
    {
      title: 'List watchlist',
      description: `Show every watched product with target price, last checked price and lowest seen; makes no network requests. ${LOCAL_NOTE}`,
      inputSchema: {},
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle('watchlist_list', async () => {
      const warnings: string[] = [];
      const items = await store().list(warnings);
      const text = items.length
        ? ['# Watchlist', '', markdownTable(['Product', 'Last price', 'Target', 'Lowest seen', 'Last checked', 'Note'], items.map(itemText))].join('\n')
        : 'The watchlist is empty. Use watchlist_add to start watching a product.';
      return finish(text, listOutput, { items, count: items.length }, warnings);
    }),
  );

  server.registerTool(
    'watchlist_check',
    {
      title: 'Check watchlist prices',
      description: `Fetch the current lowest price for each watched product (one request per item, at most ${MAX_CHECK}) and report target hits, new lows and changes since the last check. ${LOCAL_NOTE}`,
      inputSchema: {
        product_ids: z.array(productIdInput).max(MAX_CHECK).optional().describe('Only check these watched products (default: all, least recently checked first).'),
      },
      outputSchema: checkOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle('watchlist_check', async ({ product_ids }: { product_ids?: string[] | undefined }, extra) => {
      const warnings: string[] = [];
      const client = ctx.client.withCounter();
      const all = await store().list(warnings);
      const wanted = product_ids?.length ? new Set(product_ids) : undefined;
      let targets = wanted ? all.filter((i) => wanted.has(i.product_id)) : [...all];
      if (wanted) {
        for (const id of wanted) if (!all.some((i) => i.product_id === id)) warnings.push(`product ${id} is not on the watchlist`);
      }
      targets.sort((a, b) => (a.last_checked_at ?? '').localeCompare(b.last_checked_at ?? ''));
      if (targets.length > MAX_CHECK) {
        warnings.push(`only the ${MAX_CHECK} least recently checked of ${targets.length} items were checked; call again for the rest`);
        targets = targets.slice(0, MAX_CHECK);
      }

      type Result = z.infer<typeof checkOutput>['results'][number];
      const results: Result[] = [];
      const updates = new Map<string, { price: number; shop: string; title: string }>();
      for (const [n, it] of targets.entries()) {
        const base: Result = {
          product_id: it.product_id,
          title: it.title,
          url: it.url,
          ...(it.target_price !== undefined ? { target_price: it.target_price } : {}),
        };
        try {
          const p = parseProductPage(await client.getHtml(`/produkt/${it.product_id}`, { notFoundOn500: true, noCache: true }));
          const cur = currentPrice(p);
          updates.set(it.product_id, { ...cur, title: p.title || it.title });
          const prev = it.last_price;
          results.push({
            ...base,
            title: p.title || it.title,
            price: cur.price,
            ...(cur.shop ? { shop: cur.shop } : {}),
            ...(it.target_price !== undefined ? { target_hit: cur.price <= it.target_price } : {}),
            new_low: it.lowest_seen !== undefined && cur.price < it.lowest_seen,
            lowest_seen: Math.min(it.lowest_seen ?? cur.price, cur.price),
            ...(prev !== undefined
              ? {
                  previous_price: prev,
                  change_abs: cur.price - prev,
                  change_pct: prev ? Math.round(((cur.price - prev) / prev) * 1000) / 10 : 0,
                }
              : {}),
          });
        } catch (err) {
          const msg =
            err instanceof NotFoundError
              ? 'product not found on godpris.no (it may have been removed)'
              : err instanceof CoreDataMissingError
                ? 'no price found on the product page'
                : `check failed: ${err instanceof Error ? err.message : String(err)}`;
          results.push({ ...base, error: msg });
        }
        progress(extra, n + 1, targets.length, `checked ${n + 1}/${targets.length}`);
      }

      const nowIso = nowOf(ctx).toISOString();
      if (updates.size) {
        await store().update((items) => {
          for (const it of items) {
            const u = updates.get(it.product_id);
            if (!u) continue;
            it.title = u.title;
            it.last_checked_at = nowIso;
            it.last_price = u.price;
            if (u.shop) it.last_shop = u.shop;
            if (it.lowest_seen === undefined || u.price < it.lowest_seen) {
              it.lowest_seen = u.price;
              it.lowest_seen_at = nowIso;
            }
          }
        }, warnings);
      }

      const L: string[] = [`# Watchlist check (${results.length} item${results.length === 1 ? '' : 's'}, ${client.requests} request${client.requests === 1 ? '' : 's'})`, ''];
      if (!results.length) L.push('Nothing to check. Use watchlist_add first.');
      else {
        L.push(
          markdownTable(
            ['Product', 'Price', 'Shop', 'Change', 'Target', 'Flags'],
            results.map((r) => [
              `[${r.title}](${r.url}) (id ${r.product_id})`,
              r.price !== undefined ? formatKr(r.price) : '',
              r.shop ?? '',
              r.change_abs !== undefined ? `${r.change_abs > 0 ? '+' : ''}${r.change_abs} kr (${r.change_pct && r.change_pct > 0 ? '+' : ''}${r.change_pct} %)` : '',
              r.target_price !== undefined ? formatKr(r.target_price) : '',
              r.error ?? [r.target_hit ? 'TARGET HIT' : '', r.new_low ? 'NEW LOW' : ''].filter(Boolean).join(', '),
            ]),
          ),
        );
      }
      return finish(L.join('\n'), checkOutput, { checked: results.length, results, requests_used: client.requests }, warnings);
    }),
  );
};

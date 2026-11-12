import type { DiskCache } from '../http/cache.js';
import { matchScore } from '../match/normalize.js';
import type { CategoryPage } from '../parsers/category.js';
import type { ToolContext } from '../tools/index.js';
import { getDisk } from '../tools/shared.js';

export interface IndexedCategory {
  id: string;
  name: string;
  parent_id?: string;
  /** Names root to self. */
  path?: string[];
  seen: number;
}

const KEY = 'category-index:v1';
const TTL = 365 * 24 * 3600 * 1000;
const MIN_SCORE = 0.6;

/** Disk-backed index of categories the server has seen; feeds find_category. */
export class CategoryIndex {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly disk: DiskCache,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<Record<string, IndexedCategory>> {
    return (await this.disk.get<Record<string, IndexedCategory>>(KEY, TTL)) ?? {};
  }

  /** Merge entries into the index; only non-empty fields overwrite. Serialized in-process. */
  record(entries: Array<Omit<IndexedCategory, 'seen'>>): Promise<void> {
    const run = async (): Promise<void> => {
      const all = await this.load();
      const seen = this.now();
      for (const e of entries) {
        if (!e.id || !e.name) continue;
        const prev = all[e.id];
        const next: IndexedCategory = { ...prev, id: e.id, name: e.name, seen };
        if (e.parent_id) next.parent_id = e.parent_id;
        if (e.path?.length) next.path = e.path;
        all[e.id] = next;
      }
      await this.disk.set(KEY, all);
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async search(query: string, limit: number): Promise<Array<IndexedCategory & { score: number }>> {
    const all = await this.load();
    return Object.values(all)
      .map((c) => ({ ...c, score: matchScore(query, c.name) }))
      .filter((c) => c.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
}

const indexes = new Map<string, CategoryIndex>();

export function getCategoryIndex(ctx: ToolContext): CategoryIndex {
  const key = ctx.config.dataDir;
  let idx = indexes.get(key);
  if (!idx) {
    idx = new CategoryIndex(getDisk(ctx));
    indexes.set(key, idx);
  }
  return idx;
}

/** Best-effort: record a parsed category page (breadcrumbs + subcategories) into the index. */
export async function recordCategoryPage(ctx: ToolContext, page: CategoryPage): Promise<void> {
  try {
    const entries: Array<Omit<IndexedCategory, 'seen'>> = [];
    const crumbNames: string[] = [];
    let prev: string | undefined;
    for (const c of page.breadcrumbs) {
      crumbNames.push(c.name);
      entries.push({ id: c.id, name: c.name, ...(prev ? { parent_id: prev } : {}), path: [...crumbNames] });
      prev = c.id;
    }
    const last = page.breadcrumbs[page.breadcrumbs.length - 1];
    let pagePath = crumbNames;
    if (page.id && page.name) {
      pagePath = last?.id === page.id ? crumbNames : [...crumbNames, page.name];
      if (last?.id !== page.id) {
        entries.push({ id: page.id, name: page.name, ...(last ? { parent_id: last.id } : {}), path: pagePath });
      }
    }
    if (page.id) {
      for (const s of page.subcategories) {
        entries.push({ id: s.id, name: s.name, parent_id: page.id, path: [...pagePath, s.name] });
      }
    }
    if (entries.length) await getCategoryIndex(ctx).record(entries);
  } catch {
    /* best effort */
  }
}

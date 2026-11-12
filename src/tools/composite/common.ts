import { z } from 'zod';
import { NotFoundError, UpstreamError, type HttpClient } from '../../http/client.js';
import { fuzzyScore } from '../../match/normalize.js';
import { parseAutocomplete } from '../../parsers/autocomplete.js';
import { getCategoryIndex } from '../../store/category-index.js';
import { VERDICTS, type HistoryAnalysis } from '../history.js';
import type { ToolContext } from '../index.js';
import { CoreDataMissingError, InputError } from '../shared.js';

export { progress } from '../shared.js';

export const requestsUsedField = { requests_used: z.number() };

export const maxPagesInput = (def: number, max: number) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .default(def)
    .describe(`Max listing pages to fetch (1-${max}, default ${def}); also capped by the server (GODPRIS_MAX_PAGES).`);

export function capPages(requested: number, ctx: ToolContext, warnings: string[]): number {
  const pages = Math.min(requested, ctx.config.maxPages);
  if (pages < requested) warnings.push(`max_pages capped at ${pages} (GODPRIS_MAX_PAGES)`);
  return pages;
}

export const historyBriefSchema = z.object({
  today_price: z.number().optional(),
  today_date: z.string().optional(),
  low_90d: z.number().optional(),
  high_90d: z.number().optional(),
  low_all_time: z.number().optional(),
  percentile_90d: z.number().optional(),
  verdict: z.enum(VERDICTS),
  verdict_label: z.string().optional(),
  verdict_source: z.enum(['site', 'computed']),
});
export type HistoryBrief = z.infer<typeof historyBriefSchema>;

export function toHistoryBrief(a: HistoryAnalysis): HistoryBrief {
  const s = a.stats;
  return {
    ...(s.today ? { today_price: s.today.price, today_date: s.today.date } : {}),
    ...(s.low_90d !== undefined ? { low_90d: s.low_90d } : {}),
    ...(s.high_90d !== undefined ? { high_90d: s.high_90d } : {}),
    ...(s.low_all_time !== undefined ? { low_all_time: s.low_all_time } : {}),
    ...(s.percentile_90d !== undefined ? { percentile_90d: s.percentile_90d } : {}),
    verdict: a.verdict.verdict,
    ...(a.verdict.label ? { verdict_label: a.verdict.label } : {}),
    verdict_source: a.verdict.source,
  };
}

export interface ResolvedCategory {
  id: string;
  name: string;
  source: 'input' | 'autocomplete' | 'visited';
  candidates: Array<{ id: string; name: string; product_count?: number }>;
}

export async function resolveCategory(
  ctx: ToolContext,
  http: HttpClient,
  query: string,
  warnings: string[],
): Promise<ResolvedCategory> {
  const ac = parseAutocomplete(await http.getJson('/api/product/search', { query: { q: query, t: '' } }));
  warnings.push(...ac.warnings);
  try {
    await getCategoryIndex(ctx).record(ac.categories.map((c) => ({ id: c.id, name: c.name })));
  } catch {
    /* best effort */
  }

  if (ac.categories.length) {
    let cands = ac.categories.filter((c) => c.match !== 'brand');
    if (!cands.length) {
      cands = ac.categories;
      warnings.push('category guessed from a brand match');
    }
    const candidates = cands.slice(0, 5).map((c) => {
      const count = c.product_count ?? c.total;
      return { id: c.id, name: c.name, ...(count !== undefined ? { product_count: count } : {}) };
    });
    let pick = cands[0];
    let bestScore = -1;
    for (const c of cands) {
      const s = fuzzyScore(query, c.name);
      if (s > bestScore) {
        bestScore = s;
        pick = c;
      }
    }
    if (bestScore < 0.75) {
      pick = cands[0];
      warnings.push(
        `Picked category "${pick?.name}" (id ${pick?.id}) for "${query}"; pass category_id to choose another (candidates: ${candidates.map((c) => `${c.name} (${c.id})`).join(', ')})`,
      );
    }
    if (pick) return { id: pick.id, name: pick.name, source: 'autocomplete', candidates };
  }

  let visited: Awaited<ReturnType<ReturnType<typeof getCategoryIndex>['search']>> = [];
  try {
    visited = await getCategoryIndex(ctx).search(query, 3);
  } catch {
    /* best effort */
  }
  const v = visited[0];
  if (v) return { id: v.id, name: v.name, source: 'visited', candidates: [{ id: v.id, name: v.name }] };
  throw new InputError(`No category found for "${query}"; call find_category and pass category_id.`);
}

export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** Page 1 errors rethrow; later pages degrade to a warning (listing ended or temporarily broken). */
export function walkError(err: unknown, page: number, warnings: string[], firstPage = 1): void {
  if (page <= firstPage) throw err;
  if (err instanceof NotFoundError) {
    warnings.push(`listing ended at page ${page} (not found)`);
    return;
  }
  if (err instanceof CoreDataMissingError || err instanceof UpstreamError) {
    warnings.push(`stopped at page ${page}: ${err.message}`);
    return;
  }
  throw err;
}

/** Stable re-sort of compact rows by a site sort key; `popularity` keeps the site order. */
export function sortRows<T extends { price?: number; discount_pct?: number; rating?: { value: number; max: number } }>(
  rows: T[],
  sort: string,
): T[] {
  const indexed = rows.map((r, i) => ({ r, i }));
  const cmpNum = (a: number | undefined, b: number | undefined, dir: 1 | -1): number => {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return (a - b) * dir;
  };
  const rating = (r: T): number | undefined => (r.rating && r.rating.max ? r.rating.value / r.rating.max : undefined);
  indexed.sort((x, y) => {
    let c = 0;
    if (sort === 'price_asc') c = cmpNum(x.r.price, y.r.price, 1);
    else if (sort === 'price_desc') c = cmpNum(x.r.price, y.r.price, -1);
    else if (sort === 'discount_desc') c = (y.r.discount_pct ?? 0) - (x.r.discount_pct ?? 0);
    else if (sort === 'rating_avg_desc') c = cmpNum(rating(x.r), rating(y.r), -1);
    return c || x.i - y.i;
  });
  return indexed.map((x) => x.r);
}

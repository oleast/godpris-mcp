import { z } from 'zod';
import { formatKr, markdownTable, truncate } from '../../format.js';
import { fetchCompare } from '../compare.js';
import type { ComparePage } from '../../parsers/compare.js';
import { BASE_URL } from '../../parsers/util.js';
import { fetchCategoryListing } from '../categories.js';
import { fetchHistoryAnalysis } from '../history.js';
import type { Registration } from '../index.js';
import {
  categoryIdInput,
  compactRowSchema,
  finish,
  handle,
  InputError,
  priceMaxInput,
  READ_ONLY,
  toCompactRow,
  warningsField,
  type CompactRow,
} from '../shared.js';
import {
  dedupeById,
  historyBriefSchema,
  requestsUsedField,
  resolveCategory,
  toHistoryBrief,
  progress,
  type HistoryBrief,
  type ResolvedCategory,
} from './common.js';

const productRow = compactRowSchema.extend({ rank: z.number(), history: historyBriefSchema.optional() });

const bestOutput = z.object({
  category_id: z.string(),
  category_name: z.string().optional(),
  sort: z.string(),
  url: z.string(),
  compare_url: z.string().optional(),
  products: z.array(productRow),
  spec_differences: z.array(z.object({ group: z.string().optional(), name: z.string(), values: z.array(z.string()) })),
  spec_rows_total: z.number(),
  ...requestsUsedField,
  ...warningsField,
});

const MAX_SPEC_ROWS = 40;

/** Spec rows that differ between the given products, with values re-ordered to match `ids`. */
export function specDifferences(
  page: ComparePage,
  ids: string[],
): { rows: Array<{ group?: string; name: string; values: string[] }>; total_rows: number; missing_ids: string[] } {
  const index = new Map(page.products.map((p, i) => [p.id, i]));
  const missing_ids = ids.filter((id) => !index.has(id));
  if (missing_ids.length === ids.length) return { rows: [], total_rows: page.rows.length, missing_ids };
  const rows = page.rows
    .map((r) => ({
      ...(r.group ? { group: r.group } : {}),
      name: r.name,
      values: ids.map((id) => {
        const i = index.get(id);
        return i === undefined ? '' : (r.values[i] ?? '');
      }),
    }))
    .filter((r) => new Set(r.values.map((v) => v.trim())).size > 1);
  return { rows, total_rows: page.rows.length, missing_ids };
}

export const registerCompareBestOptions: Registration = (server, ctx) => {
  server.registerTool(
    'compare_best_options',
    {
      title: 'Compare best options',
      description:
        "Pick the top products in a category (by popularity or expert rating), compare their specs side by side and summarise each one's price history. Give a category_id, or a query to find the category.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).optional().describe('Category search words, e.g. "vaskemaskin"; used when category_id is not given.'),
        category_id: categoryIdInput.optional(),
        top_n: z.coerce.number().int().min(2).max(6).default(4).describe('How many top products to compare (2-6).'),
        sort: z.enum(['popularity', 'rating_avg_desc']).default('popularity').describe('How to pick the top products.'),
        max_price: priceMaxInput,
        include_history: z.boolean().default(true).describe('Add a price-history summary per product (2 requests each).'),
      },
      outputSchema: bestOutput,
      annotations: READ_ONLY,
    },
    handle(
      'compare_best_options',
      async (
        args: {
          query?: string | undefined;
          category_id?: string | undefined;
          top_n: number;
          sort: 'popularity' | 'rating_avg_desc';
          max_price?: number | undefined;
          include_history: boolean;
        },
        extra,
      ) => {
        const { query, sort, max_price } = args;
        if (!args.category_id && !query) throw new InputError('Give category_id or query.');
        const http = ctx.client.withCounter();
        const warnings: string[] = [];
        let cat: ResolvedCategory;
        if (args.category_id) {
          if (query) warnings.push('query ignored because category_id was given');
          cat = { id: args.category_id, name: '', source: 'input', candidates: [] };
        } else {
          cat = await resolveCategory(ctx, http, query as string, warnings);
        }

        const listing = await fetchCategoryListing(
          ctx,
          http,
          { category_id: cat.id, sort, price_max: max_price, page: 1 },
          warnings,
          { validate: false },
        );
        const categoryName = cat.name || listing.category_name;
        const picks: CompactRow[] = dedupeById(listing.items.map(toCompactRow))
          .filter((r) => r.price !== undefined && (max_price === undefined || r.price <= max_price))
          .slice(0, args.top_n);
        const ids = picks.map((p) => p.id);

        let page: ComparePage | undefined;
        let compare_url: string | undefined;
        let diff: ReturnType<typeof specDifferences> = { rows: [], total_rows: 0, missing_ids: [] };
        if (picks.length < 2) {
          warnings.push('Not enough products to compare');
        } else {
          compare_url = `${BASE_URL}/sammenlign?ids=${ids.join(',')}`;
          try {
            page = await fetchCompare(http, ids);
            progress(extra, 1, 1, 'compared');
          } catch {
            warnings.push('spec comparison unavailable');
          }
          if (page) {
            warnings.push(...page.warnings);
            diff = specDifferences(page, ids);
            if (diff.missing_ids.length === ids.length) {
              warnings.push(`compare page returned other products (${page.products.map((p) => p.id).join(', ')}); spec differences skipped`);
            } else if (diff.missing_ids.length) {
              warnings.push(`Not found on the compare page: ${diff.missing_ids.join(', ')}`);
            }
          }
        }

        const histories = new Map<string, HistoryBrief>();
        if (args.include_history) {
          for (const [n, pick] of picks.entries()) {
            try {
              histories.set(pick.id, toHistoryBrief(await fetchHistoryAnalysis(ctx, http, pick.id)));
            } catch {
              warnings.push(`${pick.id}: price history unavailable`);
            }
            progress(extra, n + 1, picks.length, `history ${n + 1}/${picks.length}`);
          }
        }
        const products = picks.map((p, i) => ({ ...p, rank: i + 1, ...(histories.has(p.id) ? { history: histories.get(p.id) } : {}) }));

        const name = categoryName || `category ${cat.id}`;
        const L: string[] = [`# Best ${name} by ${sort === 'popularity' ? 'popularity' : 'expert rating'} (top ${picks.length})`, listing.url, ''];
        L.push(
          markdownTable(
            ['#', 'Product', 'Price', 'Rating', 'Verdict', '90d low', 'All-time low'],
            products.map((r) => [
              r.rank,
              `[${[r.brand, r.title].filter(Boolean).join(' ')}](${r.url})`,
              r.price !== undefined ? formatKr(r.price) : '',
              r.rating ? `${r.rating.value}/${r.rating.max} (${r.rating.source})` : '',
              r.history ? (r.history.verdict_label ?? r.history.verdict) : '',
              r.history?.low_90d !== undefined ? formatKr(r.history.low_90d) : '',
              r.history?.low_all_time !== undefined ? formatKr(r.history.low_all_time) : '',
            ]),
          ),
        );
        if (page && diff.rows.length) {
          const shown = diff.rows.slice(0, MAX_SPEC_ROWS);
          L.push(
            '',
            `## Spec differences (${diff.rows.length} of ${diff.total_rows} rows)`,
            markdownTable(
              ['Spec', ...picks.map((p) => truncate([p.brand, p.title].filter(Boolean).join(' '), 30))],
              shown.map((r) => [r.group ? `${r.group}: ${r.name}` : r.name, ...r.values.map((v) => v || '–')]),
            ),
          );
          if (diff.rows.length > shown.length) L.push(`+${diff.rows.length - shown.length} more rows`);
        }
        if (compare_url) L.push('', `Compare on godpris.no: ${compare_url}`);
        L.push(`Requests used: ${http.requests}`, 'Next: evaluate_purchase <id> for the one you like.');

        return finish(
          L.join('\n'),
          bestOutput,
          {
            category_id: cat.id,
            ...(categoryName ? { category_name: categoryName } : {}),
            sort,
            url: listing.url,
            ...(compare_url ? { compare_url } : {}),
            products,
            spec_differences: diff.rows,
            spec_rows_total: diff.total_rows,
            requests_used: http.requests,
          },
          warnings,
        );
      },
      ({ category_id }) => (category_id ? `Category ${category_id} not found` : 'Category not found'),
    ),
  );
};

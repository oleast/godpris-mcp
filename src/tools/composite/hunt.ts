import { z } from 'zod';
import { assessDeal, ASSESSMENT_RANK, type DealAssessment } from '../../analysis/verdicts.js';
import { formatKr, markdownTable } from '../../format.js';
import { NotFoundError, type HttpClient } from '../../http/client.js';
import { parseListingMeta, parseProductTiles, type ListingItem, type ListingMeta } from '../../parsers/tiles.js';
import { fetchCategoryListing } from '../categories.js';
import { fetchHistoryAnalysis } from '../history.js';
import type { Registration } from '../index.js';
import { fetchSearchListing } from '../search.js';
import {
  buildListingQuery,
  categoryIdInput,
  compactRowSchema,
  CoreDataMissingError,
  finish,
  handle,
  InputError,
  listingTable,
  priceMaxInput,
  READ_ONLY,
  recordLowInput,
  siteUrl,
  toCompactRow,
  warningsField,
  type CompactRow,
} from '../shared.js';
import { capPages, historyBriefSchema, maxPagesInput, progress, requestsUsedField, toHistoryBrief, walkError } from './common.js';

const DEALS_PAGE_SIZE = 48;

const huntRowSchema = compactRowSchema.extend({
  shop: z.string().optional(),
  assessment: z.enum(['all_time_low', 'genuine', 'modest', 'inflated', 'unverified']).optional(),
  inflated_discount: z.boolean().optional(),
  implied_before_price: z.number().optional(),
  real_discount_pct: z.number().optional(),
  median_90d: z.number().optional(),
  history: historyBriefSchema.optional(),
  reasons: z.array(z.string()).optional(),
  note: z.string().optional(),
});
type HuntRow = z.infer<typeof huntRowSchema>;

const huntOutput = z.object({
  mode: z.enum(['deals', 'search', 'category']),
  query: z.string().optional(),
  category_ids: z.array(z.string()).optional(),
  discount_min: z.number(),
  sort: z.string(),
  sources: z.array(z.object({ url: z.string(), pages: z.number() })),
  pages_scanned: z.number(),
  candidates_found: z.number(),
  verified: z.number(),
  has_more: z.boolean(),
  items: z.array(huntRowSchema),
  ...requestsUsedField,
  ...warningsField,
});

interface Page {
  items: ListingItem[];
  meta: ListingMeta;
  url: string;
}

async function fetchDealsPage(
  http: HttpClient,
  args: { sort: string; price_max?: number | undefined; discount_min: number; record_low_only?: boolean | undefined },
  page: number,
  warnings: string[],
): Promise<Page> {
  const q = buildListingQuery(args, warnings);
  const reqQuery = page > 1 ? { ...q, o: (page - 1) * DEALS_PAGE_SIZE, l: DEALS_PAGE_SIZE, fragment: 1 } : q;
  const html = await http.getHtml('/tilbud', { query: reqQuery });
  const tiles = parseProductTiles(html);
  const meta = parseListingMeta(html);
  warnings.push(...tiles.warnings);
  if (!tiles.items.length && meta.total && meta.total > 0) throw new CoreDataMissingError('listing rows');
  return { items: tiles.items, meta, url: siteUrl('/tilbud', q) };
}

interface Source {
  label: string;
  fetchPage: (page: number) => Promise<Page>;
  next: number;
  fetched: number;
  done: boolean;
  more: boolean;
  failed: boolean;
  url?: string;
}

const better = (a: HuntRow, b: HuntRow): boolean => {
  const da = a.discount_pct ?? 0;
  const db = b.discount_pct ?? 0;
  if (da !== db) return da > db;
  return (a.price ?? Infinity) < (b.price ?? Infinity);
};

export const registerHuntDeals: Registration = (server, ctx) => {
  server.registerTool(
    'hunt_deals',
    {
      title: 'Hunt deals',
      description:
        "Find the best current discounts across godpris.no, in one or more categories, or for a search query, then check the price history of the top candidates to separate genuine lows from inflated 'before' prices. Give either query or category_ids (or neither for all deals).",
      inputSchema: {
        query: z.string().trim().min(1).max(200).optional().describe('Search words; omit to scan all deals or categories.'),
        category_ids: z.array(categoryIdInput).min(1).max(5).optional().describe('Category ids to scan instead of all deals.'),
        discount_min: z.coerce.number().int().min(1).max(95).default(20).describe('Minimum discount in percent.'),
        max_price: priceMaxInput,
        record_low_only: recordLowInput,
        sort: z
          .enum(['discount_desc', 'popularity'])
          .default('discount_desc')
          .describe('How the site orders candidates before verification.'),
        max_pages: maxPagesInput(5, 20),
        verify_history_top: z.coerce
          .number()
          .int()
          .min(0)
          .max(10)
          .default(5)
          .describe('How many top candidates to check against price history (2 requests each).'),
        limit: z.coerce.number().int().min(1).max(100).default(30).describe('Max deals returned.'),
      },
      outputSchema: huntOutput,
      annotations: READ_ONLY,
    },
    handle(
      'hunt_deals',
      async (
        args: {
          query?: string | undefined;
          category_ids?: string[] | undefined;
          discount_min: number;
          max_price?: number | undefined;
          record_low_only?: boolean | undefined;
          sort: 'discount_desc' | 'popularity';
          max_pages: number;
          verify_history_top: number;
          limit: number;
        },
        extra,
      ) => {
        const { query, category_ids, discount_min, max_price, record_low_only, sort, limit } = args;
        if (query && category_ids?.length) {
          throw new InputError('Pass either query or category_ids, not both (or neither for all deals).');
        }
        const http = ctx.client.withCounter();
        const warnings: string[] = [];
        const mode = query ? 'search' : category_ids?.length ? 'category' : 'deals';
        const pages = capPages(args.max_pages, ctx, warnings);

        const sources: Source[] = [];
        const mk = (label: string, fetchPage: (page: number) => Promise<Page>): void => {
          sources.push({ label, fetchPage, next: 1, fetched: 0, done: false, more: false, failed: false });
        };
        if (mode === 'search') {
          mk(`search ${query}`, (page) =>
            fetchSearchListing(http, { query: query as string, sort, price_max: max_price, record_low_only, page }, warnings),
          );
        } else if (mode === 'category') {
          for (const id of category_ids ?? []) {
            mk(id, async (page) => {
              const l = await fetchCategoryListing(
                ctx,
                http,
                { category_id: id, sort, price_max: max_price, discount_min, record_low_only, page },
                warnings,
                { validate: false },
              );
              return { items: l.items, meta: l.meta, url: l.url };
            });
          }
        } else {
          mk('deals', (page) => fetchDealsPage(http, { sort, price_max: max_price, discount_min, record_low_only }, page, warnings));
        }

        const verifyN = args.verify_history_top;
        const total = pages + verifyN * 2;
        let used = 0;
        let firstErr: unknown;
        const rows: HuntRow[] = [];
        while (used < pages && sources.some((s) => !s.done)) {
          for (const src of sources) {
            if (src.done || used >= pages) continue;
            const pageNo = src.next;
            let res: Page;
            try {
              res = await src.fetchPage(pageNo);
            } catch (err) {
              used++;
              if (pageNo === 1) {
                if (mode === 'category' && err instanceof NotFoundError) {
                  warnings.push(`Category ${src.label} not found`);
                  src.done = true;
                  src.failed = true;
                  firstErr ??= err;
                  continue;
                }
                throw err;
              }
              walkError(err, pageNo, warnings);
              src.done = true;
              src.more = false;
              continue;
            }
            used++;
            src.next++;
            src.fetched++;
            if (pageNo === 1) src.url = res.url;
            src.more = res.meta.has_next;
            for (const it of res.items) rows.push({ ...toCompactRow(it), ...(it.offer_shop ? { shop: it.offer_shop } : {}) });
            progress(extra, used, total, `page ${used}`);
            const worse = sort === 'discount_desc' && res.items.some((it) => (it.discount_pct ?? 0) < discount_min);
            if (worse) src.more = false;
            if (!res.meta.has_next || !res.items.length || worse) src.done = true;
          }
        }
        if (sources.length && sources.every((s) => s.failed)) throw firstErr;

        // candidates: dedupe (best discount wins), filter, pre-rank
        const byId = new Map<string, HuntRow>();
        for (const r of rows) {
          const prev = byId.get(r.id);
          if (!prev) {
            byId.set(r.id, r);
            continue;
          }
          const winner = better(r, prev) ? r : prev;
          byId.set(r.id, { ...winner, ...(r.record_low || prev.record_low ? { record_low: true } : {}) });
        }
        let candidates = [...byId.values()].filter(
          (r) => r.price !== undefined && (r.discount_pct ?? 0) >= discount_min && (max_price === undefined || r.price <= max_price),
        );
        if (sort === 'discount_desc') {
          const idx = new Map(candidates.map((r, i) => [r.id, i]));
          candidates = [...candidates].sort(
            (a, b) =>
              (b.discount_pct ?? 0) - (a.discount_pct ?? 0) ||
              Number(!!b.record_low) - Number(!!a.record_low) ||
              (b.shop_count ?? 0) - (a.shop_count ?? 0) ||
              (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0),
          );
        }
        const candidatesFound = candidates.length;
        const pagesScanned = sources.reduce((n, x) => n + x.fetched, 0);

        // verify the top candidates, sequentially
        const toVerify = candidates.slice(0, Math.min(verifyN, candidates.length));
        const verifiedRows: HuntRow[] = [];
        for (const row of toVerify) {
          try {
            const a = await fetchHistoryAnalysis(ctx, http, row.id);
            warnings.push(...a.warnings.map((w) => `${row.id}: ${w}`));
            const check = assessDeal({
              ...(row.price !== undefined ? { price: row.price } : {}),
              ...(row.discount_pct !== undefined ? { discount_pct: row.discount_pct } : {}),
              points: a.points,
              stats: a.stats,
              verdict: a.verdict.verdict,
            });
            verifiedRows.push({
              ...row,
              assessment: check.assessment,
              inflated_discount: check.inflated_discount,
              ...(check.implied_before_price !== undefined ? { implied_before_price: check.implied_before_price } : {}),
              ...(check.real_discount_pct !== undefined ? { real_discount_pct: check.real_discount_pct } : {}),
              ...(check.median_90d !== undefined ? { median_90d: check.median_90d } : {}),
              history: toHistoryBrief(a),
              reasons: check.reasons,
              ...(a.points.length === 0 ? { note: 'no price history' } : {}),
            });
          } catch (err) {
            verifiedRows.push({
              ...row,
              assessment: 'unverified',
              inflated_discount: false,
              note: err instanceof NotFoundError ? 'no price history' : 'history unavailable',
            });
          }
          progress(extra, used + verifiedRows.length * 2, total, `history ${verifiedRows.length}/${toVerify.length}`);
        }
        verifiedRows.sort(
          (a, b) =>
            ASSESSMENT_RANK[a.assessment as DealAssessment] - ASSESSMENT_RANK[b.assessment as DealAssessment] ||
            (b.real_discount_pct ?? -Infinity) - (a.real_discount_pct ?? -Infinity) ||
            (b.discount_pct ?? 0) - (a.discount_pct ?? 0),
        );
        const verifiedIds = new Set(verifiedRows.map((r) => r.id));
        const rest = candidates.filter((r) => !verifiedIds.has(r.id));
        const items = [...verifiedRows, ...rest].slice(0, limit);
        const shownVerified = items.filter((r) => r.assessment !== undefined);
        const shownRest = items.filter((r) => r.assessment === undefined);
        const has_more = sources.some((s) => !s.failed && s.more);

        const title =
          mode === 'search' ? `"${query}"` : mode === 'category' ? `categories ${(category_ids ?? []).join(', ')}` : 'all deals';
        const L: string[] = [
          `# Deal hunt: ${title} (discount ≥ ${discount_min} %)`,
          `Scanned ${pagesScanned} page${pagesScanned === 1 ? '' : 's'} · ${candidatesFound} candidates · ${verifiedRows.length ? `verified the top ${verifiedRows.length} against price history` : 'no history verification'} · Requests used: ${http.requests}`,
        ];
        if (shownVerified.length) {
          const pct = (n: number | undefined): string => (n !== undefined ? `${n} %` : '');
          L.push(
            '',
            '## Verified',
            markdownTable(
              ['ID', 'Product', 'Price', 'Shop', 'Claimed', 'Real vs 90d median', '90d low', 'All-time low', 'Verdict', 'Assessment'],
              shownVerified.map((r) => [
                r.id,
                `[${[r.brand, r.title].filter(Boolean).join(' ')}](${r.url})`,
                r.price !== undefined ? formatKr(r.price) : '',
                r.shop ?? '',
                pct(r.discount_pct),
                pct(r.real_discount_pct),
                r.history?.low_90d !== undefined ? formatKr(r.history.low_90d) : '',
                r.history?.low_all_time !== undefined ? formatKr(r.history.low_all_time) : '',
                r.history ? (r.history.verdict_label ?? r.history.verdict) : '',
                `${r.assessment}${r.inflated_discount ? ' ⚠ inflated before-price' : ''}${r.note ? ` (${r.note})` : ''}`,
              ]),
            ),
          );
        }
        if (shownRest.length) {
          L.push('', shownVerified.length ? '## More candidates (not verified)' : '## Candidates (not verified)', listingTable(shownRest as CompactRow[]));
        }
        if (!items.length) L.push('', 'No deals found with these settings.');
        L.push(
          '',
          'Legend: all_time_low = at or below the lowest price ever seen; genuine = at the 90-day low, in the cheapest 10 % of the last 90 days, or in the site\'s God pris zone; modest = below the usual price but not at the low; inflated = little or no real saving despite the claimed discount.',
          'Next: evaluate_purchase <id> for a full buy check.',
        );

        return finish(
          L.join('\n'),
          huntOutput,
          {
            mode,
            ...(query ? { query } : {}),
            ...(category_ids?.length ? { category_ids } : {}),
            discount_min,
            sort,
            sources: sources.filter((s) => s.url).map((s) => ({ url: s.url as string, pages: s.fetched })),
            pages_scanned: pagesScanned,
            candidates_found: candidatesFound,
            verified: verifiedRows.length,
            has_more,
            items,
            requests_used: http.requests,
          },
          warnings,
        );
      },
      ({ category_ids }) => (category_ids?.length === 1 ? `Category ${category_ids[0]} not found` : 'None of the categories were found'),
    ),
  );
};

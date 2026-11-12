import { z } from 'zod';
import { formatKr, markdownTable, truncate } from '../../format.js';
import { fetchCategoryListing } from '../categories.js';
import type { Registration } from '../index.js';
import {
  brandsInput,
  buildListingQuery,
  categoryIdInput,
  categoryUrl,
  CATEGORY_SORTS,
  compactRowSchema,
  filtersInput,
  finish,
  handle,
  listingTable,
  priceMaxInput,
  priceMinInput,
  READ_ONLY,
  recordLowInput,
  toCompactRow,
  warningsField,
} from '../shared.js';
import { capPages, dedupeById, maxPagesInput, progress, requestsUsedField, walkError } from './common.js';

const scanRow = compactRowSchema.extend({ properties: z.string().optional() });
type ScanRow = z.infer<typeof scanRow>;

const scanOutput = z.object({
  category_id: z.string(),
  category_name: z.string().optional(),
  url: z.string(),
  first_page: z.number(),
  last_page: z.number(),
  pages_scanned: z.number(),
  total: z.number().optional(),
  has_more: z.boolean(),
  next_page: z.number().optional(),
  items: z.array(scanRow),
  ...requestsUsedField,
  ...warningsField,
});

const spaced = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export const registerScanCategory: Registration = (server, ctx) => {
  server.registerTool(
    'scan_category',
    {
      title: 'Scan category',
      description:
        'Walk several pages of a category listing with the same filters as browse_category and return one flat list for analysis, e.g. cheapest per energy class. Page count is capped by the server (GODPRIS_MAX_PAGES).',
      inputSchema: {
        category_id: categoryIdInput,
        sort: z.enum(CATEGORY_SORTS).optional().describe('Sort order (default popularity).'),
        brands: brandsInput,
        price_min: priceMinInput,
        price_max: priceMaxInput,
        discount_min: z.coerce.number().int().min(1).max(99).optional().describe('Minimum discount in percent.'),
        filters: filtersInput,
        record_low_only: recordLowInput,
        start_page: z.coerce.number().int().min(1).max(100).default(1).describe('First page to fetch (default 1).'),
        max_pages: maxPagesInput(5, 50),
        include_properties: z
          .boolean()
          .default(false)
          .describe('Add the short spec summary shown on each tile (longer output).'),
      },
      outputSchema: scanOutput,
      annotations: READ_ONLY,
    },
    handle(
      'scan_category',
      async (
        args: {
          category_id: string;
          sort?: (typeof CATEGORY_SORTS)[number] | undefined;
          brands?: string[] | undefined;
          price_min?: number | undefined;
          price_max?: number | undefined;
          discount_min?: number | undefined;
          filters?: Array<{ key: string; min?: number | undefined; max?: number | undefined; values?: string[] | undefined }> | undefined;
          record_low_only?: boolean | undefined;
          start_page: number;
          max_pages: number;
          include_properties: boolean;
        },
        extra,
      ) => {
        const http = ctx.client.withCounter();
        const warnings: string[] = [];
        const pages = capPages(args.max_pages, ctx, warnings);
        const first = args.start_page;
        const rows: ScanRow[] = [];
        let categoryName: string | undefined;
        let total: number | undefined;
        let lastPage = first - 1;
        let hasNext = false;

        for (let p = first; p < first + pages; p++) {
          let listing;
          try {
            listing = await fetchCategoryListing(ctx, http, { ...args, page: p }, warnings, { validate: p === first });
          } catch (err) {
            walkError(err, p, warnings, first);
            hasNext = false;
            break;
          }
          lastPage = p;
          categoryName ||= listing.category_name;
          total ??= listing.meta.total;
          hasNext = listing.meta.has_next;
          for (const it of listing.items) {
            rows.push({ ...toCompactRow(it), ...(args.include_properties && it.properties ? { properties: it.properties } : {}) });
          }
          progress(extra, p - first + 1, pages, `page ${p}`);
          if (!hasNext || !listing.items.length) break;
        }

        const items = dedupeById(rows);
        const pagesScanned = lastPage - first + 1;
        const url = categoryUrl(args.category_id, buildListingQuery({ ...args, page: undefined }, []));
        const name = categoryName || `Category ${args.category_id}`;
        const totalPages = total !== undefined ? Math.ceil(total / 36) : undefined;
        const L: string[] = [`## ${name} (scan)`, url];
        L.push(
          `Pages ${first}–${lastPage}${totalPages !== undefined ? ` of ~${totalPages}` : ''}${total !== undefined ? ` · ${spaced(total)} products` : ''} · ${items.length} rows · Requests used: ${http.requests}`,
        );
        if (items.length) {
          L.push('');
          if (args.include_properties) {
            L.push(
              markdownTable(
                ['ID', 'Product', 'Price', 'Shops', 'Discount', 'Rating', 'Record low', 'Specs'],
                items.map((r) => [
                  r.id,
                  `[${[r.brand, r.title].filter(Boolean).join(' ')}](${r.url})`,
                  r.price !== undefined ? formatKr(r.price) : '',
                  r.shop_count ?? '',
                  r.discount_pct !== undefined ? `${r.discount_pct} %` : '',
                  r.rating ? `${r.rating.value}/${r.rating.max} (${r.rating.source})` : '',
                  r.record_low ? 'yes' : '',
                  truncate(r.properties ?? '', 120),
                ]),
              ),
            );
          } else L.push(listingTable(items));
        } else L.push('', 'No products match these filters.');
        if (hasNext) L.push('', `More: call again with start_page=${lastPage + 1}`);

        return finish(
          L.join('\n'),
          scanOutput,
          {
            category_id: args.category_id,
            ...(categoryName ? { category_name: categoryName } : {}),
            url,
            first_page: first,
            last_page: lastPage,
            pages_scanned: pagesScanned,
            ...(total !== undefined ? { total } : {}),
            has_more: hasNext,
            ...(hasNext ? { next_page: lastPage + 1 } : {}),
            items,
            requests_used: http.requests,
          },
          warnings,
        );
      },
      ({ category_id }) => `Category ${category_id} not found`,
    ),
  );
};

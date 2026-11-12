import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import { parseAutocomplete } from '../parsers/autocomplete.js';
import { parseListingMeta, parseProductTiles, type ListingItem, type ListingMeta } from '../parsers/tiles.js';
import { getCategoryIndex } from '../store/category-index.js';
import type { Registration } from './index.js';
import {
  brandsInput,
  buildListingQuery,
  compactRowSchema,
  CoreDataMissingError,
  finish,
  handle,
  listingTable,
  pageInput,
  pagingFooter,
  pagingSchema,
  priceMaxInput,
  priceMinInput,
  READ_ONLY,
  recordLowInput,
  SEARCH_SORTS,
  siteUrl,
  toCompactRow,
  warningsField,
  type CompactRow,
  type ListingInput,
} from './shared.js';

export const SEARCH_PAGE_SIZE = 32;

const searchProductsOutput = z.object({
  query: z.string(),
  total_results: z.number(),
  products: z.array(
    compactRowSchema.extend({
      category_id: z.string().optional(),
      variant_count: z.number().optional(),
    }),
  ),
  categories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      product_count: z.number().optional(),
      total: z.number().optional(),
      match: z.string().optional(),
      brand: z.string().optional(),
      url: z.string(),
    }),
  ),
  ...warningsField,
});

const searchListingOutput = z.object({
  query: z.string(),
  url: z.string(),
  ...pagingSchema,
  items: z.array(compactRowSchema),
  ...warningsField,
});

/** Fetch and parse one /sok listing page (page > 1 uses the fragment paging of the site). */
export async function fetchSearchListing(
  http: HttpClient,
  args: ListingInput & { query: string; page: number },
  warnings: string[],
): Promise<{ items: ListingItem[]; meta: ListingMeta; url: string }> {
  const filterQuery = buildListingQuery({ ...args, page: undefined }, warnings);
  const userQuery = { q: args.query, ...filterQuery };
  const url = siteUrl('/sok', userQuery);
  const reqQuery =
    args.page > 1 ? { ...userQuery, o: (args.page - 1) * SEARCH_PAGE_SIZE, l: SEARCH_PAGE_SIZE, fragment: 1 } : userQuery;
  const html = await http.getHtml('/sok', { query: reqQuery });
  const tiles = parseProductTiles(html);
  const meta = parseListingMeta(html);
  warnings.push(...tiles.warnings);
  if (!tiles.items.length && meta.total && meta.total > 0) throw new CoreDataMissingError('listing rows');
  if (!tiles.items.length && meta.total === undefined && args.page === 1) {
    warnings.push('Could not read the result count; the result may be empty or the layout changed');
  }
  return { items: tiles.items, meta, url };
}

export const registerSearchTools: Registration = (server, ctx) => {
  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Quick product lookup on godpris.no by name (autocomplete). Use this first to turn a product name into product ids and to discover matching categories; returns up to 20 products with lowest price and shop count.',
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe('Product name or search words, e.g. "iphone 16".'),
        limit: z.coerce.number().int().min(1).max(20).default(10).describe('Max products to return (1-20).'),
      },
      outputSchema: searchProductsOutput,
      annotations: READ_ONLY,
    },
    handle('search_products', async ({ query, limit }: { query: string; limit: number }) => {
      const json = await ctx.client.getJson('/api/product/search', { query: { q: query, t: '', l: limit } });
      const ac = parseAutocomplete(json);
      const products = ac.products.slice(0, limit).map((p) => ({
        ...toCompactRow({ ...p, record_low: p.record_low ?? false }),
        ...(p.category_id ? { category_id: p.category_id } : {}),
        ...(p.variant_count !== undefined ? { variant_count: p.variant_count } : {}),
      }));

      try {
        await getCategoryIndex(ctx).record(ac.categories.map((c) => ({ id: c.id, name: c.name })));
      } catch {
        /* best effort */
      }

      const lines: string[] = [];
      if (products.length) {
        lines.push(`## Products for "${query}" (${ac.total.toLocaleString('en-US').replace(/,/g, ' ')} matches)`, '', listingTable(products));
      } else {
        lines.push(`No products found for "${query}".`);
      }
      if (ac.categories.length) {
        lines.push('', '## Categories');
        for (const c of ac.categories) {
          const count = c.product_count ?? c.total;
          lines.push(
            `- ${c.name} (id ${c.id})${c.match === 'brand' && c.brand ? ` (brand ${c.brand})` : ''}${count !== undefined ? `, ${count} products` : ''}: ${c.url}`,
          );
        }
      }
      lines.push('', 'Next: use get_product with an id, or browse_category / get_category_filters with a category id.');
      return finish(
        lines.join('\n'),
        searchProductsOutput,
        { query, total_results: ac.total, products, categories: ac.categories },
        ac.warnings,
      );
    }),
  );

  server.registerTool(
    'search_listing',
    {
      title: 'Search listing',
      description:
        'Full search results for a free-text query with sorting, brand, price and record-low filters, 32 products per page. Use when search_products is too narrow or you need sorting or more results; for spec filters use browse_category.',
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe('Search words, e.g. "vaskemaskin".'),
        sort: z.enum(SEARCH_SORTS).optional().describe('Sort order (default relevance).'),
        brands: brandsInput,
        price_min: priceMinInput,
        price_max: priceMaxInput,
        record_low_only: recordLowInput,
        page: pageInput,
      },
      outputSchema: searchListingOutput,
      annotations: READ_ONLY,
    },
    handle(
      'search_listing',
      async (args: {
        query: string;
        sort?: (typeof SEARCH_SORTS)[number] | undefined;
        brands?: string[] | undefined;
        price_min?: number | undefined;
        price_max?: number | undefined;
        record_low_only?: boolean | undefined;
        page: number;
      }) => {
        const warnings: string[] = [];
        const listing = await fetchSearchListing(ctx.client, args, warnings);
        const { meta, url } = listing;
        const items: CompactRow[] = listing.items.map(toCompactRow);
        const has_next = !!meta.next_url;
        const paging = {
          page: args.page,
          has_next,
          ...(meta.total !== undefined ? { total: meta.total } : {}),
          ...(has_next ? { next_page: args.page + 1 } : {}),
        };
        const text = items.length
          ? [`## Search "${args.query}"`, url, '', listingTable(items), '', pagingFooter(paging)].join('\n')
          : `No products match "${args.query}".\n${url}`;
        return finish(text, searchListingOutput, { query: args.query, url, ...paging, items }, warnings);
      },
    ),
  );
};

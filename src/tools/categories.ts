import { z } from 'zod';
import { DEFAULT_DISK_TTL_MS } from '../http/cache.js';
import type { HttpClient, Query } from '../http/client.js';
import { parseAutocomplete } from '../parsers/autocomplete.js';
import { parseCategoryPage, parseTopCategories, type CategoryPage, type CategoryRef } from '../parsers/category.js';
import { parseFilters, type FilterDef, type SortOption } from '../parsers/filters.js';
import { parseListingMeta, parseProductTiles, type ListingItem, type ListingMeta } from '../parsers/tiles.js';
import { getCategoryIndex, recordCategoryPage } from '../store/category-index.js';
import type { Registration, ToolContext } from './index.js';
import {
  brandsInput,
  buildListingQuery,
  categoryIdInput,
  categoryUrl,
  CATEGORY_SORTS,
  compactRowSchema,
  CoreDataMissingError,
  filtersInput,
  finish,
  getDisk,
  handle,
  listingTable,
  pageInput,
  pagingFooter,
  pagingSchema,
  priceMaxInput,
  priceMinInput,
  READ_ONLY,
  recordLowInput,
  toCompactRow,
  warningsField,
  type CompactRow,
  type FilterInput,
  type ListingInput,
} from './shared.js';

const refSchema = z.object({ id: z.string(), name: z.string() });
const refUrlSchema = refSchema.extend({ url: z.string() });

const listCategoriesOutput = z.object({
  parent: refUrlSchema.optional(),
  breadcrumbs: z.array(refSchema),
  categories: z.array(refUrlSchema),
  is_leaf: z.boolean(),
  total_products: z.number().optional(),
  ...warningsField,
});

const findCategoryOutput = z.object({
  query: z.string(),
  categories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string().optional(),
      product_count: z.number().optional(),
      brand: z.string().optional(),
      source: z.enum(['autocomplete', 'visited']),
      url: z.string(),
    }),
  ),
  ...warningsField,
});

const filtersOutput = z.object({
  category_id: z.string(),
  category_name: z.string(),
  url: z.string(),
  filters: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(['range', 'enum', 'bool']),
      min: z.number().optional(),
      max: z.number().optional(),
      unit: z.string().optional(),
      options: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().optional() })).optional(),
    }),
  ),
  sort_options: z.array(z.object({ value: z.string(), label: z.string() })),
  ...warningsField,
});

const browseOutput = z.object({
  category_id: z.string(),
  category_name: z.string().optional(),
  url: z.string(),
  ...pagingSchema,
  subcategories: z.array(refSchema).optional(),
  items: z.array(compactRowSchema),
  ...warningsField,
});

const withUrl = (c: CategoryRef): CategoryRef & { url: string } => ({ ...c, url: categoryUrl(c.id) });

export interface CachedFilters {
  category_id: string;
  category_name: string;
  filters: FilterDef[];
  sort_options: SortOption[];
}

export const SPECIAL_KEYS = new Set(['p', 'b', 'd_min', 'rekordbillig']);

export async function loadFilters(
  ctx: ToolContext,
  id: string,
  warnings: string[],
  http: HttpClient = ctx.client,
): Promise<CachedFilters> {
  const disk = getDisk(ctx);
  const key = `filters:v1:${id}`;
  const hit = await disk.get<CachedFilters>(key, DEFAULT_DISK_TTL_MS).catch(() => undefined);
  if (hit) return hit;
  const html = await http.getHtml(`/kategori/${id}`, { notFoundOn500: true });
  const parsed = parseFilters(html);
  const page = parseCategoryPage(html);
  await recordCategoryPage(ctx, page);
  if (!parsed.filters.length) throw new CoreDataMissingError('filters');
  warnings.push(...parsed.warnings.filter((w) => w !== 'No filters found on page'));
  const value: CachedFilters = {
    category_id: id,
    category_name: page.name,
    filters: parsed.filters,
    sort_options: parsed.sort_options,
  };
  try {
    await disk.set(key, value);
  } catch {
    /* best effort */
  }
  return value;
}

/** Warn about requested filter keys/values that the category's own filter sidebar does not know. */
export function validateFilterInputs(
  defs: FilterDef[],
  filters: FilterInput[] | undefined,
  categoryId: string,
  warnings: string[],
): void {
  const known = new Map(defs.map((f) => [f.key, f]));
  for (const f of filters ?? []) {
    const base = f.key.trim().toLowerCase().replace(/_(min|max)$/, '');
    const key = base === 'd' ? 'd_min' : base;
    const def = known.get(key) ?? known.get(f.key.trim());
    if (!def && !SPECIAL_KEYS.has(key)) {
      warnings.push(`Unknown filter key ${f.key} for category ${categoryId}; call get_category_filters`);
      continue;
    }
    if (def?.options?.length && f.values?.length && def.type !== 'range') {
      const bad = f.values.filter((v) => !def.options?.some((o) => o.value === v));
      if (bad.length) {
        warnings.push(`Unknown value ${bad.join(', ')} for filter ${f.key} in category ${categoryId}; call get_category_filters`);
      }
    }
  }
}

export interface CategoryListing {
  category_id: string;
  category_name?: string;
  url: string;
  query: Query;
  items: ListingItem[];
  meta: ListingMeta;
  page: CategoryPage;
  filter_defs: FilterDef[];
}

/** Fetch and parse one /kategori/{id} listing page (shared by browse_category and the composite tools). */
export async function fetchCategoryListing(
  ctx: ToolContext,
  http: HttpClient,
  args: ListingInput & { category_id: string; page: number },
  warnings: string[],
  opts: { validate?: boolean } = {},
): Promise<CategoryListing> {
  const query = buildListingQuery(args, warnings);
  const html = await http.getHtml(`/kategori/${args.category_id}`, { query, notFoundOn500: true });
  const tiles = parseProductTiles(html);
  const meta = parseListingMeta(html);
  const page = parseCategoryPage(html);
  warnings.push(...tiles.warnings);
  await recordCategoryPage(ctx, page);

  const filter_defs = parseFilters(html).filters;
  if (opts.validate !== false) validateFilterInputs(filter_defs, args.filters, args.category_id, warnings);

  if (!tiles.items.length && meta.total && meta.total > 0) throw new CoreDataMissingError('listing rows');
  const url = categoryUrl(args.category_id, { ...query });
  return {
    category_id: args.category_id,
    ...(page.name ? { category_name: page.name } : {}),
    url,
    query,
    items: tiles.items,
    meta,
    page,
    filter_defs,
  };
}

function filterLine(f: FilterDef): string {
  const note =
    f.key === 'p' ? ' (use price_min/price_max)' : f.key === 'b' ? ' (use brands)' : f.key === 'rekordbillig' ? ' (use record_low_only)' : '';
  const head = `- **${f.label}**: key \`${f.key}\`${note}`;
  if (f.type === 'range') {
    const range = f.min !== undefined && f.max !== undefined ? `${f.min}–${f.max}` : [f.min, f.max].filter((x) => x !== undefined).join('–');
    return `${head}, range ${range}${f.unit ? ` ${f.unit}` : ''}`;
  }
  const opts = f.options ?? [];
  if (f.type === 'bool') {
    const label = (v: string): string => opts.find((o) => o.value === v)?.label ?? (v === '1' ? 'Ja' : 'Nei');
    const cnt = (v: string): string => {
      const c = opts.find((o) => o.value === v)?.count;
      return c !== undefined ? ` (${c})` : '';
    };
    return `${head}, values "1" = ${label('1')}${cnt('1')}, "0" = ${label('0')}${cnt('0')}`;
  }
  const shown = opts.slice(0, 60).map((o) => `${o.label}${o.count !== undefined ? ` (${o.count})` : ''}${o.label !== o.value ? ` [${o.value}]` : ''}`);
  const more = opts.length > 60 ? `, +${opts.length - 60} more` : '';
  return `${head}, options: ${shown.join(', ')}${more}`;
}

export const registerCategoryTools: Registration = (server, ctx) => {
  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description:
        'Browse the godpris.no category tree. Without parent_id it returns the 17 top-level categories; with parent_id it returns that category\'s subcategories and breadcrumb path.',
      inputSchema: { parent_id: categoryIdInput.optional() },
      outputSchema: listCategoriesOutput,
      annotations: READ_ONLY,
    },
    handle(
      'list_categories',
      async ({ parent_id }: { parent_id?: string | undefined }) => {
        if (!parent_id) {
          const disk = getDisk(ctx);
          const key = 'top-categories:v1';
          let cats = await disk.get<CategoryRef[]>(key, DEFAULT_DISK_TTL_MS).catch(() => undefined);
          const warnings: string[] = [];
          if (!cats) {
            const top = parseTopCategories(await ctx.client.getHtml('/'));
            if (!top.categories.length) throw new CoreDataMissingError('categories');
            cats = top.categories;
            warnings.push(...top.warnings);
            try {
              await disk.set(key, cats);
            } catch {
              /* best effort */
            }
          }
          try {
            await getCategoryIndex(ctx).record(cats.map((c) => ({ id: c.id, name: c.name, path: [c.name] })));
          } catch {
            /* best effort */
          }
          const text = ['## Top-level categories', ...cats.map((c) => `- ${c.name} (id ${c.id})`), '', 'Pass parent_id to see subcategories.'].join('\n');
          return finish(
            text,
            listCategoriesOutput,
            { breadcrumbs: [], categories: cats.map(withUrl), is_leaf: false },
            warnings,
          );
        }
        const html = await ctx.client.getHtml(`/kategori/${parent_id}`, { notFoundOn500: true });
        const page = parseCategoryPage(html);
        if (!page.name && !page.breadcrumbs.length && !page.subcategories.length) {
          throw new CoreDataMissingError('category data');
        }
        await recordCategoryPage(ctx, page);
        const is_leaf = page.subcategories.length === 0;
        const crumbs = page.breadcrumbs;
        const pathNames = crumbs.at(-1)?.id === parent_id ? crumbs.map((c) => c.name) : [...crumbs.map((c) => c.name), page.name].filter(Boolean);
        const lines = [`## ${pathNames.join(' > ') || parent_id}`];
        if (page.total !== undefined) lines.push(`${page.total} products`);
        lines.push('');
        if (is_leaf) lines.push('Leaf category: use get_category_filters / browse_category.');
        else lines.push(...page.subcategories.map((c) => `- ${c.name} (id ${c.id})`));
        return finish(
          lines.join('\n'),
          listCategoriesOutput,
          {
            parent: { id: parent_id, name: page.name || pathNames.at(-1) || parent_id, url: categoryUrl(parent_id) },
            breadcrumbs: crumbs,
            categories: page.subcategories.map(withUrl),
            is_leaf,
            ...(page.total !== undefined ? { total_products: page.total } : {}),
          },
          page.warnings,
        );
      },
      ({ parent_id }) => `Category ${parent_id} not found`,
    ),
  );

  server.registerTool(
    'find_category',
    {
      title: 'Find category',
      description:
        "Find category ids by name, e.g. 'vaskemaskin' or 'kaffetrakter'. Use before get_category_filters or browse_category when you do not know the category id.",
      inputSchema: {
        name: z.string().trim().min(1).max(100).describe('Category name or part of it, e.g. "vaskemaskin".'),
        limit: z.coerce.number().int().min(1).max(20).default(10).describe('Max categories to return (1-20).'),
      },
      outputSchema: findCategoryOutput,
      annotations: READ_ONLY,
    },
    handle('find_category', async ({ name, limit }: { name: string; limit: number }) => {
      const index = getCategoryIndex(ctx);
      const warnings: string[] = [];
      const ac = parseAutocomplete(await ctx.client.getJson('/api/product/search', { query: { q: name, t: '' } }));
      warnings.push(...ac.warnings);
      let visited: Awaited<ReturnType<typeof index.search>> = [];
      try {
        visited = await index.search(name, limit);
      } catch {
        /* best effort */
      }
      const byId = new Map(visited.map((v) => [v.id, v]));
      type Row = z.infer<typeof findCategoryOutput>['categories'][number];
      const rows: Row[] = [];
      const seen = new Set<string>();
      for (const c of ac.categories) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const path = byId.get(c.id)?.path?.join(' > ');
        const count = c.product_count ?? c.total;
        rows.push({
          id: c.id,
          name: c.name,
          ...(path ? { path } : {}),
          ...(count !== undefined ? { product_count: count } : {}),
          ...(c.brand ? { brand: c.brand } : {}),
          source: 'autocomplete',
          url: c.url,
        });
      }
      for (const v of visited) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        rows.push({
          id: v.id,
          name: v.name,
          ...(v.path?.length ? { path: v.path.join(' > ') } : {}),
          source: 'visited',
          url: categoryUrl(v.id),
        });
      }
      const categories = rows.slice(0, limit);
      const text = categories.length
        ? [
            `## Categories matching "${name}"`,
            ...categories.map(
              (c) =>
                `- ${c.name} (id ${c.id})${c.path ? `, ${c.path}` : ''}${c.brand ? ` (brand ${c.brand})` : ''}${c.product_count !== undefined ? `, ${c.product_count} products` : ''}`,
            ),
          ].join('\n')
        : 'No category found; try search_products or list_categories.';
      return finish(text, findCategoryOutput, { query: name, categories }, warnings);
    }),
  );

  server.registerTool(
    'get_category_filters',
    {
      title: 'Get category filters',
      description:
        'List the filters available in a category: keys, labels, ranges with units, and options with counts. Call this before browse_category to build its filters argument.',
      inputSchema: { category_id: categoryIdInput },
      outputSchema: filtersOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_category_filters',
      async ({ category_id }: { category_id: string }) => {
        const warnings: string[] = [];
        const data = await loadFilters(ctx, category_id, warnings);
        const lines = [`## Filters for ${data.category_name || `category ${category_id}`} (id ${category_id})`, ''];
        lines.push(...data.filters.map(filterLine));
        const rangeEx = data.filters.find((f) => f.type === 'range' && !SPECIAL_KEYS.has(f.key) && f.min !== undefined);
        const enumEx = data.filters.find((f) => f.type === 'enum' && !SPECIAL_KEYS.has(f.key) && f.options?.length);
        const ex: string[] = [];
        if (rangeEx) ex.push(`{"key":"${rangeEx.key}","min":${rangeEx.min}}`);
        if (enumEx?.options?.[0]) ex.push(`{"key":"${enumEx.key}","values":["${enumEx.options[0].value}"]}`);
        lines.push('', `Use in browse_category: filters: [${ex.join(',')}]`);
        if (data.sort_options.length) lines.push(`Sort options: ${data.sort_options.map((s) => `${s.value} (${s.label})`).join(', ')}`);
        return finish(
          lines.join('\n'),
          filtersOutput,
          {
            category_id,
            category_name: data.category_name,
            url: categoryUrl(category_id),
            filters: data.filters,
            sort_options: data.sort_options,
          },
          warnings,
        );
      },
      ({ category_id }) => `Category ${category_id} not found`,
    ),
  );

  server.registerTool(
    'browse_category',
    {
      title: 'Browse category',
      description:
        'List products in a category with sorting, brand, price, discount, record-low and spec filters (keys from get_category_filters), 36 per page. Use to find products that meet concrete requirements.',
      inputSchema: {
        category_id: categoryIdInput,
        sort: z.enum(CATEGORY_SORTS).optional().describe('Sort order (default popularity).'),
        brands: brandsInput,
        price_min: priceMinInput,
        price_max: priceMaxInput,
        discount_min: z.coerce.number().int().min(1).max(99).optional().describe('Minimum discount in percent.'),
        filters: filtersInput,
        record_low_only: recordLowInput,
        page: pageInput,
      },
      outputSchema: browseOutput,
      annotations: READ_ONLY,
    },
    handle(
      'browse_category',
      async (args: {
        category_id: string;
        sort?: (typeof CATEGORY_SORTS)[number] | undefined;
        brands?: string[] | undefined;
        price_min?: number | undefined;
        price_max?: number | undefined;
        discount_min?: number | undefined;
        filters?: Array<{ key: string; min?: number | undefined; max?: number | undefined; values?: string[] | undefined }> | undefined;
        record_low_only?: boolean | undefined;
        page: number;
      }) => {
        const warnings: string[] = [];
        const listing = await fetchCategoryListing(ctx, ctx.client, args, warnings);
        const { meta, page, url } = listing;
        const items: CompactRow[] = listing.items.map(toCompactRow);
        const has_next = !!meta.next_url;
        const paging = {
          page: args.page,
          has_next,
          ...(meta.total !== undefined ? { total: meta.total } : {}),
          ...(has_next ? { next_page: args.page + 1 } : {}),
        };
        const header = `## ${page.name || `Category ${args.category_id}`}`;
        const text = items.length
          ? [header, url, '', listingTable(items), '', pagingFooter(paging)].join('\n')
          : `${header}\nNo products match these filters.\n${url}`;
        return finish(
          text,
          browseOutput,
          {
            category_id: args.category_id,
            ...(page.name ? { category_name: page.name } : {}),
            url,
            ...paging,
            ...(page.subcategories.length ? { subcategories: page.subcategories } : {}),
            items,
          },
          warnings,
        );
      },
      ({ category_id }) => `Category ${category_id} not found`,
    ),
  );
};

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createDiskCache, type DiskCache } from '../http/cache.js';
import { BlockedPathError, NotFoundError, UpstreamError, type Query } from '../http/client.js';
import { formatKr, markdownTable } from '../format.js';
import type { ListingItem } from '../parsers/tiles.js';
import { BASE_URL } from '../parsers/util.js';
import type { ToolContext } from './index.js';
import { toolError, toolResult } from './result.js';

export const READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: true,
  destructiveHint: false,
} as const;

// ---- input fragments (explicit integer bounds, no nullable, flat) ----

export const productIdInput = z.coerce
  .string()
  .regex(/^\d{1,12}$/)
  .describe('godpris.no product id, e.g. "794250" (from search results).');
export const categoryIdInput = z.coerce
  .string()
  .regex(/^\d{1,9}$/)
  .describe('godpris.no category id, e.g. "1220" (from find_category or list_categories).');
export const pageInput = z.coerce.number().int().min(1).max(100).default(1).describe('Page number, starting at 1.');
export const brandsInput = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .describe('Only these brands, e.g. ["Bosch","AEG"].');
export const priceMinInput = z.coerce.number().int().min(0).max(10_000_000).optional().describe('Minimum price in NOK.');
export const priceMaxInput = z.coerce.number().int().min(0).max(10_000_000).optional().describe('Maximum price in NOK.');
export const recordLowInput = z.boolean().optional().describe('Only products at their record-low price.');
export const filtersInput = z
  .array(
    z.object({
      key: z.string().trim().min(1).max(40).describe('Filter key from get_category_filters, e.g. "f226".'),
      min: z.coerce.number().optional().describe('Range minimum (range filters).'),
      max: z.coerce.number().optional().describe('Range maximum (range filters).'),
      values: z.array(z.string().min(1)).max(30).optional().describe('Selected option values (enum/bool filters).'),
    }),
  )
  .max(20)
  .optional()
  .describe('Spec filters, e.g. [{"key":"f226","min":9},{"key":"f189","values":["A"]}].');

export const SEARCH_SORTS = ['relevance', 'popularity', 'discount_desc', 'price_asc', 'price_desc'] as const;
export const CATEGORY_SORTS = ['popularity', 'discount_desc', 'price_asc', 'price_desc', 'rating_avg_desc'] as const;

export const warningsField = { warnings: z.array(z.string()).optional() };

// ---- output fragments ----

export const compactRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  brand: z.string().optional(),
  price: z.number().optional(),
  shop_count: z.number().optional(),
  discount_pct: z.number().optional(),
  rating: z.object({ value: z.number(), max: z.number(), source: z.string() }).optional(),
  record_low: z.boolean().optional(),
  url: z.string(),
});
export type CompactRow = z.infer<typeof compactRowSchema>;

export function toCompactRow(item: ListingItem): CompactRow {
  return {
    id: item.id,
    title: item.title,
    ...(item.brand ? { brand: item.brand } : {}),
    ...(item.price !== undefined ? { price: item.price } : {}),
    ...(item.shop_count !== undefined ? { shop_count: item.shop_count } : {}),
    ...(item.discount_pct !== undefined ? { discount_pct: item.discount_pct } : {}),
    ...(item.rating ? { rating: { value: item.rating.value, max: item.rating.max, source: item.rating.source } } : {}),
    ...(item.record_low ? { record_low: true } : {}),
    url: item.url,
  };
}

export function listingTable(rows: CompactRow[]): string {
  return markdownTable(
    ['ID', 'Product', 'Price', 'Shops', 'Discount', 'Rating', 'Record low'],
    rows.map((r) => [
      r.id,
      `[${[r.brand, r.title].filter(Boolean).join(' ')}](${r.url})`,
      r.price !== undefined ? formatKr(r.price) : '',
      r.shop_count ?? '',
      r.discount_pct !== undefined ? `${r.discount_pct} %` : '',
      r.rating ? `${r.rating.value}/${r.rating.max} (${r.rating.source})` : '',
      r.record_low ? 'yes' : '',
    ]),
  );
}

export const pagingSchema = {
  page: z.number(),
  has_next: z.boolean(),
  total: z.number().optional(),
  next_page: z.number().optional(),
};

export interface PagingMeta {
  page: number;
  has_next: boolean;
  total?: number;
  next_page?: number;
}

export function pagingFooter(meta: PagingMeta): string {
  const parts = [`Page ${meta.page}`];
  if (meta.total !== undefined) {
    const n = meta.total.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    parts.push(`${n} products${meta.total >= 10000 ? ' (site caps counts at 10 000+)' : ''}`);
  }
  if (meta.has_next) parts.push(`more: call again with page=${meta.page + 1}`);
  return parts.join(' · ');
}

// ---- URLs and query building ----

export function productUrl(id: string): string {
  return `${BASE_URL}/produkt/${id}`;
}

export function siteUrl(path: string, query: Query = {}): string {
  const url = new URL(path, `${BASE_URL}/`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  return url.toString();
}

export function categoryUrl(id: string, query?: Query): string {
  return siteUrl(`/kategori/${id}`, query);
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export class CoreDataMissingError extends Error {
  constructor(
    public readonly what: string,
    public readonly detail?: string,
  ) {
    super(`Missing core data: ${what}`);
    this.name = 'CoreDataMissingError';
  }
}

export interface FilterInput {
  key: string;
  min?: number | undefined;
  max?: number | undefined;
  values?: string[] | undefined;
}

export interface ListingInput {
  query?: string;
  sort?: string | undefined;
  brands?: string[] | undefined;
  price_min?: number | undefined;
  price_max?: number | undefined;
  discount_min?: number | undefined;
  record_low_only?: boolean | undefined;
  filters?: FilterInput[] | undefined;
  page?: number | undefined;
}

/** Deterministic query: s, b..., p_min, p_max, d_min, rekordbillig, filters, page. */
export function buildListingQuery(input: ListingInput, warnings: string[]): Query {
  const q: Query = {};
  const dedicated = new Set<string>();
  if (input.sort && input.sort !== 'relevance') q['s'] = input.sort;
  if (input.brands?.length) {
    q['b'] = input.brands;
    dedicated.add('b');
  }
  if (input.price_min !== undefined) {
    q['p_min'] = input.price_min;
    dedicated.add('p');
  }
  if (input.price_max !== undefined) {
    q['p_max'] = input.price_max;
    dedicated.add('p');
  }
  if (input.discount_min !== undefined) {
    q['d_min'] = input.discount_min;
    dedicated.add('d_min');
  }
  if (input.record_low_only) {
    q['rekordbillig'] = 'lowest_price';
    dedicated.add('rekordbillig');
  }

  for (const f of input.filters ?? []) {
    let key = f.key.trim().toLowerCase();
    let min = f.min;
    const max = f.max;
    const values = f.values ?? [];
    if (key === 'd' || key === 'd_min') {
      key = 'd_min';
      min = min ?? (values.length ? Number(values[0]) : undefined);
      if (min === undefined || !Number.isFinite(min)) throw new InputError(`filter ${f.key} needs min, max or values`);
      if (dedicated.has('d_min')) {
        warnings.push('discount filter ignored: discount_min was also given');
        continue;
      }
      q['d_min'] = min;
      dedicated.add('d_min');
      continue;
    }
    key = key.replace(/_(min|max)$/, '');
    if (min === undefined && max === undefined && !values.length) {
      throw new InputError(`filter ${f.key} needs min, max or values`);
    }
    if (key === 'rekordbillig') {
      if (dedicated.has('rekordbillig')) {
        warnings.push('rekordbillig filter ignored: record_low_only was also given');
      } else {
        q['rekordbillig'] = 'lowest_price';
        dedicated.add('rekordbillig');
      }
      continue;
    }
    if (dedicated.has(key)) {
      warnings.push(`filter ${key} ignored: the dedicated parameter was also given`);
      continue;
    }
    if (min !== undefined) q[`${key}_min`] = min;
    if (max !== undefined) q[`${key}_max`] = max;
    if (values.length) q[key] = values;
  }

  if (input.page && input.page > 1) q['page'] = input.page;
  return q;
}

// ---- results and errors ----

export function capWarnings(warnings: string[] | undefined): string[] {
  const unique = [...new Set(warnings ?? [])];
  if (unique.length <= 10) return unique;
  return [...unique.slice(0, 10), `…and ${unique.length - 10} more`];
}

/** Build a success result; structuredContent is parsed through the output schema (strips extras). */
export function finish<S extends z.ZodType>(
  text: string,
  schema: S,
  value: Record<string, unknown>,
  warnings: string[] = [],
): CallToolResult {
  return toolResult(text, schema.parse({ ...value }) as Record<string, unknown>, capWarnings(warnings));
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Progress notification after a network step; helps clients that reset their timeout on progress. */
export function progress(extra: ToolExtra | undefined, done: number, total: number, message: string): void {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || !extra) return;
  void extra
    .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: done, total, message } })
    .catch(() => {});
}

export function handle<A>(
  toolName: string,
  fn: (args: A, extra?: ToolExtra) => Promise<CallToolResult>,
  notFound?: (args: A) => string,
): (args: A, extra?: ToolExtra) => Promise<CallToolResult> {
  return async (args: A, extra?: ToolExtra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      if (err instanceof NotFoundError) return toolError(notFound?.(args) ?? 'Not found on godpris.no');
      if (err instanceof CoreDataMissingError) {
        return toolError(
          `godpris.no returned no ${err.what}; the site layout may have changed.${err.detail ? ` ${err.detail}` : ''}`,
        );
      }
      if (err instanceof UpstreamError) {
        return toolError(`godpris.no request failed${err.status ? ` (HTTP ${err.status})` : ''}; try again shortly.`);
      }
      if (err instanceof InputError || err instanceof BlockedPathError) return toolError(err.message);
      return toolError(`Unexpected error in ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

const disks = new Map<string, DiskCache>();

export function getDisk(ctx: ToolContext): DiskCache {
  if (ctx.disk) return ctx.disk;
  let d = disks.get(ctx.config.dataDir);
  if (!d) {
    d = createDiskCache(ctx.config.dataDir);
    disks.set(ctx.config.dataDir, d);
  }
  return d;
}

export function nowOf(ctx: ToolContext): Date {
  return ctx.now?.() ?? new Date();
}

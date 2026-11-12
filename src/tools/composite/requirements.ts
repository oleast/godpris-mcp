import { z } from 'zod';
import { availableFilters, matchRequirements, type AppliedFilter } from '../../match/requirements.js';
import { fetchCategoryListing, loadFilters } from '../categories.js';
import type { Registration } from '../index.js';
import {
  categoryIdInput,
  CATEGORY_SORTS,
  compactRowSchema,
  finish,
  handle,
  listingTable,
  priceMaxInput,
  READ_ONLY,
  toCompactRow,
  warningsField,
  type CompactRow,
} from '../shared.js';
import { capPages, dedupeById, maxPagesInput, progress, requestsUsedField, resolveCategory, sortRows, walkError, type ResolvedCategory } from './common.js';

const availableSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['range', 'enum', 'bool']),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string()).optional(),
});

const findOutput = z.object({
  query: z.string(),
  category_id: z.string(),
  category_name: z.string().optional(),
  category_source: z.enum(['input', 'autocomplete', 'visited']),
  category_candidates: z.array(z.object({ id: z.string(), name: z.string(), product_count: z.number().optional() })).optional(),
  applied_filters: z.array(
    z.object({
      requirement: z.string(),
      key: z.string(),
      filter_label: z.string(),
      type: z.enum(['range', 'enum', 'bool']),
      min: z.number().optional(),
      max: z.number().optional(),
      unit: z.string().optional(),
      values: z.array(z.string()).optional(),
      value_labels: z.array(z.string()).optional(),
      score: z.number(),
      note: z.string().optional(),
    }),
  ),
  unmatched_requirements: z.array(
    z.object({
      requirement: z.string(),
      reason: z.enum(['no_matching_filter', 'ambiguous', 'unknown_key', 'needs_value', 'value_not_found', 'invalid_range']),
      detail: z.string(),
      suggestions: z.array(z.string()),
    }),
  ),
  available_filters: z.array(availableSchema),
  browse_filters: z.array(
    z.object({ key: z.string(), min: z.number().optional(), max: z.number().optional(), values: z.array(z.string()).optional() }),
  ),
  url: z.string().optional(),
  sort: z.string(),
  pages_scanned: z.number(),
  total: z.number().optional(),
  has_more: z.boolean(),
  items: z.array(compactRowSchema),
  ...requestsUsedField,
  ...warningsField,
});

function describeApplied(a: AppliedFilter): string {
  const unit = a.unit ? ` ${a.unit}` : '';
  let what: string;
  if (a.type === 'range') {
    if (a.min !== undefined && a.max !== undefined) what = `${a.min}–${a.max}${unit}`;
    else if (a.min !== undefined) what = `≥ ${a.min}${unit}`;
    else what = `≤ ${a.max}${unit}`;
  } else if (a.value_labels?.length) what = a.value_labels.join(', ');
  else what = (a.values ?? []).map((v) => (v === '1' ? 'Ja' : v === '0' ? 'Nei' : v)).join(', ');
  return `- ${a.requirement} → **${a.filter_label}** (\`${a.key}\`): ${what}${a.note ? `  _(${a.note})_` : ''}`;
}

const SOURCE_TEXT = { input: 'given', autocomplete: 'from autocomplete', visited: 'from visited categories' } as const;

export const registerFindByRequirements: Registration = (server, ctx) => {
  server.registerTool(
    'find_products_by_requirements',
    {
      title: 'Find products by requirements',
      description:
        "Find products in a category that meet spec requirements given in plain words, e.g. capacity ≥ 9 kg and energy class A. Maps each requirement to the category's filters (fuzzy, Norwegian or English labels), browses with them and reports which requirements could not be mapped plus the available filters so you can retry.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('What you look for, e.g. "vaskemaskin"; used to pick the category when category_id is not given.'),
        category_id: categoryIdInput.optional(),
        requirements: z
          .array(
            z.object({
              label: z
                .string()
                .trim()
                .min(1)
                .max(80)
                .describe('Spec name (Norwegian or English) or filter key, e.g. "Vaskekapasitet", "energy class", "f226".'),
              min: z.coerce.number().optional().describe('Minimum for numeric specs.'),
              max: z.coerce.number().optional().describe('Maximum for numeric specs.'),
              values: z
                .array(z.string().min(1).max(60))
                .max(20)
                .optional()
                .describe('Wanted options, e.g. ["A"], ["Ja"], or a number with unit like ["9 kg"].'),
            }),
          )
          .min(1)
          .max(15),
        max_price: priceMaxInput,
        sort: z.enum(CATEGORY_SORTS).default('price_asc'),
        max_pages: maxPagesInput(3, 10),
        limit: z.coerce.number().int().min(1).max(100).default(30).describe('Max products returned (1-100).'),
      },
      outputSchema: findOutput,
      annotations: READ_ONLY,
    },
    handle(
      'find_products_by_requirements',
      async (
        args: {
          query: string;
          category_id?: string | undefined;
          requirements: Array<{ label: string; min?: number | undefined; max?: number | undefined; values?: string[] | undefined }>;
          max_price?: number | undefined;
          sort: (typeof CATEGORY_SORTS)[number];
          max_pages: number;
          limit: number;
        },
        extra,
      ) => {
        const http = ctx.client.withCounter();
        const warnings: string[] = [];
        const { query, sort, limit, max_price } = args;

        const cat: ResolvedCategory = args.category_id
          ? { id: args.category_id, name: '', source: 'input', candidates: [] }
          : await resolveCategory(ctx, http, query, warnings);
        const data = await loadFilters(ctx, cat.id, warnings, http);
        let categoryName = cat.name || data.category_name;
        const defs = data.filters;
        const m = matchRequirements(args.requirements, defs);
        warnings.push(...m.warnings);
        const available = availableFilters(defs);

        const base = {
          query,
          category_id: cat.id,
          ...(categoryName ? { category_name: categoryName } : {}),
          category_source: cat.source,
          ...(cat.candidates.length ? { category_candidates: cat.candidates } : {}),
          applied_filters: m.applied,
          unmatched_requirements: m.unmatched,
          available_filters: available,
          browse_filters: m.filters,
          sort,
        };
        const head = [
          `# Products for "${query}" matching ${args.requirements.length} requirement${args.requirements.length === 1 ? '' : 's'}`,
          `Category: ${categoryName || 'unknown'} (id ${cat.id}), ${SOURCE_TEXT[cat.source]}`,
        ];
        const applied = m.applied.length ? ['## Applied filters', ...m.applied.map(describeApplied)] : [];
        const unmatchedLines = m.unmatched.length
          ? [
              '## Unmatched requirements',
              ...m.unmatched.map((u) => `- ${u.requirement}: ${u.detail}. ${u.suggestions.length ? `Closest: ${u.suggestions.join(', ')}` : 'Closest: none'}`),
              `Available filters: ${available
                .map((f) => {
                  const extra =
                    f.key === 'p'
                      ? ', use max_price'
                      : f.type === 'range'
                        ? f.min !== undefined || f.max !== undefined
                          ? `, ${f.min ?? ''}–${f.max ?? ''}${f.unit ? ` ${f.unit}` : ''}`
                          : ''
                        : f.options?.length
                          ? `: ${f.options.join(', ')}`
                          : '';
                  return `${f.label} (\`${f.key}\`${extra})`;
                })
                .join(', ')}`,
            ]
          : [];

        if (!m.filters.length) {
          const text = [
            ...head,
            ...applied,
            ...unmatchedLines,
            '',
            'No requirement could be mapped to a filter; retry with labels from available_filters.',
            `Requests used: ${http.requests}`,
          ].join('\n');
          return finish(text, findOutput, { ...base, pages_scanned: 0, has_more: false, items: [], requests_used: http.requests }, warnings);
        }

        const pages = capPages(args.max_pages, ctx, warnings);
        let collected: CompactRow[] = [];
        let pagesScanned = 0;
        let hasNext = false;
        let url: string | undefined;
        let total: number | undefined;
        for (let p = 1; p <= pages; p++) {
          let listing;
          try {
            listing = await fetchCategoryListing(
              ctx,
              http,
              { category_id: cat.id, sort, price_max: max_price, filters: m.filters, page: p },
              warnings,
              { validate: p === 1 },
            );
          } catch (err) {
            walkError(err, p, warnings);
            hasNext = false;
            break;
          }
          pagesScanned = p;
          if (p === 1) {
            url = listing.url;
            total = listing.meta.total;
            if (!categoryName && listing.category_name) categoryName = listing.category_name;
            if (listing.page.subcategories.length) {
              warnings.push(
                `Category ${categoryName || cat.id} has subcategories (${listing.page.subcategories
                  .slice(0, 5)
                  .map((s) => `${s.name} (${s.id})`)
                  .join(', ')}); requirements may map better in one of them`,
              );
            }
          }
          const rows = listing.items.map(toCompactRow);
          collected.push(...rows);
          hasNext = listing.meta.has_next;
          progress(extra, p, pages, `page ${p}`);
          collected = dedupeById(collected).filter((r) => max_price === undefined || r.price === undefined || r.price <= max_price);
          if (!hasNext || !rows.length || collected.length >= limit) break;
          if (sort === 'price_asc' && max_price !== undefined) {
            const lastPriced = [...rows].reverse().find((r) => r.price !== undefined);
            if (lastPriced?.price !== undefined && lastPriced.price > max_price) {
              hasNext = false;
              break;
            }
          }
        }

        const sorted = sortRows(collected, sort);
        const items = sorted.slice(0, limit);
        const has_more = hasNext || sorted.length > limit;
        const filtersJson = JSON.stringify(m.filters);
        const L = [
          ...head,
          ...applied,
          ...unmatchedLines,
          '',
          `## Results (${items.length}${total !== undefined ? ` of ${total}` : ''}, sorted ${sort})`,
          ...(url ? [url, ''] : []),
          items.length ? listingTable(items) : 'No products match these requirements.',
          '',
          `Pages scanned: ${pagesScanned}${has_more ? ` · more: browse_category with filters ${filtersJson} page=${pagesScanned + 1}` : ` · filters ${filtersJson}`} · Requests used: ${http.requests}`,
        ];
        return finish(
          L.join('\n'),
          findOutput,
          {
            ...base,
            ...(categoryName ? { category_name: categoryName } : {}),
            ...(url ? { url } : {}),
            pages_scanned: pagesScanned,
            ...(total !== undefined ? { total } : {}),
            has_more,
            items,
            requests_used: http.requests,
          },
          warnings,
        );
      },
      ({ category_id }) => (category_id ? `Category ${category_id} not found` : 'Category not found'),
    ),
  );
};

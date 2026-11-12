import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import { formatKr, markdownTable, truncate } from '../format.js';
import { parseCollectAtStoreCounts, parseProductPage, type ProductOffer, type ProductPage } from '../parsers/product.js';
import { getCategoryIndex } from '../store/category-index.js';
import type { Registration, ToolContext } from './index.js';
import {
  compactRowSchema,
  CoreDataMissingError,
  finish,
  handle,
  listingTable,
  productIdInput,
  productUrl,
  READ_ONLY,
  siteUrl,
  warningsField,
} from './shared.js';

const SECTIONS = ['offers', 'specs', 'tests', 'variants', 'alternatives', 'collect_at_store'] as const;

const offerSchema = z.object({
  shop: z.string(),
  price: z.number(),
  availability: z.string().optional(),
  in_stock: z.boolean().optional(),
  business_only: z.boolean(),
  item_title: z.string().optional(),
  merchant_url: z.string().optional(),
  shop_item_id: z.string().optional(),
});

const productOutput = z.object({
  id: z.string(),
  title: z.string(),
  brand: z.string().optional(),
  url: z.string(),
  category_id: z.string().optional(),
  group_id: z.string().optional(),
  gtin: z.string().optional(),
  mpn: z.string().optional(),
  image: z.string().optional(),
  breadcrumbs: z.array(z.object({ id: z.string(), name: z.string() })),
  price_low: z.number().optional(),
  price_high: z.number().optional(),
  shop_count: z.number().optional(),
  discount_pct: z.number().optional(),
  record_low: z.boolean(),
  highlights: z.array(z.string()),
  offers: z.array(offerSchema).optional(),
  variants: z
    .array(z.object({ dimension: z.string(), label: z.string(), id: z.string(), selected: z.boolean() }))
    .optional(),
  specs: z.array(z.object({ group: z.string(), name: z.string(), value: z.string() })).optional(),
  tests: z
    .array(
      z.object({
        outlet: z.string(),
        title: z.string().optional(),
        quote: z.string().optional(),
        rating_value: z.number().optional(),
        rating_max: z.number().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
  alternatives: z.array(compactRowSchema).optional(),
  collect_at_store: z
    .object({
      total_stores: z.number(),
      shops: z.array(z.object({ shop_id: z.string(), stores: z.number(), shop_url: z.string() })),
    })
    .optional(),
  ...warningsField,
});

/** Fetch and parse a product page; throws CoreDataMissingError when title or prices are missing. */
export async function fetchProductPage(ctx: ToolContext, http: HttpClient, productId: string): Promise<ProductPage> {
  const html = await http.getHtml(`/produkt/${productId}`, { notFoundOn500: true });
  const p = parseProductPage(html);
  if (!p.title) throw new CoreDataMissingError('product title');
  if (!p.offers.length) throw new CoreDataMissingError('prices');

  try {
    if (p.breadcrumbs.length) {
      const names: string[] = [];
      await getCategoryIndex(ctx).record(
        p.breadcrumbs.map((c, i, arr) => {
          names.push(c.name);
          return { id: c.id, name: c.name, ...(i ? { parent_id: arr[i - 1]?.id } : {}), path: [...names] } as {
            id: string;
            name: string;
            parent_id?: string;
            path: string[];
          };
        }),
      );
    }
  } catch {
    /* best effort */
  }
  return p;
}

export interface CollectAtStore {
  total_stores: number;
  shops: Array<{ shop_id: string; stores: number; shop_url: string }>;
}

/** Click & collect store counts per shop; throws on failure (the caller decides whether to warn). */
export async function fetchCollectAtStore(http: HttpClient, productId: string): Promise<CollectAtStore> {
  const counts = parseCollectAtStoreCounts(
    await http.getJson('/api/product/collectAtStoreCount', { query: { id: productId, market_id: 1 } }),
  );
  return {
    total_stores: counts.reduce((a, c) => a + c.stores, 0),
    shops: counts.map((c) => ({ ...c, shop_url: siteUrl(`/butikk/${c.shop_id}`) })),
  };
}

/** Cheapest offer; business-only offers are excluded unless every offer is business-only. Ties: first wins. */
export function cheapestOffer(offers: ProductOffer[], opts: { inStockOnly: boolean }): ProductOffer | undefined {
  const consumer = offers.filter((o) => !o.business_only);
  let pool = consumer.length ? consumer : offers;
  if (opts.inStockOnly) pool = pool.filter((o) => o.in_stock === true);
  let best: ProductOffer | undefined;
  for (const o of pool) if (!best || o.price < best.price) best = o;
  return best;
}

export const registerProductTools: Registration = (server, ctx) => {
  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description:
        'Full details for one product: every shop offer with price, availability and shop link, specs, expert tests, variants and popular alternatives. Use after you have a product id.',
      inputSchema: {
        product_id: productIdInput,
        include: z
          .array(z.enum(SECTIONS))
          .default([...SECTIONS])
          .describe('Sections to include (default all). collect_at_store costs one extra request.'),
      },
      outputSchema: productOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_product',
      async ({ product_id, include }: { product_id: string; include: Array<(typeof SECTIONS)[number]> }) => {
        const inc = new Set(include);
        const p = await fetchProductPage(ctx, ctx.client, product_id);
        const warnings = [...p.warnings];

        let collect: CollectAtStore | undefined;
        if (inc.has('collect_at_store')) {
          try {
            collect = await fetchCollectAtStore(ctx.client, product_id);
          } catch {
            warnings.push('Click & collect data unavailable');
          }
        }

        const id = p.id ?? product_id;
        const url = p.url ?? productUrl(id);
        const shopCount = p.offer_count ?? p.offers.length;
        const prices = p.offers.map((o) => o.price);
        const price_low = p.price_low ?? Math.min(...prices);
        const price_high = p.price_high ?? Math.max(...prices);
        const alternatives = p.alternatives.map((a) => ({
          id: a.id,
          title: a.title,
          ...(a.brand ? { brand: a.brand } : {}),
          ...(a.price !== undefined ? { price: a.price } : {}),
          ...(a.discount_pct !== undefined ? { discount_pct: a.discount_pct } : {}),
          ...(a.record_low ? { record_low: true } : {}),
          url: a.url,
        }));

        const L: string[] = [];
        L.push(`# ${[p.brand, p.title].filter(Boolean).join(' ')}`, `id ${id} · ${url}`);
        if (p.breadcrumbs.length) L.push(`Category: ${p.breadcrumbs.map((c) => c.name).join(' > ')}${p.category_id ? ` (id ${p.category_id})` : ''}`);
        const codes = [p.gtin ? `GTIN ${p.gtin}` : '', p.mpn ? `MPN ${p.mpn}` : ''].filter(Boolean);
        if (codes.length) L.push(codes.join(' · '));
        L.push(
          `${formatKr(price_low)}${price_high !== price_low ? ` – ${formatKr(price_high)}` : ''} across ${shopCount} shops${p.discount_pct !== undefined ? ` · ${p.discount_pct} % discount` : ''}${p.record_low ? ' · record low' : ''}`,
        );
        if (p.highlights.length) L.push(p.highlights.join(' · '));

        if (inc.has('offers')) {
          L.push(
            '',
            `## Offers (${p.offers.length})`,
            markdownTable(
              ['Shop', 'Price', 'Availability', 'Note', 'Link'],
              p.offers.map((o) => [
                o.shop,
                formatKr(o.price),
                o.availability ?? '',
                o.business_only ? 'Kun til bedrift' : '',
                `[butikk](${o.merchant_url ?? url})`,
              ]),
            ),
          );
        }
        if (inc.has('variants') && p.variants.length) {
          L.push('', '## Variants');
          const dims = [...new Set(p.variants.map((v) => v.dimension))];
          for (const d of dims) {
            L.push(
              `- ${d}: ${p.variants
                .filter((v) => v.dimension === d)
                .map((v) => `${v.selected ? `**${v.label}**` : v.label} (${v.id})`)
                .join(', ')}`,
            );
          }
        }
        if (inc.has('tests') && p.tests.length) {
          L.push('', `## Tests (${p.tests.length})`);
          for (const t of p.tests) {
            const rating = t.rating_value !== undefined ? ` ${t.rating_value}/${t.rating_max}` : '';
            L.push(
              `- ${t.outlet}${rating}${t.title ? `: *${t.title}*` : ''}${t.quote ? `: «${truncate(t.quote, 200)}»` : ''}${t.url ? ` (${t.url})` : ''}`,
            );
          }
        }
        if (inc.has('specs') && p.specs.length) {
          L.push('', '## Egenskaper og detaljer');
          const groups = [...new Set(p.specs.map((s) => s.group))];
          for (const g of groups) {
            L.push(`- **${g}**: ${p.specs.filter((s) => s.group === g).map((s) => `${s.name}: ${s.value}`).join('; ')}`);
          }
        }
        if (inc.has('alternatives') && alternatives.length) {
          L.push('', '## Popular alternatives', listingTable(alternatives));
        }
        if (collect) {
          L.push('', '## Click & collect');
          if (collect.shops.length) {
            L.push(
              `${collect.total_stores} stores with pickup.`,
              ...collect.shops.map((s) => `- shop ${s.shop_id}: ${s.stores} stores (${s.shop_url})`),
            );
          } else L.push('No click & collect stores.');
        }

        const value: Record<string, unknown> = {
          id,
          title: p.title,
          ...(p.brand ? { brand: p.brand } : {}),
          url,
          ...(p.category_id ? { category_id: p.category_id } : {}),
          ...(p.group_id ? { group_id: p.group_id } : {}),
          ...(p.gtin ? { gtin: p.gtin } : {}),
          ...(p.mpn ? { mpn: p.mpn } : {}),
          ...(p.image ? { image: p.image } : {}),
          breadcrumbs: p.breadcrumbs,
          price_low,
          price_high,
          shop_count: shopCount,
          ...(p.discount_pct !== undefined ? { discount_pct: p.discount_pct } : {}),
          record_low: p.record_low,
          highlights: p.highlights,
          ...(inc.has('offers') ? { offers: p.offers } : {}),
          ...(inc.has('variants') ? { variants: p.variants } : {}),
          ...(inc.has('specs') ? { specs: p.specs } : {}),
          ...(inc.has('tests') ? { tests: p.tests } : {}),
          ...(inc.has('alternatives') ? { alternatives } : {}),
          ...(collect ? { collect_at_store: collect } : {}),
        };
        return finish(L.join('\n'), productOutput, value, warnings);
      },
      ({ product_id }) => `Product ${product_id} not found`,
    ),
  );
};

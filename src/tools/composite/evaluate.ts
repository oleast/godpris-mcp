import { z } from 'zod';
import { formatKr } from '../../format.js';
import { purchaseRecommendation, type Recommendation } from '../../analysis/verdicts.js';
import type { ProductOffer } from '../../parsers/product.js';
import { fetchHistoryAnalysis, verdictSchema, type HistoryAnalysis, type VerdictInfo } from '../history.js';
import type { Registration } from '../index.js';
import { cheapestOffer, fetchCollectAtStore, fetchProductPage, type CollectAtStore } from '../product.js';
import { finish, handle, productIdInput, productUrl, READ_ONLY, warningsField } from '../shared.js';
import { requestsUsedField } from './common.js';

const offerBrief = z.object({
  shop: z.string(),
  price: z.number(),
  availability: z.string().optional(),
  in_stock: z.boolean().optional(),
  business_only: z.boolean().optional(),
  merchant_url: z.string().optional(),
});

const evaluateOutput = z.object({
  product_id: z.string(),
  title: z.string(),
  brand: z.string().optional(),
  url: z.string(),
  category: z.object({ id: z.string(), name: z.string() }).optional(),
  shop_count: z.number(),
  price_low: z.number(),
  price_high: z.number().optional(),
  discount_pct: z.number().optional(),
  record_low: z.boolean(),
  cheapest_offer: offerBrief.optional(),
  cheapest_in_stock: offerBrief.optional(),
  offers_in_stock: z.number(),
  history: z
    .object({
      today: z.object({ date: z.string(), price: z.number(), shop: z.string() }).optional(),
      low_90d: z.number().optional(),
      high_90d: z.number().optional(),
      low_all_time: z.number().optional(),
      low_all_time_date: z.string().optional(),
      days_since_all_time_low: z.number().optional(),
      percentile_90d: z.number().optional(),
      percentile_all: z.number().optional(),
      vs_90d_low_pct: z.number().optional(),
      vs_all_time_low_pct: z.number().optional(),
      data_points: z.number(),
      site_nice_time_to_buy: z.boolean().optional(),
    })
    .optional(),
  zone: verdictSchema,
  collect_at_store: z
    .object({
      total_stores: z.number(),
      shops: z.array(z.object({ shop_id: z.string(), stores: z.number(), shop_url: z.string() })),
    })
    .optional(),
  recommendation: z.enum(['buy_now', 'ok', 'wait', 'unknown']),
  reasons: z.array(z.string()),
  ...requestsUsedField,
  ...warningsField,
});

const round1 = (n: number): number => Math.round(n * 10) / 10;
const LABELS: Record<Recommendation, string> = { buy_now: 'BUY NOW', ok: 'OK', wait: 'WAIT', unknown: 'UNKNOWN' };

const brief = (o: ProductOffer): z.infer<typeof offerBrief> => ({
  shop: o.shop,
  price: o.price,
  ...(o.availability ? { availability: o.availability } : {}),
  ...(o.in_stock !== undefined ? { in_stock: o.in_stock } : {}),
  ...(o.business_only ? { business_only: true } : {}),
  ...(o.merchant_url ? { merchant_url: o.merchant_url } : {}),
});

export const registerEvaluatePurchase: Registration = (server, ctx) => {
  server.registerTool(
    'evaluate_purchase',
    {
      title: 'Evaluate purchase',
      description:
        "Should I buy this now? Combines the product's offers, price history and godpris.no's price zone into a buy_now / ok / wait recommendation with the reasons, the cheapest in-stock offer and click-and-collect availability. Use after you have a product id.",
      inputSchema: { product_id: productIdInput },
      outputSchema: evaluateOutput,
      annotations: READ_ONLY,
    },
    handle(
      'evaluate_purchase',
      async ({ product_id }: { product_id: string }) => {
        const http = ctx.client.withCounter();
        const warnings: string[] = [];
        const p = await fetchProductPage(ctx, http, product_id);
        warnings.push(...p.warnings);

        let collect: CollectAtStore | undefined;
        try {
          collect = await fetchCollectAtStore(http, product_id);
        } catch {
          warnings.push('Click & collect data unavailable');
        }

        let analysis: HistoryAnalysis | undefined;
        try {
          analysis = await fetchHistoryAnalysis(ctx, http, product_id);
          warnings.push(...analysis.warnings);
        } catch {
          warnings.push('price history unavailable');
        }
        const zone: VerdictInfo = analysis?.verdict ?? { verdict: 'unknown', reason: 'no price history', source: 'computed', zones: [] };
        const stats = analysis?.stats;
        const hasHistory = !!analysis && analysis.points.length > 0;

        const id = p.id ?? product_id;
        const url = p.url ?? productUrl(id);
        const any = cheapestOffer(p.offers, { inStockOnly: false });
        const inStock = cheapestOffer(p.offers, { inStockOnly: true });
        // mirror cheapestOffer: business-only offers count only when every offer is business-only
        const allBusinessOnly = p.offers.length > 0 && p.offers.every((o) => o.business_only);
        const offersInStock = p.offers.filter((o) => o.in_stock && (allBusinessOnly || !o.business_only)).length;
        const prices = p.offers.map((o) => o.price);
        const price_low = p.price_low ?? Math.min(...prices);
        const price_high = p.price_high ?? Math.max(...prices);
        const shopCount = p.offer_count ?? p.offers.length;

        const today = stats?.today;
        const vs90 =
          today && stats?.low_90d ? round1((100 * (today.price - stats.low_90d)) / stats.low_90d) : undefined;
        const vsAll =
          today && stats?.low_all_time ? round1((100 * (today.price - stats.low_all_time)) / stats.low_all_time) : undefined;

        const rec = purchaseRecommendation({
          verdict: zone.verdict,
          source: zone.source,
          ...(zone.label ? { label: zone.label } : {}),
          stats: stats ?? { data_points: 0, anchor_date: '' },
          in_stock_offers: offersInStock,
          ...(inStock ? { cheapest_in_stock: inStock.price } : {}),
          ...(any ? { cheapest_any: any.price } : {}),
        });

        if (allBusinessOnly) rec.reasons.push('only business (Kun til bedrift) offers');

        const category = p.breadcrumbs.at(-1);
        const title = [p.brand, p.title].filter(Boolean).join(' ');
        const offerLine = (label: string, o: ProductOffer): string =>
          `${label}: ${formatKr(o.price)} at ${o.shop}${o.availability ? ` (${o.availability})` : ''} [butikk](${o.merchant_url ?? url})`;

        const L: string[] = [`# Should I buy? ${title}`, `id ${id} · ${url}`];
        L.push(
          '',
          `## Recommendation: ${LABELS[rec.recommendation]} (${zone.source === 'site' ? `site zone: ${zone.label ?? zone.verdict}` : 'computed'})`,
        );
        if (zone.message) L.push(zone.message);
        L.push(...rec.reasons.map((r) => `- ${r}`));
        if (zone.zones.length) L.push(`Zones: ${zone.zones.map((z) => `${z.label} ${formatKr(z.min)} – ${formatKr(z.max)}`).join(' · ')}`);
        L.push('', '## Offers');
        if (inStock) L.push(offerLine('Cheapest in stock', inStock));
        else L.push('No offer is listed in stock');
        if (any && any !== inStock) L.push(offerLine('Cheapest overall', any));
        const parts = [
          `${shopCount} shops`,
          `${offersInStock} in stock`,
          `${formatKr(price_low)}${price_high !== price_low ? ` – ${formatKr(price_high)}` : ''}`,
          ...(p.discount_pct !== undefined ? [`${p.discount_pct} % discount badge`] : []),
          ...(p.record_low ? ['record low'] : []),
        ];
        L.push(parts.join(' · '));
        if (collect) {
          L.push(
            collect.shops.length
              ? `Click & collect: ${collect.total_stores} stores (${collect.shops.map((s) => `shop ${s.shop_id}: ${s.stores}`).join(', ')})`
              : 'Click & collect: none',
          );
        }
        L.push(
          `Requests used: ${http.requests}`,
          'Next: get_price_history for the full series, get_product for every offer and spec.',
        );

        return finish(
          L.join('\n'),
          evaluateOutput,
          {
            product_id: id,
            title: p.title,
            ...(p.brand ? { brand: p.brand } : {}),
            url,
            ...(category ? { category: { id: category.id, name: category.name } } : {}),
            shop_count: shopCount,
            price_low,
            price_high,
            ...(p.discount_pct !== undefined ? { discount_pct: p.discount_pct } : {}),
            record_low: p.record_low,
            ...(any ? { cheapest_offer: brief(any) } : {}),
            ...(inStock ? { cheapest_in_stock: brief(inStock) } : {}),
            offers_in_stock: offersInStock,
            ...(hasHistory && stats
              ? {
                  history: {
                    ...(today ? { today } : {}),
                    ...(stats.low_90d !== undefined ? { low_90d: stats.low_90d } : {}),
                    ...(stats.high_90d !== undefined ? { high_90d: stats.high_90d } : {}),
                    ...(stats.low_all_time !== undefined ? { low_all_time: stats.low_all_time } : {}),
                    ...(stats.low_all_time_date ? { low_all_time_date: stats.low_all_time_date } : {}),
                    ...(stats.days_since_all_time_low !== undefined ? { days_since_all_time_low: stats.days_since_all_time_low } : {}),
                    ...(stats.percentile_90d !== undefined ? { percentile_90d: stats.percentile_90d } : {}),
                    ...(stats.percentile_all !== undefined ? { percentile_all: stats.percentile_all } : {}),
                    ...(vs90 !== undefined ? { vs_90d_low_pct: vs90 } : {}),
                    ...(vsAll !== undefined ? { vs_all_time_low_pct: vsAll } : {}),
                    data_points: stats.data_points,
                    ...(analysis?.site_nice_time_to_buy !== undefined ? { site_nice_time_to_buy: analysis.site_nice_time_to_buy } : {}),
                  },
                }
              : {}),
            zone,
            ...(collect ? { collect_at_store: collect } : {}),
            recommendation: rec.recommendation,
            reasons: rec.reasons,
            requests_used: http.requests,
          },
          warnings,
        );
      },
      ({ product_id }) => `Product ${product_id} not found`,
    ),
  );
};

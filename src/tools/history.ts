import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import { formatKr, markdownTable } from '../format.js';
import {
  computeHistoryStats,
  computedVerdict,
  downsample,
  filterRange,
  parseHistoryJson,
  parseHistorySection,
  staleAnchor,
  zoneVerdict,
  type HistoryStats,
  type PricePoint,
  type PriceZone,
  type Verdict,
} from '../parsers/history.js';
import type { Registration, ToolContext } from './index.js';
import { finish, handle, nowOf, productIdInput, productUrl, READ_ONLY, warningsField } from './shared.js';

export const VERDICTS = ['good', 'ok', 'maybe', 'expensive', 'unknown'] as const;
const pointSchema = z.object({ date: z.string(), price: z.number(), shop: z.string() });

export const verdictSchema = z.object({
  verdict: z.enum(VERDICTS),
  label: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
  source: z.enum(['site', 'computed']),
  zones: z.array(z.object({ label: z.string(), min: z.number(), max: z.number() })),
});

const historyOutput = z.object({
  product_id: z.string(),
  url: z.string(),
  range: z.enum(['30d', '90d', 'all']),
  currency: z.literal('NOK'),
  today: pointSchema.optional(),
  low_90d: z.number().optional(),
  high_90d: z.number().optional(),
  low_all_time: z.number().optional(),
  low_all_time_date: z.string().optional(),
  high_all_time: z.number().optional(),
  days_since_all_time_low: z.number().optional(),
  percentile_90d: z.number().optional(),
  percentile_all: z.number().optional(),
  data_points: z.number(),
  first_date: z.string().optional(),
  site_nice_time_to_buy: z.boolean().optional(),
  verdict: verdictSchema,
  site_summary: z.array(z.string()).optional(),
  series: z.array(pointSchema),
  ...warningsField,
});

export interface VerdictInfo {
  verdict: Verdict;
  label?: string;
  message?: string;
  reason?: string;
  source: 'site' | 'computed';
  zones: PriceZone[];
}

export interface HistoryAnalysis {
  product_id: string;
  /** Full history, may be empty. */
  points: PricePoint[];
  stats: HistoryStats;
  verdict: VerdictInfo;
  site_summary?: string[];
  site_nice_time_to_buy?: boolean;
  warnings: string[];
}

/** Fetch the price history (1 request) and, unless disabled, godpris.no's verdict section (1 more). */
export async function fetchHistoryAnalysis(
  ctx: ToolContext,
  http: HttpClient,
  productId: string,
  opts: { section?: boolean } = {},
): Promise<HistoryAnalysis> {
  const warnings: string[] = [];
  const json = await http.getJson('/api/product/history', {
    query: { id: `i_${productId}`, market_id: 1, all: 1 },
    notFoundOn500: true,
  });
  const data = parseHistoryJson(json);
  warnings.push(...data.warnings);
  const pts = data.points;
  const today = pts[pts.length - 1];
  const now = nowOf(ctx);
  const stats = computeHistoryStats(pts, now);
  if (!today) {
    return {
      product_id: productId,
      points: pts,
      stats,
      verdict: { verdict: 'unknown', reason: 'no price history', source: 'computed', zones: [] },
      warnings,
    };
  }

  const stale = staleAnchor(pts, now);
  if (stale) warnings.push(`history is stale; last point ${stale}`);

  let verdict: VerdictInfo;
  let siteSummary: string[] | undefined;
  let siteNice: boolean | undefined = data.meta.nice_time_to_buy;
  const computed = (): VerdictInfo => ({ source: 'computed' as const, ...computedVerdict(pts, stats) });
  if (opts.section === false) {
    verdict = computed();
  } else {
    try {
      const html = await http.getHtml('/api/product/history-section', {
        query: { id: `i_${productId}`, price: today.price, shop: today.shop },
        notFoundOn500: true,
      });
      const section = parseHistorySection(html);
      if (section.summary.length) siteSummary = section.summary;
      siteNice = section.data?.meta.nice_time_to_buy ?? siteNice;
      if (section.zones.length) {
        const zv = zoneVerdict(section.zones, section.today_price ?? today.price);
        verdict = {
          source: 'site',
          ...zv,
          zones: section.zones,
          ...(section.message ? { message: section.message } : {}),
        };
      } else {
        verdict = computed();
      }
    } catch {
      warnings.push('site verdict unavailable');
      verdict = computed();
    }
  }
  return {
    product_id: productId,
    points: pts,
    stats,
    verdict,
    ...(siteSummary ? { site_summary: siteSummary } : {}),
    ...(siteNice !== undefined ? { site_nice_time_to_buy: siteNice } : {}),
    warnings,
  };
}

export const registerHistoryTools: Registration = (server, ctx) => {
  server.registerTool(
    'get_price_history',
    {
      title: 'Get price history',
      description:
        "Price history for one product: today's price, 90-day and all-time lows, percentile, and godpris.no's 'Er det riktig tidspunkt å kjøpe?' verdict (God pris / OK / Kanskje). Use to judge whether now is a good time to buy.",
      inputSchema: {
        product_id: productIdInput,
        range: z.enum(['30d', '90d', 'all']).default('90d').describe('Window for the returned price series.'),
        points: z.coerce.number().int().min(5).max(365).default(60).describe('Max points in the returned series (5-365).'),
      },
      outputSchema: historyOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_price_history',
      async ({ product_id, range, points: nPoints }: { product_id: string; range: '30d' | '90d' | 'all'; points: number }) => {
        const url = productUrl(product_id);
        const analysis = await fetchHistoryAnalysis(ctx, ctx.client, product_id);
        const { warnings, stats, verdict, points: pts } = analysis;
        const siteSummary = analysis.site_summary;
        const siteNice = analysis.site_nice_time_to_buy;
        const today = pts[pts.length - 1];
        if (!today) {
          return finish(
            `# Price history for product ${product_id}\n${url}\n\nNo price history yet.`,
            historyOutput,
            {
              product_id,
              url,
              range,
              currency: 'NOK',
              data_points: 0,
              verdict,
              series: [],
            },
            warnings,
          );
        }

        const window = filterRange(pts, range, stats.anchor_date);
        const series = downsample(window.length ? window : pts.slice(-1), nPoints);

        const L: string[] = [`# Price history for product ${product_id}`, url, ''];
        L.push(`Today (${today.date}): ${formatKr(today.price)} at ${today.shop}`);
        const lows: string[] = [];
        if (stats.low_90d !== undefined) lows.push(`90d low ${formatKr(stats.low_90d)} / high ${formatKr(stats.high_90d ?? stats.low_90d)}`);
        if (stats.low_all_time !== undefined) {
          lows.push(
            `all-time low ${formatKr(stats.low_all_time)}${stats.low_all_time_date ? ` (${stats.low_all_time_date}${stats.days_since_all_time_low !== undefined ? `, ${stats.days_since_all_time_low} days ago` : ''})` : ''} / high ${formatKr(stats.high_all_time ?? stats.low_all_time)}`,
          );
        }
        if (lows.length) L.push(lows.join('; '));
        if (stats.percentile_90d !== undefined) L.push(`Cheaper than today on ${stats.percentile_90d} % of the last 90 days`);
        L.push('', `## Verdict: ${verdict.verdict}${verdict.label ? ` (${verdict.label}, source: ${verdict.source})` : ` (source: ${verdict.source})`}`);
        if (verdict.message) L.push(verdict.message);
        if (verdict.reason) L.push(verdict.reason);
        if (verdict.zones.length) L.push(verdict.zones.map((z) => `${z.label}: ${formatKr(z.min)} – ${formatKr(z.max)}`).join(' · '));
        if (siteSummary?.length) L.push('', ...siteSummary.map((s) => `- ${s}`));
        L.push(
          '',
          `## Series (${range}, ${series.length} points, lowest price per interval)`,
          markdownTable(['Date', 'Price', 'Shop'], series.map((s) => [s.date, formatKr(s.price), s.shop])),
        );

        return finish(
          L.join('\n'),
          historyOutput,
          {
            product_id,
            url,
            range,
            currency: 'NOK',
            today,
            ...(stats.low_90d !== undefined ? { low_90d: stats.low_90d } : {}),
            ...(stats.high_90d !== undefined ? { high_90d: stats.high_90d } : {}),
            ...(stats.low_all_time !== undefined ? { low_all_time: stats.low_all_time } : {}),
            ...(stats.low_all_time_date ? { low_all_time_date: stats.low_all_time_date } : {}),
            ...(stats.high_all_time !== undefined ? { high_all_time: stats.high_all_time } : {}),
            ...(stats.days_since_all_time_low !== undefined ? { days_since_all_time_low: stats.days_since_all_time_low } : {}),
            ...(stats.percentile_90d !== undefined ? { percentile_90d: stats.percentile_90d } : {}),
            ...(stats.percentile_all !== undefined ? { percentile_all: stats.percentile_all } : {}),
            data_points: stats.data_points,
            ...(stats.first_date ? { first_date: stats.first_date } : {}),
            ...(siteNice !== undefined ? { site_nice_time_to_buy: siteNice } : {}),
            verdict,
            ...(siteSummary ? { site_summary: siteSummary } : {}),
            series,
          },
          warnings,
        );
      },
      ({ product_id }) => `Product ${product_id} not found (no price history)`,
    ),
  );
};

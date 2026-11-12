import * as cheerio from 'cheerio';
import { CoreDataMissingError } from '../tools/shared.js';
import { clean, parseNok } from './util.js';

export interface PricePoint {
  date: string;
  price: number;
  shop: string;
}
export interface HistoryMeta {
  price_min?: number;
  price_max?: number;
  first_date?: string;
  last_date?: string;
  low_90d?: number;
  nice_time_to_buy?: boolean;
}
export interface HistoryData {
  points: PricePoint[];
  meta: HistoryMeta;
  warnings: string[];
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const numOf = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(String(v));
  return Number.isFinite(n) ? Math.round(n) : undefined;
};
const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Parse {history, history_meta} (history endpoint) or {history, meta} (section). */
export function parseHistoryJson(json: unknown): HistoryData {
  if (!isRec(json) || !Array.isArray(json['history'])) throw new CoreDataMissingError('price history');
  const points: PricePoint[] = [];
  let bad = 0;
  for (const row of json['history']) {
    if (!Array.isArray(row)) {
      bad++;
      continue;
    }
    const date = strOf(row[0]);
    const price = numOf(row[1]);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || price === undefined) {
      bad++;
      continue;
    }
    points.push({ date, price, shop: typeof row[2] === 'string' ? row[2] : '' });
  }
  const warnings = bad ? [`Skipped ${bad} malformed price history rows`] : [];
  const m = json['history_meta'] ?? json['meta'];
  const meta: HistoryMeta = {};
  if (isRec(m)) {
    const set = <K extends keyof HistoryMeta>(k: K, v: HistoryMeta[K] | undefined): void => {
      if (v !== undefined) meta[k] = v;
    };
    set('price_min', numOf(m['price_min']));
    set('price_max', numOf(m['price_max']));
    set('first_date', strOf(m['created_min']));
    set('last_date', strOf(m['created_max']));
    set('low_90d', numOf(m['price_min_last_90_days']));
    if (typeof m['feature_nice_time_to_buy'] === 'boolean') meta.nice_time_to_buy = m['feature_nice_time_to_buy'];
  }
  return { points, meta, warnings };
}

export interface PriceZone {
  label: string;
  min: number;
  max: number;
}
export interface HistorySection {
  zones: PriceZone[];
  today_price?: number;
  message?: string;
  summary: string[];
  data?: HistoryData;
  warnings: string[];
}

const ZONE_RE = /^(.+?):\s*([\d\s  ]+)\s*[–-]\s*([\d\s  ]+)$/;

function zoneFrom(text: string): PriceZone | undefined {
  const m = ZONE_RE.exec(clean(text));
  if (!m?.[1] || !m[2] || !m[3]) return undefined;
  const min = parseNok(m[2]);
  const max = parseNok(m[3]);
  if (min === undefined || max === undefined) return undefined;
  return { label: clean(m[1]), min, max };
}

export function parseHistorySection(html: string): HistorySection {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  const zones: PriceZone[] = [];
  $('[data-ntb-zone]').each((_, el) => {
    const z = zoneFrom($(el).attr('data-ntb-zone') ?? '');
    if (z) zones.push(z);
  });
  if (!zones.length) {
    const sr = clean($('[data-ntb-bar] .sr-only, .app-ntb-box .sr-only').first().text());
    if (/^Prisindikator:/i.test(sr)) {
      const after = sr.replace(/^.*?Dagens pris/i, '');
      for (const m of after.matchAll(/([A-Za-zÆØÅæøå][^.:]*?):\s*([\d\s  ]+)\s*[–-]\s*([\d\s  ]+)/g)) {
        const z = zoneFrom(`${m[1]}: ${m[2]} – ${m[3]}`);
        if (z) zones.push(z);
      }
    }
  }

  const todayAttr = $('[data-ntb-bar]').first().attr('data-tooltip-current');
  const today_price = todayAttr ? parseNok(todayAttr.replace(/^[^:]*:/, '')) : undefined;

  const messageText = $('.app-ntb-box .w-full > span.text-base').first().text().trim();
  const summary: string[] = [];
  const slot$ = cheerio.load($('template[data-history-slot="summary"]').html() ?? '', null, false);
  slot$('p').each((_, p) => {
    const t = clean(slot$(p).text());
    if (t) summary.push(t);
  });

  let data: HistoryData | undefined;
  const raw = $('[data-history-data]').first().text();
  if (raw.trim()) {
    try {
      data = parseHistoryJson(JSON.parse(raw));
    } catch (e) {
      warnings.push(`Section history data unreadable: ${(e as Error).message}`);
    }
  }

  return {
    zones,
    ...(today_price !== undefined ? { today_price } : {}),
    ...(messageText ? { message: messageText } : {}),
    summary,
    ...(data ? { data } : {}),
    warnings,
  };
}

export type Verdict = 'good' | 'ok' | 'maybe' | 'expensive' | 'unknown';

export interface HistoryStats {
  today?: PricePoint;
  data_points: number;
  first_date?: string;
  low_90d?: number;
  high_90d?: number;
  low_all_time?: number;
  low_all_time_date?: string;
  high_all_time?: number;
  days_since_all_time_low?: number;
  percentile_90d?: number;
  percentile_all?: number;
  anchor_date: string;
}

export function osloDate(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}
const daysBetween = (a: string, b: string): number => dayNumber(b) - dayNumber(a);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Resolve the anchor date: today (Oslo), or the last point's date when history is stale (>30d). */
function resolveAnchor(points: PricePoint[], now: Date): { anchor: string; stale: boolean } {
  const today = osloDate(now);
  const last = points[points.length - 1];
  if (last && daysBetween(last.date, today) > 30) return { anchor: last.date, stale: true };
  return { anchor: today, stale: false };
}

export function filterRange(points: PricePoint[], range: '30d' | '90d' | 'all', anchor: string): PricePoint[] {
  if (range === 'all') return points;
  const n = range === '30d' ? 30 : 90;
  return points.filter((p) => daysBetween(p.date, anchor) < n);
}

function percentile(window: PricePoint[], price: number): number | undefined {
  if (!window.length) return undefined;
  return round1((100 * window.filter((p) => p.price < price).length) / window.length);
}

export function computeHistoryStats(points: PricePoint[], now: Date): HistoryStats {
  const { anchor } = resolveAnchor(points, now);
  const today = points[points.length - 1];
  const w90 = filterRange(points, '90d', anchor);
  const stats: HistoryStats = { data_points: points.length, anchor_date: anchor };
  if (!today) return stats;
  stats.today = today;
  const first = points[0];
  if (first) stats.first_date = first.date;
  if (w90.length) {
    stats.low_90d = Math.min(...w90.map((p) => p.price));
    stats.high_90d = Math.max(...w90.map((p) => p.price));
    const p90 = percentile(w90, today.price);
    if (p90 !== undefined) stats.percentile_90d = p90;
  }
  const low = Math.min(...points.map((p) => p.price));
  stats.low_all_time = low;
  stats.high_all_time = Math.max(...points.map((p) => p.price));
  const lowPoints = points.filter((p) => p.price === low);
  const lowDate = lowPoints[0]?.date;
  if (lowDate) stats.low_all_time_date = lowDate;
  const latestLow = lowPoints[lowPoints.length - 1];
  if (latestLow) stats.days_since_all_time_low = daysBetween(latestLow.date, anchor);
  const pAll = percentile(points, today.price);
  if (pAll !== undefined) stats.percentile_all = pAll;
  return stats;
}

export function zoneVerdict(zones: PriceZone[], price: number): { verdict: Verdict; label?: string } {
  const first = zones[0];
  const last = zones[zones.length - 1];
  if (!first || !last) return { verdict: 'unknown' };
  const classify = (label: string): Verdict => {
    if (/god pris/i.test(label)) return 'good';
    if (/^ok/i.test(label)) return 'ok';
    if (/kanskje/i.test(label)) return 'maybe';
    if (/dyr/i.test(label)) return 'expensive';
    return 'unknown';
  };
  if (price < first.min) return { verdict: classify(first.label), label: first.label };
  if (price > last.max) return { verdict: 'expensive', label: last.label };
  const hit = zones.find((z) => price >= z.min && price <= z.max) ?? last;
  return { verdict: classify(hit.label), label: hit.label };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export function computedVerdict(
  points: PricePoint[],
  stats: HistoryStats,
): { verdict: Verdict; zones: PriceZone[]; reason?: string } {
  const w90 = filterRange(points, '90d', stats.anchor_date);
  if (w90.length < 30 || stats.low_90d === undefined || stats.high_90d === undefined || stats.low_90d === stats.high_90d) {
    return { verdict: 'unknown', zones: [], reason: 'not enough price variation' };
  }
  const sorted = w90.map((p) => p.price).sort((a, b) => a - b);
  const q33 = Math.round(quantile(sorted, 1 / 3));
  const q66 = Math.round(quantile(sorted, 2 / 3));
  const zones: PriceZone[] = [
    { label: 'good', min: stats.low_90d, max: q33 },
    { label: 'ok', min: q33, max: q66 },
    { label: 'maybe', min: q66, max: stats.high_90d },
  ];
  const p = stats.percentile_90d ?? 100;
  const verdict: Verdict = p <= 33 ? 'good' : p <= 66 ? 'ok' : 'maybe';
  return { verdict, zones, reason: `${p} % of the last 90 days were cheaper than today` };
}

/** Reduce to exactly n points: per-bucket minimum price (ties: latest), always ending on the last point. */
export function downsample(points: PricePoint[], n: number): PricePoint[] {
  if (points.length <= n) return points;
  const body = points.slice(0, -1);
  const buckets = n - 1;
  const out: PricePoint[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * body.length) / buckets);
    const to = Math.floor(((b + 1) * body.length) / buckets);
    let best: PricePoint | undefined;
    for (const p of body.slice(from, Math.max(to, from + 1))) {
      if (!best || p.price <= best.price) best = p;
    }
    if (best) out.push(best);
  }
  const last = points[points.length - 1];
  if (last) out.push(last);
  return out;
}

/** True when the history is older than 30 days relative to now (for a stale warning). */
export function staleAnchor(points: PricePoint[], now: Date): string | undefined {
  const r = resolveAnchor(points, now);
  return r.stale ? points[points.length - 1]?.date : undefined;
}

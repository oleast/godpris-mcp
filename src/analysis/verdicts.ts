import { formatKr } from '../format.js';
import { filterRange, type HistoryStats, type PricePoint, type Verdict } from '../parsers/history.js';

export type Recommendation = 'buy_now' | 'ok' | 'wait' | 'unknown';
export type DealAssessment = 'all_time_low' | 'genuine' | 'modest' | 'inflated' | 'unverified';
export interface DealCheck {
  assessment: DealAssessment;
  inflated_discount: boolean;
  implied_before_price?: number;
  real_discount_pct?: number;
  median_90d?: number;
  reasons: string[];
}

export const DEAL = {
  MIN_POINTS_90D: 14,
  LOW_TOLERANCE: 0.01,
  MIN_REAL_PCT: 3,
  GENUINE_PERCENTILE: 10,
  INFLATED_REAL_MAX: 5,
  INFLATED_CLAIM_MIN: 10,
  BEFORE_TOLERANCE: 1.05,
} as const;

export const ASSESSMENT_RANK: Record<DealAssessment, number> = {
  all_time_low: 0,
  genuine: 1,
  modest: 2,
  unverified: 3,
  inflated: 4,
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function median(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const VERDICT_MAP: Record<Exclude<Verdict, 'unknown'>, Recommendation> = {
  good: 'buy_now',
  ok: 'ok',
  maybe: 'wait',
  expensive: 'wait',
};

export function purchaseRecommendation(input: {
  verdict: Verdict;
  source: 'site' | 'computed';
  label?: string;
  stats: HistoryStats;
  in_stock_offers: number;
  cheapest_in_stock?: number;
  cheapest_any?: number;
}): { recommendation: Recommendation; reasons: string[] } {
  const { stats } = input;
  const today = stats.today?.price;
  let recommendation: Recommendation = 'unknown';
  const reasons: string[] = [];

  if (input.verdict !== 'unknown') {
    recommendation = VERDICT_MAP[input.verdict];
    reasons.push(
      input.source === 'site'
        ? `Site zone: ${input.label ?? input.verdict}`
        : `Computed from 90-day percentiles: ${input.verdict}`,
    );
  } else if (today !== undefined && stats.low_90d !== undefined && today <= stats.low_90d) {
    recommendation = 'buy_now';
    reasons.push('at the 90-day low (no zone available)');
  }

  if (today !== undefined && stats.low_90d !== undefined && stats.low_90d > 0) {
    reasons.push(
      today <= stats.low_90d
        ? `Today's lowest ${formatKr(today)} is the 90-day low`
        : `Today's lowest ${formatKr(today)} is ${round1((100 * (today - stats.low_90d)) / stats.low_90d)} % above the 90-day low (${formatKr(stats.low_90d)})`,
    );
  }
  if (today !== undefined && stats.low_all_time !== undefined && stats.low_all_time > 0) {
    if (today <= stats.low_all_time) {
      reasons.push('Today matches the all-time low');
    } else {
      const when = stats.low_all_time_date
        ? ` on ${stats.low_all_time_date}${stats.days_since_all_time_low !== undefined ? ` (${stats.days_since_all_time_low} days ago)` : ''}`
        : '';
      reasons.push(
        `All-time low ${formatKr(stats.low_all_time)}${when}; today is ${round1((100 * (today - stats.low_all_time)) / stats.low_all_time)} % above it`,
      );
    }
  }
  if (stats.percentile_90d !== undefined) reasons.push(`Cheaper than today on ${round1(stats.percentile_90d)} % of the last 90 days`);
  if (input.in_stock_offers === 0) {
    reasons.push('No shop lists it in stock');
    if (recommendation === 'buy_now') {
      recommendation = 'ok';
      reasons.push('price is good but nothing is in stock');
    }
  }
  if (input.cheapest_in_stock !== undefined && input.cheapest_any !== undefined && input.cheapest_any > 0 && input.cheapest_in_stock > input.cheapest_any) {
    reasons.push(
      `Cheapest in-stock offer costs ${round1((100 * (input.cheapest_in_stock - input.cheapest_any)) / input.cheapest_any)} % more than the cheapest offer`,
    );
  }
  return { recommendation, reasons };
}

export function assessDeal(input: {
  price?: number;
  discount_pct?: number;
  points: PricePoint[];
  stats: HistoryStats;
  verdict: Verdict;
}): DealCheck {
  const { stats, price, discount_pct: d } = input;
  const w90 = filterRange(input.points, '90d', stats.anchor_date);
  if (w90.length < DEAL.MIN_POINTS_90D || stats.low_90d === undefined) {
    return {
      assessment: 'unverified',
      inflated_discount: false,
      reasons: [`not enough price history (${w90.length} days in the last 90)`],
    };
  }
  const current = Math.min(price ?? Infinity, stats.today?.price ?? Infinity);
  const med = median(w90.map((p) => p.price)) as number;
  const real = round1(100 * (1 - current / med));
  const implied =
    d !== undefined && d >= 1 && d <= 95 && price ? Math.round(price / (1 - d / 100)) : undefined;
  const high90 = stats.high_90d ?? med;
  const beforeNeverCharged = implied !== undefined && implied > high90 * DEAL.BEFORE_TOLERANCE;
  const claimDoubled = d !== undefined && d >= DEAL.INFLATED_CLAIM_MIN && real < d / 2;
  const inflated_discount = beforeNeverCharged || claimDoubled;

  const reasons: string[] = [];
  if (d !== undefined) reasons.push(`claimed ${d} % off, real ${real} % below the 90-day median ${formatKr(med)}`);
  if (beforeNeverCharged) reasons.push(`claimed before-price ${formatKr(implied)} is above the 90-day high ${formatKr(high90)}`);

  let assessment: DealAssessment;
  if (real >= DEAL.MIN_REAL_PCT && stats.low_all_time !== undefined && current <= stats.low_all_time) {
    assessment = 'all_time_low';
    reasons.push('at or below the all-time low');
  } else if (
    real >= DEAL.MIN_REAL_PCT &&
    (current <= stats.low_90d * (1 + DEAL.LOW_TOLERANCE) || (stats.percentile_90d ?? 100) <= DEAL.GENUINE_PERCENTILE || input.verdict === 'good')
  ) {
    assessment = 'genuine';
    if (current <= stats.low_90d * (1 + DEAL.LOW_TOLERANCE)) reasons.push('at the 90-day low');
  } else if (real <= DEAL.INFLATED_REAL_MAX && (d ?? 0) >= DEAL.INFLATED_CLAIM_MIN) {
    assessment = 'inflated';
  } else {
    assessment = 'modest';
  }
  return {
    assessment,
    inflated_discount,
    ...(implied !== undefined ? { implied_before_price: implied } : {}),
    real_discount_pct: real,
    median_90d: med,
    reasons,
  };
}

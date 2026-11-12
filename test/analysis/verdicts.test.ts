import { describe, expect, it } from 'vitest';
import { assessDeal, median, purchaseRecommendation } from '../../src/analysis/verdicts.js';
import { computeHistoryStats, parseHistoryJson, type PricePoint } from '../../src/parsers/history.js';
import { fixture } from '../parsers/helpers.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const pts = parseHistoryJson(JSON.parse(fixture('hist_all.json'))).points;
const stats = computeHistoryStats(pts, NOW);
const pts2 = parseHistoryJson(JSON.parse(fixture('hist_other.json'))).points;
const stats2 = computeHistoryStats(pts2, NOW);

describe('assessDeal', () => {
  it('flags a genuine low with an inflated claim', () => {
    const d = assessDeal({ price: 2799, discount_pct: 19, points: pts, stats, verdict: 'good' });
    expect(d).toMatchObject({ assessment: 'genuine', median_90d: 2990, real_discount_pct: 6.4, implied_before_price: 3456, inflated_discount: true });
  });
  it('detects an all-time low', () => {
    expect(assessDeal({ price: 2290, discount_pct: 30, points: pts, stats, verdict: 'good' }).assessment).toBe('all_time_low');
  });
  it('detects an inflated deal', () => {
    expect(assessDeal({ price: 10990, discount_pct: 10, points: pts2, stats: stats2, verdict: 'ok' }).assessment).toBe('inflated');
  });
  it('detects an inflated before-price on a flat history', () => {
    const flat: PricePoint[] = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 10, 11) - (99 - i) * 86_400_000);
      return { date: d.toISOString().slice(0, 10), price: 1000, shop: 'A' };
    });
    const d = assessDeal({ price: 1000, discount_pct: 50, points: flat, stats: computeHistoryStats(flat, NOW), verdict: 'unknown' });
    expect(d).toMatchObject({ assessment: 'inflated', inflated_discount: true, implied_before_price: 2000 });
  });
  it('is unverified without enough history', () => {
    const few = pts.slice(-5);
    expect(assessDeal({ price: 2799, discount_pct: 19, points: few, stats: computeHistoryStats(few, NOW), verdict: 'good' }).assessment).toBe('unverified');
  });
});

describe('purchaseRecommendation', () => {
  const base = { source: 'site' as const, stats, in_stock_offers: 3 };
  it('maps site verdicts', () => {
    const good = purchaseRecommendation({ ...base, verdict: 'good', label: 'God pris' });
    expect(good.recommendation).toBe('buy_now');
    expect(good.reasons).toContain('Site zone: God pris');
    expect(purchaseRecommendation({ ...base, verdict: 'maybe', label: 'Kanskje' }).recommendation).toBe('wait');
    expect(purchaseRecommendation({ ...base, verdict: 'ok' }).recommendation).toBe('ok');
  });
  it('falls back on the 90-day low for unknown verdicts', () => {
    expect(purchaseRecommendation({ ...base, verdict: 'unknown' }).recommendation).toBe('buy_now');
    expect(purchaseRecommendation({ ...base, verdict: 'unknown', stats: stats2 }).recommendation).toBe('unknown');
  });
  it('notes missing stock', () => {
    expect(purchaseRecommendation({ ...base, verdict: 'good', in_stock_offers: 0 }).reasons).toContain('No shop lists it in stock');
  });
  it('does not recommend buy_now when nothing is in stock', () => {
    const r = purchaseRecommendation({ ...base, verdict: 'good', in_stock_offers: 0 });
    expect(r.recommendation).toBe('ok');
    expect(r.reasons).toContain('price is good but nothing is in stock');
    expect(purchaseRecommendation({ ...base, verdict: 'unknown', in_stock_offers: 0 }).recommendation).toBe('ok');
    expect(purchaseRecommendation({ ...base, verdict: 'maybe', in_stock_offers: 0 }).recommendation).toBe('wait');
  });
});

describe('median', () => {
  it('computes medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

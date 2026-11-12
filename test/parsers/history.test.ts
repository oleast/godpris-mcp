import { describe, expect, it } from 'vitest';
import {
  computeHistoryStats,
  computedVerdict,
  downsample,
  filterRange,
  osloDate,
  parseHistoryJson,
  parseHistorySection,
  zoneVerdict,
} from '../../src/parsers/history.js';
import { CoreDataMissingError } from '../../src/tools/shared.js';
import { fixture } from './helpers.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const all = parseHistoryJson(JSON.parse(fixture('hist_all.json')));
const other = parseHistoryJson(JSON.parse(fixture('hist_other.json')));

describe('parseHistoryJson', () => {
  it('parses hist_all', () => {
    expect(all.points).toHaveLength(1035);
    expect(all.points.at(-1)).toEqual({ date: '2026-11-11', price: 2799, shop: 'Skousen' });
    expect(all.meta.low_90d).toBe(2799);
  });
  it('rejects a bad shape and aggregates bad rows', () => {
    expect(() => parseHistoryJson({})).toThrow(CoreDataMissingError);
    const r = parseHistoryJson({ history: [['2026-01-01', '10.00', 'A'], ['x'], 5] });
    expect(r.points).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('stats and verdicts', () => {
  it('computes stats for hist_all', () => {
    const s = computeHistoryStats(all.points, NOW);
    expect(s).toMatchObject({
      low_all_time: 2290,
      low_all_time_date: '2024-05-12',
      days_since_all_time_low: 913,
      low_90d: 2799,
      percentile_90d: 0,
    });
  });
  it('computes stats and computed verdict for hist_other', () => {
    const s = computeHistoryStats(other.points, NOW);
    expect(s.today).toMatchObject({ price: 10990, shop: 'Elkjøp' });
    expect(s.low_all_time).toBe(9490);
    expect(s.days_since_all_time_low).toBe(87);
    expect(s.percentile_90d).toBeGreaterThan(50);
    expect(s.percentile_90d).toBeLessThan(60);
    expect(computedVerdict(other.points, s).verdict).toBe('ok');
  });
  it('falls back to the last point date when history is stale', () => {
    const s = computeHistoryStats(all.points, new Date('2027-06-01T12:00:00Z'));
    expect(s.anchor_date).toBe('2026-11-11');
  });
  it('formats the Oslo date', () => {
    expect(osloDate(new Date('2026-11-11T23:30:00Z'))).toBe('2026-11-12');
  });
});

describe('parseHistorySection', () => {
  it('reads zones, message and data', () => {
    const s = parseHistorySection(fixture('hist_section.html'));
    expect(s.zones).toEqual([
      { label: 'God pris', min: 2799, max: 2990 },
      { label: 'OK', min: 2990, max: 3490 },
      { label: 'Kanskje', min: 3490, max: 3519 },
    ]);
    expect(s.today_price).toBe(2799);
    expect(s.message).toBe('Nå er det god pris 🥳');
    expect(s.summary).toHaveLength(2);
    expect(s.data).toBeDefined();
    expect(zoneVerdict(s.zones, 2799)).toEqual({ verdict: 'good', label: 'God pris' });
    expect(zoneVerdict(s.zones, 2990).verdict).toBe('good'); // overlap: first match wins
    expect(zoneVerdict(s.zones, 9999).verdict).toBe('expensive');
  });
  it('handles empty templates', () => {
    const s = parseHistorySection(fixture('hist_section_other.html'));
    expect(s.zones).toEqual([]);
    expect(s.data?.points).toHaveLength(62);
    expect(s.data?.points.at(-1)?.price).toBe(28990);
    const pts = s.data?.points ?? [];
    expect(computedVerdict(pts, computeHistoryStats(pts, NOW)).verdict).toBe('unknown');
  });
});

describe('series helpers', () => {
  it('downsample keeps length, last point and minimum', () => {
    const d = downsample(all.points, 60);
    expect(d).toHaveLength(60);
    expect(d.at(-1)).toEqual(all.points.at(-1));
    expect(Math.min(...d.map((p) => p.price))).toBe(2290);
    expect(downsample(all.points.slice(0, 5), 10)).toHaveLength(5);
  });
  it('filters ranges', () => {
    expect(filterRange(all.points, '90d', '2026-11-11')).toHaveLength(90);
    expect(filterRange(all.points, '30d', '2026-11-11')).toHaveLength(30);
    expect(filterRange(all.points, 'all', '2026-11-11')).toHaveLength(1035);
  });
});

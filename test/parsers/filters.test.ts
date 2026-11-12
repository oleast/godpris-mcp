import { describe, expect, it } from 'vitest';
import { parseFilters } from '../../src/parsers/filters.js';
import { fixture } from './helpers.js';

describe('parseFilters', () => {
  const kat = parseFilters(fixture('kat_1220.html'));
  const byKey = (k: string) => kat.filters.find((f) => f.key === k);

  it('parses range filters with min/max/unit', () => {
    expect(kat.warnings).toEqual([]);
    expect(byKey('f226')).toEqual({ key: 'f226', label: 'Vaskekapasitet', type: 'range', min: 3, max: 20, unit: 'kg' });
    expect(byKey('p')).toMatchObject({ label: 'Pris', type: 'range', min: 819, max: 42795, unit: 'kr' });
  });

  it('parses brand options (inline + deferred)', () => {
    const b = byKey('b');
    expect(b?.type).toBe('enum');
    expect(b?.options).toContainEqual({ value: 'AEG', label: 'AEG', count: 147 });
    expect(b?.options?.some((o) => o.value === 'Hisense')).toBe(true);
    expect(b?.options).toHaveLength(50);
  });

  it('parses deferred enum options (Energiklasse)', () => {
    expect(byKey('f189')).toMatchObject({ label: 'Energiklasse', type: 'enum' });
    expect(byKey('f189')?.options?.[0]).toEqual({ value: 'A', label: 'A', count: 524 });
    expect(byKey('f189')?.options).toHaveLength(6);
  });

  it('classifies Ja/Nei filters as bool', () => {
    expect(byKey('f235')).toMatchObject({ type: 'bool', options: [{ value: '1', label: 'Ja', count: 395 }, { value: '0', label: 'Nei', count: 41 }] });
  });

  it('parses sort options', () => {
    expect(kat.current_sort).toBe('popularity');
    expect(kat.sort_options.map((s) => s.value)).toEqual([
      'popularity',
      'discount_desc',
      'price_asc',
      'price_desc',
      'rating_avg_desc',
    ]);
    expect(kat.sort_options.find((s) => s.value === 'rating_avg_desc')?.label).toBe('Best i test');
  });

  it('parses deal filters: rekordbillig, discount, category tree, shop', () => {
    const t = parseFilters(fixture('tilbud.html'));
    const get = (k: string) => t.filters.find((f) => f.key === k);
    expect(get('rekordbillig')).toMatchObject({ type: 'bool' });
    expect(get('d_min')).toMatchObject({ type: 'range', min: 5, max: 95, unit: '%' });
    expect(get('d_min')?.options?.[0]).toEqual({ value: '70', label: '70 % eller mer', count: 469 });
    expect(get('c')?.options).toContainEqual({ value: '523', label: 'Data' });
    expect(get('shop')?.options?.length).toBeGreaterThan(5);
    expect(get('p')).toMatchObject({ type: 'range', min: 0 });
    expect(t.sort_options.map((s) => s.value)).toContain('offer_created_desc');
  });

  it('does not duplicate filters rendered for the mobile sidebar', () => {
    const keys = parseFilters(fixture('search_vask.html')).filters.map((f) => f.key);
    expect(keys.sort()).toEqual(['b', 'p', 'rekordbillig']);
  });

  it('warns (no throw) when no filters exist', () => {
    const r = parseFilters(fixture('gavetips1.html'));
    expect(r.filters).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

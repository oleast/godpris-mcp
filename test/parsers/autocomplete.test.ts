import { describe, expect, it } from 'vitest';
import { parseAutocomplete } from '../../src/parsers/autocomplete.js';
import { CoreDataMissingError } from '../../src/tools/shared.js';
import { fixture } from './helpers.js';

const load = (n: string): unknown => JSON.parse(fixture(n));

describe('parseAutocomplete', () => {
  it('parses iphone products and categories', () => {
    const r = parseAutocomplete(load('ac_iphone.json'));
    expect(r.products).toHaveLength(6);
    expect(r.products[0]).toMatchObject({
      id: '13229670',
      price: 10990,
      shop_count: 9,
      rating: { value: 5, max: 6, source: 'Lyd & bilde' },
      category_id: '525',
      url: 'https://godpris.no/produkt/13229670',
    });
    expect(r.categories.map((c) => c.id)).toEqual(['525', '531']);
    expect(r.total).toBe(10000);
    expect(r.query).toBe('iphone');
  });

  it('marks brand categories with the brand filter url', () => {
    const r = parseAutocomplete(load('ac_wilfa.json'));
    expect(r.categories.length).toBeGreaterThan(0);
    for (const c of r.categories) {
      expect(c.match).toBe('brand');
      expect(c.url).toContain('?b=Wilfa');
    }
  });

  it('accepts an empty response', () => {
    const r = parseAutocomplete({ results: [], categories: [], query: null, totalResults: 0 });
    expect(r.total).toBe(0);
    expect(r.products).toEqual([]);
    expect(r.categories).toEqual([]);
  });

  it('throws on unusable input', () => {
    expect(() => parseAutocomplete('nope')).toThrow(CoreDataMissingError);
    expect(() => parseAutocomplete({ results: 5 })).toThrow(CoreDataMissingError);
  });
});

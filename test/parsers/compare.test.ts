import { describe, expect, it } from 'vitest';
import { parseComparePage } from '../../src/parsers/compare.js';
import { fixture } from './helpers.js';

describe('parseComparePage', () => {
  const page = parseComparePage(fixture('sammenlign.html'));

  it('parses the product columns', () => {
    expect(page.warnings).toEqual([]);
    expect(page.products).toEqual([
      { id: '794250', title: 'Innovac Aqua Plus HS1-SWB', brand: 'Wilfa', price: 2799, url: 'https://godpris.no/produkt/794250' },
      { id: '1588920', title: 'Probaker KM1B-70 Matt Black', brand: 'Wilfa', price: 6775, url: 'https://godpris.no/produkt/1588920' },
    ]);
  });

  it('parses grouped spec rows aligned to the products', () => {
    expect(page.rows).toHaveLength(20);
    expect(page.rows.every((r) => r.values.length === 2)).toBe(true);
    expect(page.rows[0]).toEqual({ group: 'Egenskaper', name: 'Støvbeholder', values: ['0.7 L', ''] });
    expect(page.rows[1]).toEqual({ group: 'Egenskaper', name: 'Poseløs', values: ['Ja', ''] });
    expect(page.rows.find((r) => r.name === 'Pulsfunksjon')?.values).toEqual(['', 'Ja']);
    expect(page.rows.find((r) => r.name === 'Høyde')).toEqual({ group: 'Vekt og dimensjoner', name: 'Høyde', values: ['77 cm', '36 cm'] });
    expect(page.rows.find((r) => r.name === 'Materiale')?.values).toEqual(['', 'Plast, Rustfritt stål']);
  });
});

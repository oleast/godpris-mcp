import { describe, expect, it } from 'vitest';
import { parseListingMeta, parseProductTiles } from '../../src/parsers/tiles.js';
import { fixture } from './helpers.js';

describe('parseProductTiles', () => {
  it('parses a category page (36 tiles)', () => {
    const { items, warnings } = parseProductTiles(fixture('kat_1220.html'));
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(36);
    expect(items[0]).toMatchObject({
      id: '5099462',
      title: '6000-serien LR612L84A vaskemaskin',
      brand: 'AEG',
      price: 4299,
      record_low: false,
      url: 'https://godpris.no/produkt/5099462',
    });
    expect(items[0]?.image).toMatch(/^https:\/\/godpris\.no\/images\/dynamic\/3342876\//);
    expect(items[0]?.properties).toContain('Vaskekapasitet: 8kg');
    expect(items[1]).toMatchObject({ id: '8394093', brand: 'Bosch', price: 6899, discount_pct: 7 });
    expect(items.every((i) => /^\d+$/.test(i.id) && i.price !== undefined)).toBe(true);
    expect(items.some((i) => i.record_low)).toBe(true);
  });

  it('parses external ratings', () => {
    const vask = parseProductTiles(fixture('kat_1220.html')).items.find((i) => i.rating);
    expect(vask?.rating).toMatchObject({ source: 'Lyd & bilde', max: 6 });
    const iphone = parseProductTiles(fixture('search_iphone.html')).items;
    expect(iphone.find((i) => i.id === '20855484')?.rating).toEqual({ source: 'Pulssonen', value: 92, max: 100 });
  });

  it('parses a search page', () => {
    const { items } = parseProductTiles(fixture('search_vask.html'));
    expect(items).toHaveLength(32);
    expect(items.every((i) => i.title && i.price !== undefined)).toBe(true);
  });

  it('parses the "load more" search fragment', () => {
    const { items, warnings } = parseProductTiles(fixture('sok_fragment.html'));
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(32);
    expect(items[0]?.url).toMatch(/^https:\/\/godpris\.no\/produkt\/\d+$/);
  });

  it('parses deal tiles with discount and shop', () => {
    const { items } = parseProductTiles(fixture('tilbud.html'));
    expect(items).toHaveLength(48);
    expect(items.every((i) => i.discount_pct !== undefined && i.price !== undefined)).toBe(true);
    expect(items[0]).toMatchObject({
      id: '17013290',
      brand: 'Roborock',
      price: 7489,
      discount_pct: 51,
      offer_shop: 'Kjell & Company',
    });
  });

  it('parses gift guide tiles', () => {
    const { items } = parseProductTiles(fixture('gavetips1.html'));
    expect(items).toHaveLength(100);
    expect(items[0]).toMatchObject({ id: '8317112', title: 'Switch 2', brand: 'Nintendo', price: 5938 });
  });

  it('parses carousel tiles with record-low badge and shop count', () => {
    const { items } = parseProductTiles(fixture('carousel_offers.html'));
    expect(items).toHaveLength(34);
    expect(items[0]).toMatchObject({
      id: '15346856',
      record_low: true,
      discount_pct: 17,
      price: 1290,
      shop_count: 13,
    });
  });

  it('returns no items and no throw for unrelated html', () => {
    expect(parseProductTiles('<html><body>hi</body></html>')).toEqual({ items: [], warnings: [] });
  });
});

describe('parseListingMeta', () => {
  it('category page 1', () => {
    expect(parseListingMeta(fixture('kat_1220.html'))).toEqual({
      total: 1581,
      page: 1,
      has_next: true,
      next_url: 'https://godpris.no/kategori/1220?page=2',
      heading: 'Vaskemaskin',
    });
  });

  it('category page 2', () => {
    const m = parseListingMeta(fixture('kat1220_p2.html'));
    expect(m.page).toBe(2);
    expect(m.next_url).toBe('https://godpris.no/kategori/1220?page=3');
  });

  it('search page', () => {
    const m = parseListingMeta(fixture('search_vask.html'));
    expect(m.total).toBe(6930);
    expect(m.heading).toBe('Viser resultater for "vaskemaskin"');
    expect(m.has_next).toBe(true);
    expect(m.next_url).toContain('fragment=1');
  });

  it('deals page total with thousands separator', () => {
    expect(parseListingMeta(fixture('tilbud.html')).total).toBe(184593);
  });

  it('fragment without total still reports has_next; carousel has none', () => {
    const f = parseListingMeta(fixture('sok_fragment.html'));
    expect(f.total).toBeUndefined();
    expect(f.has_next).toBe(true);
    expect(parseListingMeta(fixture('carousel_offers.html')).has_next).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { merchantUrlFromClickUrl, parseCollectAtStoreCounts, parseProductPage } from '../../src/parsers/product.js';
import { fixture } from './helpers.js';

describe('parseProductPage 794250 (plain Product)', () => {
  const p = parseProductPage(fixture('prod_794250.html'));

  it('reads core fields', () => {
    expect(p).toMatchObject({
      id: '794250',
      title: 'Innovac Aqua Plus HS1-SWB',
      brand: 'Wilfa',
      category_id: '679',
      discount_pct: 19,
      lowest_price: 2799,
      lowest_shop: 'Skousen',
      record_low: false,
    });
    expect(p.breadcrumbs.at(-1)).toEqual({ id: '679', name: 'Trådløs støvsuger' });
    expect(p.variants).toEqual([]);
    expect(p.highlights[0]).toBe('Poseløs');
  });

  it('reads offers with merchant urls', () => {
    expect(p.offers).toHaveLength(4);
    expect(p.offers[0]).toMatchObject({ shop: 'Skousen', price: 2799, in_stock: true, business_only: false });
    expect(p.offers[0]?.merchant_url?.startsWith('https://www.skousen.no/p/WILFA-602789')).toBe(true);
  });

  it('reads specs, tests and alternatives', () => {
    expect(p.specs).toHaveLength(12);
    expect(p.specs).toContainEqual({ group: 'Egenskaper', name: 'Støvbeholder', value: '0.7 L' });
    expect(p.specs).toContainEqual(expect.objectContaining({ name: 'Poseløs', value: 'Ja' }));
    expect(p.tests).toHaveLength(1);
    expect(p.tests[0]).toMatchObject({ outlet: 'Tek.no', rating_value: 8.5, rating_max: 10 });
    expect(p.alternatives).toHaveLength(12);
    expect(p.alternatives[0]).toMatchObject({
      id: '18381735',
      brand: 'Shark',
      price: 3399,
      record_low: true,
      discount_pct: 37,
    });
  });
});

describe('parseProductPage 4758589 (ProductGroup)', () => {
  const p = parseProductPage(fixture('prod_4758589.html'));

  it('reads group data and offers', () => {
    expect(p).toMatchObject({ title: 'iPhone 16 128GB Black', group_id: '3516' });
    expect(p.offers).toHaveLength(8);
    const dustin = p.offers.find((o) => o.shop === 'Dustin');
    expect(dustin?.business_only).toBe(true);
    expect(dustin?.merchant_url).toBeUndefined();
  });

  it('reads variants and tests', () => {
    const storage = p.variants.filter((v) => v.dimension === 'Lagringsplass');
    const color = p.variants.filter((v) => v.dimension === 'Produsentfarge');
    expect(storage).toHaveLength(3);
    expect(color).toHaveLength(5);
    expect(storage.find((v) => v.selected)?.label).toBe('128 GB');
    expect(color.find((v) => v.selected)?.label).toBe('Svart');
    expect(p.tests).toHaveLength(2);
    expect(p.tests.find((t) => t.outlet === 'Pulssonen')).toMatchObject({ rating_value: 90, rating_max: 100 });
  });
});

describe('parseProductPage 20855452 (back order)', () => {
  const p = parseProductPage(fixture('prod_20855452.html'));
  it('marks pre-orders as not in stock', () => {
    const elkjop = p.offers.find((o) => o.shop === 'Elkjøp');
    expect(elkjop).toMatchObject({ availability: 'Forventet 14. des', in_stock: false });
    expect(p.tests).toHaveLength(9);
  });
});

describe('helpers', () => {
  it('decodes only the u= param', () => {
    expect(
      merchantUrlFromClickUrl('https://godpris.no/api/services/click?u=https%3A%2F%2Fshop.no%2Fp%3Fa%3D1&si=5&i=9'),
    ).toBe('https://shop.no/p?a=1');
    expect(merchantUrlFromClickUrl('https://godpris.no/api/services/click?i=9&si=5&signature=x')).toBeUndefined();
    expect(merchantUrlFromClickUrl(undefined)).toBeUndefined();
  });

  it('parses collect-at-store counts', () => {
    expect(parseCollectAtStoreCounts({ counts: [{ shop_id: 25, total: '3' }] })).toEqual([{ shop_id: '25', stores: 3 }]);
    expect(parseCollectAtStoreCounts(null)).toEqual([]);
  });
});

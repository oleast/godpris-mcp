import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, text } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('compare_products', () => {
  it('requests /sammenlign and drops equal rows by default', async () => {
    const h = await connectTools([{ path: '/sammenlign', file: 'sammenlign.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'compare_products', arguments: { product_ids: ['794250', 1588920] } });
    expect(res.isError).toBeFalsy();
    expect(h.calls[0]!.searchParams.get('ids')).toBe('794250,1588920');
    const sc = res.structuredContent as {
      products: Array<{ id: string }>;
      rows: Array<{ name: string; values: string[] }>;
      total_rows: number;
    };
    expect(sc.products.map((p) => p.id)).toEqual(['794250', '1588920']);
    expect(sc.total_rows).toBe(20);
    expect(sc.rows.length).toBeGreaterThan(0);
    expect(sc.rows.every((r) => new Set(r.values).size > 1)).toBe(true);
    expect(text(res)).toContain('Innovac Aqua Plus');
  });

  it('keeps all rows when differences_only is false', async () => {
    const h = await connectTools([{ path: '/sammenlign', file: 'sammenlign.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'compare_products',
      arguments: { product_ids: ['794250', '1588920'], differences_only: false },
    });
    expect((res.structuredContent as { rows: unknown[] }).rows).toHaveLength(20);
  });

  it('rejects a single product id', async () => {
    const h = await connectTools([]);
    close = h.close;
    const res = await h.client.callTool({ name: 'compare_products', arguments: { product_ids: ['794250'] } });
    expect(res.isError).toBe(true);
  });
});

describe('get_deals', () => {
  it('page 1 maps filters to tilbud params and returns shops', async () => {
    const h = await connectTools([{ path: '/tilbud', file: 'tilbud.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'get_deals',
      arguments: { category_id: '449', shop: 'Elkjøp', discount_min: 20, record_low_only: true, sort: 'discount_desc' },
    });
    expect(res.isError).toBeFalsy();
    const p = h.calls.at(-1)!.searchParams;
    expect(p.get('s')).toBe('discount_desc');
    expect(p.get('d_min')).toBe('20');
    expect(p.get('rekordbillig')).toBe('lowest_price');
    expect(p.get('c')).toBe('449');
    expect(p.get('shop')).toBe('231');
    expect(p.has('fragment')).toBe(false);
    const sc = res.structuredContent as { total?: number; items: Array<{ shop?: string; discount_pct?: number }>; has_next: boolean };
    expect(sc.total).toBe(184593);
    expect(sc.items).toHaveLength(48);
    expect(sc.items[0]).toMatchObject({ id: '17013290', shop: 'Kjell & Company', discount_pct: 51, price: 7489 });
    expect(sc.has_next).toBe(true);
  });

  it('returns no deals for a shop without current offers', async () => {
    const h = await connectTools([{ path: '/tilbud', file: 'tilbud.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_deals', arguments: { shop: 'Bikeshop' } });
    expect(res.isError).toBeFalsy();
    expect(h.calls).toHaveLength(1);
    expect((res.structuredContent as { items: unknown[] }).items).toEqual([]);
  });

  it('page 2 uses the fragment offset and a campaign path', async () => {
    const h = await connectTools([{ path: '/tilbud/black-friday', file: 'tilbud.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_deals', arguments: { campaign: 'black-friday', page: 2 } });
    expect(res.isError).toBeFalsy();
    const p = h.calls[0]!.searchParams;
    expect(p.get('o')).toBe('48');
    expect(p.get('l')).toBe('48');
    expect(p.get('fragment')).toBe('1');
    expect(p.has('page')).toBe(false);
    expect((res.structuredContent as { page: number }).page).toBe(2);
  });
});

describe('get_gift_ideas', () => {
  it('maps the recipient to tag_id and reports the total', async () => {
    const h = await connectTools([{ path: '/gavetips/1', file: 'gavetips1.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_gift_ideas', arguments: { recipient: 'mother' } });
    expect(res.isError).toBeFalsy();
    expect(h.calls[0]!.searchParams.get('tag_id')).toBe('7');
    const sc = res.structuredContent as { items: Array<{ id: string }>; total?: number; has_next: boolean };
    expect(sc.items).toHaveLength(100);
    expect(sc.items[0]?.id).toBe('8317112');
    expect(sc.total).toBe(450); // fixture is the unfiltered page
    expect(sc.has_next).toBe(true);
  });

  it('page 2 requests the fragment', async () => {
    const h = await connectTools([{ path: '/gavetips/1', file: 'gavetips1.html' }]);
    close = h.close;
    await h.client.callTool({ name: 'get_gift_ideas', arguments: { page: 2 } });
    const p = h.calls[0]!.searchParams;
    expect([p.get('o'), p.get('l'), p.get('fragment'), p.has('tag_id')]).toEqual(['100', '100', '1', false]);
  });
});

describe('get_trending', () => {
  it('reads the front-page deals carousel', async () => {
    const h = await connectTools([{ path: '/api/carousel/frontpage/offers', file: 'carousel_offers.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_trending', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { kind: string; items: Array<{ id: string; shop_count?: number; record_low?: boolean }> };
    expect(sc.kind).toBe('todays_deals');
    expect(sc.items).toHaveLength(34);
    expect(sc.items[0]).toMatchObject({ id: '15346856', shop_count: 13, discount_pct: 17, record_low: true });
  });

  it('uses the category carousel when category_id is given', async () => {
    const h = await connectTools([{ path: '/api/carousel/category/1220', file: 'carousel_offers.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_trending', arguments: { kind: 'most_watched', category_id: '1220' } });
    expect(res.isError).toBeFalsy();
    expect(h.calls[0]!.pathname).toBe('/api/carousel/category/1220');
    expect((res.structuredContent as { kind: string }).kind).toBe('category');
  });

  it('uses the most-watched carousel', async () => {
    const h = await connectTools([{ path: '/api/carousel/frontpage/most-watched', file: 'carousel_offers.html' }]);
    close = h.close;
    await h.client.callTool({ name: 'get_trending', arguments: { kind: 'most_watched' } });
    expect(h.calls[0]!.pathname).toBe('/api/carousel/frontpage/most-watched');
  });
});

describe('get_expert_tests', () => {
  it('maps filters and returns tests with outlets on page 1', async () => {
    const h = await connectTools([{ path: '/tester', file: 'tester.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'get_expert_tests',
      arguments: { category_id: '678', outlet: 'Tek.no', brand: 'Bosch', sort: 'rating_desc' },
    });
    expect(res.isError).toBeFalsy();
    const p = h.calls[0]!.searchParams;
    expect([p.get('c'), p.get('site'), p.get('b'), p.get('s')]).toEqual(['678', 'Tek.no', 'Bosch', 'rating_desc']);
    const sc = res.structuredContent as {
      total?: number;
      tests: Array<{ product_id: string; outlet: string; product_url: string }>;
      outlets?: Array<{ name: string; count?: number }>;
      has_next: boolean;
    };
    expect(sc.total).toBe(4382);
    expect(sc.tests).toHaveLength(30);
    expect(sc.tests[0]).toMatchObject({ product_id: '21798663', outlet: 'Lyd & bilde', product_url: 'https://godpris.no/produkt/21798663' });
    expect(sc.outlets?.find((o) => o.name === 'Tek.no')?.count).toBe(1395);
    expect(sc.has_next).toBe(true);
  });

  it('page 2 requests a 30-item fragment', async () => {
    const h = await connectTools([{ path: '/tester', file: 'tester.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_expert_tests', arguments: { page: 3 } });
    const p = h.calls[0]!.searchParams;
    expect([p.get('o'), p.get('l'), p.get('fragment')]).toEqual(['60', '30', '1']);
    expect((res.structuredContent as { outlets?: unknown }).outlets).toBeUndefined();
  });
});

describe('list_stores / get_store', () => {
  it('lists stores with paging', async () => {
    const h = await connectTools([{ path: '/butikk', file: 'butikk.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'list_stores', arguments: { page: 2 } });
    expect(res.isError).toBeFalsy();
    expect(h.calls[0]!.searchParams.get('page')).toBe('2');
    const sc = res.structuredContent as { stores: Array<{ id: string }>; has_next: boolean; next_page?: number };
    expect(sc.stores).toHaveLength(30);
    expect(sc.has_next).toBe(true);
    expect(sc.next_page).toBe(3);
  });

  it('returns store contact and popular products', async () => {
    const h = await connectTools([{ path: '/butikk/25', file: 'butikk25.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_store', arguments: { store_id: '25' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      name: string;
      contact: { email?: string; phone?: string };
      popular_products: unknown[];
      org_number?: string;
    };
    expect(sc.name).toBe('Joker');
    expect(sc.contact.email).toBe('nettbutikk@joker.no');
    expect(sc.org_number).toBe('977263646');
    expect(sc.popular_products).toHaveLength(18);
    expect(text(res)).toContain('nettbutikk@joker.no');
  });

  it('reports unknown stores as not found', async () => {
    const h = await connectTools([{ path: '/butikk/99999', status: 500 }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_store', arguments: { store_id: '99999' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Store 99999 not found');
  });
});

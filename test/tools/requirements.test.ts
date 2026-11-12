import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, text, type Route } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const routes: Route[] = [
  { path: '/api/product/search', file: 'ac_items.json' },
  { path: '/kategori/1220', query: { s: null }, file: 'kat_1220.html' },
  { path: '/kategori/1220', query: { page: '2' }, file: 'kat1220_p2.html' },
  { path: '/kategori/1220', file: 'kat1220_price_asc.html' },
];

const full = {
  query: 'vaskemaskin',
  requirements: [
    { label: 'vaskekapasitet', min: 9 },
    { label: 'energiklasse', values: ['A'] },
    { label: 'wifi' },
  ],
  max_price: 8000,
  max_pages: 2,
  limit: 50,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('find_products_by_requirements', () => {
  it('maps requirements, browses with them and pages', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({ name: 'find_products_by_requirements', arguments: full });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.category_id).toBe('1220');
    expect(sc.category_source).toBe('autocomplete');
    expect(sc.applied_filters.map((f: any) => f.key)).toEqual(['f226', 'f189']);
    expect(sc.unmatched_requirements).toHaveLength(1);
    expect(sc.unmatched_requirements[0].requirement).toBe('wifi');
    expect(sc.available_filters.length).toBeGreaterThan(10);
    const listing = h.calls.filter((u) => u.pathname === '/kategori/1220' && u.searchParams.has('s'));
    expect(listing[0]?.searchParams.get('s')).toBe('price_asc');
    expect(listing[0]?.searchParams.get('f226_min')).toBe('9');
    expect(listing[0]?.searchParams.get('f189')).toBe('A');
    expect(listing[0]?.searchParams.get('p_max')).toBe('8000');
    expect(listing[0]?.searchParams.has('page')).toBe(false);
    expect(h.calls.some((u) => u.searchParams.get('page') === '2')).toBe(true);
    expect(sc.items).toHaveLength(49);
    for (const i of sc.items) expect(i.price).toBeLessThanOrEqual(8000);
    expect(sc.pages_scanned).toBe(2);
    expect(sc.requests_used).toBe(4);
    expect(h.calls).toHaveLength(4);
    expect(h.unexpected).toEqual([]);
    expect(text(res)).toContain('"key":"f226"');

    const again = await h.client.callTool({ name: 'find_products_by_requirements', arguments: full });
    expect((again.structuredContent as any).requests_used).toBe(0);
  });

  it('does not browse when nothing maps', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({
      name: 'find_products_by_requirements',
      arguments: { query: 'vaskemaskin', requirements: [{ label: 'wifi' }] },
    });
    const sc = res.structuredContent as any;
    expect(sc.items).toEqual([]);
    expect(sc.pages_scanned).toBe(0);
    expect(sc.requests_used).toBe(2);
    expect(text(res)).toContain('Available filters');
  });

  it('skips autocomplete when category_id is given', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({
      name: 'find_products_by_requirements',
      arguments: { query: 'vaskemaskin', category_id: '1220', requirements: [{ label: 'vaskekapasitet', min: 9 }], limit: 10 },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(h.calls.some((u) => u.pathname === '/api/product/search')).toBe(false);
    expect(sc.category_source).toBe('input');
    expect(sc.requests_used).toBe(2);
  });
});

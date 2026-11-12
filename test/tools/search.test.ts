import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, text } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('search_products', () => {
  it('returns compact products and categories', async () => {
    const h = await connectTools([{ path: '/api/product/search', file: 'ac_iphone.json' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'search_products', arguments: { query: 'iphone' } });
    expect(res.isError).toBeFalsy();
    const url = h.calls[0]!;
    expect(url.searchParams.get('q')).toBe('iphone');
    expect(url.searchParams.get('t')).toBe('');
    expect(url.searchParams.get('l')).toBe('10');
    const sc = res.structuredContent as { products: Array<{ id: string }>; categories: unknown[] };
    expect(sc.products[0]?.id).toBe('13229670');
    expect(sc.categories).toHaveLength(2);
    expect(text(res)).toContain('13229670');
  });
});

describe('search_listing', () => {
  it('page 1 uses /sok with the query', async () => {
    const h = await connectTools([{ path: '/sok', file: 'search_iphone.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'search_listing', arguments: { query: 'iphone', sort: 'price_asc' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { total?: number; items: unknown[]; has_next: boolean; page: number };
    expect(sc.total).toBe(10000);
    expect(sc.items.length).toBeGreaterThan(0);
    expect(sc.has_next).toBe(true);
    expect(h.calls[0]!.searchParams.get('s')).toBe('price_asc');
    expect(h.calls[0]!.searchParams.has('fragment')).toBe(false);
    expect(text(res)).toContain('10 000+');
  });

  it('page 2 requests the fragment with offset and no page param', async () => {
    const h = await connectTools([{ path: '/sok', file: 'sok_fragment.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'search_listing', arguments: { query: 'iphone', page: 2 } });
    expect(res.isError).toBeFalsy();
    const p = h.calls[0]!.searchParams;
    expect(p.get('o')).toBe('32');
    expect(p.get('l')).toBe('32');
    expect(p.get('fragment')).toBe('1');
    expect(p.has('page')).toBe(false);
    const sc = res.structuredContent as { items: unknown[]; has_next: boolean; page: number; url: string };
    expect(sc.items).toHaveLength(32);
    expect(sc.has_next).toBe(true);
    expect(sc.page).toBe(2);
    expect(sc.url).not.toContain('fragment');
  });
});

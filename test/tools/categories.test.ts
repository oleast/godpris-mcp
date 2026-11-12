import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, text } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('list_categories', () => {
  it('lists the 17 top-level categories', async () => {
    const h = await connectTools([{ path: '/', file: 'home.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'list_categories', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { categories: unknown[] }).categories).toHaveLength(17);
  });

  it('lists subcategories of a parent', async () => {
    const h = await connectTools([{ path: '/kategori/449', file: 'kat_449.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'list_categories', arguments: { parent_id: '449' } });
    const sc = res.structuredContent as { categories: unknown[]; is_leaf: boolean };
    expect(sc.categories).toHaveLength(14);
    expect(sc.is_leaf).toBe(false);
  });

  it('reports unknown categories as not found', async () => {
    const h = await connectTools([{ path: '/kategori/999', status: 404 }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'list_categories', arguments: { parent_id: '999' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Category 999 not found');
  });
});

describe('get_category_filters', () => {
  it('lists filters and caches them on disk', async () => {
    const h = await connectTools([{ path: '/kategori/1220', file: 'kat_1220.html' }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_category_filters', arguments: { category_id: '1220' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { filters: Array<{ key: string; type: string; unit?: string; label: string }> };
    expect(sc.filters.find((f) => f.key === 'f226')).toMatchObject({ type: 'range', unit: 'kg', label: 'Vaskekapasitet' });
    const before = h.calls.length;
    const again = await h.client.callTool({ name: 'get_category_filters', arguments: { category_id: '1220' } });
    expect(again.isError).toBeFalsy();
    expect(h.calls.length).toBe(before);
  });
});

describe('browse_category', () => {
  it('builds the query and warns on unknown filters', async () => {
    const h = await connectTools([{ path: '/kategori/1220', file: 'kat1220_p2.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'browse_category',
      arguments: {
        category_id: '1220',
        sort: 'price_asc',
        brands: ['Bosch', 'AEG'],
        price_max: 8000,
        record_low_only: true,
        filters: [
          { key: 'f226', min: 9 },
          { key: 'f189', values: ['A', 'B'] },
          { key: 'f999', values: ['x'] },
        ],
        page: 2,
      },
    });
    expect(res.isError).toBeFalsy();
    const p = h.calls[0]!.searchParams;
    expect(p.getAll('b')).toEqual(['Bosch', 'AEG']);
    expect(p.getAll('f189')).toEqual(['A', 'B']);
    expect(p.get('f226_min')).toBe('9');
    expect(p.get('p_max')).toBe('8000');
    expect(p.get('rekordbillig')).toBe('lowest_price');
    expect(p.get('s')).toBe('price_asc');
    expect(p.get('page')).toBe('2');
    const sc = res.structuredContent as { items: unknown[]; warnings?: string[] };
    expect(sc.items).toHaveLength(36);
    expect(sc.warnings?.some((w) => w.includes('f999'))).toBe(true);
  });

  it('rejects a filter without min, max or values', async () => {
    const h = await connectTools([{ path: '/kategori/1220', file: 'kat_1220.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'browse_category',
      arguments: { category_id: '1220', filters: [{ key: 'f226' }] },
    });
    expect(res.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe('find_category', () => {
  it('finds via autocomplete, then via visited index', async () => {
    const h = await connectTools([
      { path: '/api/product/search', file: 'ac_items.json' },
      { path: '/kategori/449', file: 'kat_449.html' },
    ]);
    close = h.close;
    const res = await h.client.callTool({ name: 'find_category', arguments: { name: 'vask' } });
    const sc = res.structuredContent as { categories: Array<{ id: string; source: string }> };
    expect(sc.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['2126', '1220']));
    expect(sc.categories.find((c) => c.id === '1220')?.source).toBe('autocomplete');

    await h.client.callTool({ name: 'list_categories', arguments: { parent_id: '449' } });
    const res2 = await h.client.callTool({ name: 'find_category', arguments: { name: 'kjøkken' } });
    const sc2 = res2.structuredContent as { categories: Array<{ id: string; source: string; path?: string }> };
    expect(sc2.categories.find((c) => c.id === '592')).toMatchObject({ source: 'visited' });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { DiskCache } from '../../src/http/cache.js';
import { parseSitemapEntries } from '../../src/tools/sitemap.js';
import { fixture } from '../parsers/helpers.js';
import { connectTools, text, type Route } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const routes: Route[] = [
  { path: '/sitemap.xml', file: 'sitemap.xml' },
  { path: '/sitemap.categories.xml', file: 'sitemap.categories.xml' },
  { path: '/sitemap.shops.xml', file: 'sitemap.shops.xml' },
  { path: '/sitemaps/sitemap.items.0.xml', file: 'sitemap.items.xml' },
];

type Sc = Record<string, any>;

describe('parseSitemapEntries', () => {
  it('extracts ids and lastmod', () => {
    const r = parseSitemapEntries(fixture('sitemap.items.xml'), 'items');
    expect(r.ids.length).toBe(20);
    expect(r.ids[0]).toBe('28067');
    expect(r.lastmod[0]).toBe('2026-11-10');
    expect(parseSitemapEntries(fixture('sitemap.shops.xml'), 'shops').lastmod.every((m) => m === '')).toBe(true);
  });
});

describe('list_sitemap', () => {
  it('lists categories with offset and limit', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'categories', offset: 1, limit: 3 } });
    const sc = res.structuredContent as Sc;
    expect(sc['entries']).toHaveLength(3);
    expect(sc['entries'][0]).toMatchObject({ id: '1257', url: 'https://godpris.no/kategori/1257' });
    expect(sc).toMatchObject({ total: 20, has_more: true, next_offset: 4, total_is_lower_bound: false });
    expect(text(res)).toContain('offset=4');
  });

  it('lists shops and items; items use the needed file only', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const shops = (await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'shops', limit: 2 } })).structuredContent as Sc;
    expect(shops['entries'][0]).toMatchObject({ id: '25', url: 'https://godpris.no/butikk/25' });
    const items = (await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'items', offset: 2, limit: 2 } })).structuredContent as Sc;
    expect(items['entries'].map((e: Sc) => e['id'])).toEqual(['28244', '28245']);
    expect(items['entries'][0]).toMatchObject({ url: 'https://godpris.no/produkt/28244', lastmod: '2026-11-10' });
    expect(items['total_is_lower_bound']).toBe(true);
    expect(items['total']).toBe(950_000);
    expect(h.calls.map((u) => u.pathname)).not.toContain('/sitemaps/sitemap.items.950000.xml');
  });

  it('serves a repeated page from the disk cache without fetching', async () => {
    const h = await connectTools(routes);
    close = h.close;
    await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'items', limit: 5 } });
    const n = h.calls.length;
    expect(n).toBe(2); // index + items file
    const again = await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'items', offset: 5, limit: 5 } });
    expect(h.calls.length).toBe(n);
    expect((again.structuredContent as Sc)['entries']).toHaveLength(5);
  });

  it('reads a file that starts at a later offset', async () => {
    const h = await connectTools([...routes, { path: '/sitemaps/sitemap.items.50000.xml', file: 'sitemap.items.xml' }]);
    close = h.close;
    const sc = (await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'items', offset: 50_001, limit: 1 } })).structuredContent as Sc;
    expect(sc['entries'][0]['id']).toBe('28243');
    expect(h.calls.map((u) => u.pathname)).not.toContain('/sitemaps/sitemap.items.0.xml');
  });

  it('downloads a sitemap file once for concurrent calls', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const args = { kind: 'items', limit: 5 };
    await Promise.all([
      h.client.callTool({ name: 'list_sitemap', arguments: args }),
      h.client.callTool({ name: 'list_sitemap', arguments: args }),
    ]);
    expect(h.calls.filter((u) => u.pathname === '/sitemaps/sitemap.items.0.xml')).toHaveLength(1);
    expect(h.calls.filter((u) => u.pathname === '/sitemap.xml')).toHaveLength(1);
  });

  it('keeps the parsed list in memory when the disk cache cannot be written', async () => {
    const disk = new DiskCache('/nonexistent');
    disk.set = async () => {
      throw new Error('EROFS');
    };
    const h = await connectTools(routes, { disk });
    close = h.close;
    const first = (await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'items', limit: 5 } })).structuredContent as Sc;
    expect(first['warnings']).toContain('disk cache is not writable; sitemap files are kept in memory only');
    const n = h.calls.length;
    const again = (await h.client.callTool({ name: 'list_sitemap', arguments: { kind: 'items', offset: 5, limit: 5 } })).structuredContent as Sc;
    expect(h.calls.length).toBe(n);
    expect(again['entries']).toHaveLength(5);
    expect(again['warnings']).not.toContain('disk cache is not writable; sitemap files are kept in memory only');
  });
});

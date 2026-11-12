import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, type Route } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const routes: Route[] = [
  { path: '/kategori/1220', query: { page: null }, file: 'kat_1220.html' },
  { path: '/kategori/1220', query: { page: '2' }, file: 'kat1220_p2.html' },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('scan_category', () => {
  it('walks pages and dedupes', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({ name: 'scan_category', arguments: { category_id: '1220', max_pages: 2 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.items).toHaveLength(71);
    expect(sc.pages_scanned).toBe(2);
    expect(sc.has_more).toBe(true);
    expect(sc.next_page).toBe(3);
    expect(sc.requests_used).toBe(2);
    expect(sc.items.every((r: any) => !('properties' in r))).toBe(true);
  });

  it('caps pages by config', async () => {
    const h = await connectTools(routes, { env: { GODPRIS_MAX_PAGES: '2' } });
    close = h.close;
    const res = await h.client.callTool({ name: 'scan_category', arguments: { category_id: '1220', max_pages: 5 } });
    const sc = res.structuredContent as any;
    expect(sc.pages_scanned).toBe(2);
    expect(sc.warnings.some((w: string) => w.includes('capped at 2'))).toBe(true);
  });

  it('stops with a warning when a later page is missing', async () => {
    const h = await connectTools([...routes, { path: '/kategori/1220', query: { page: '3' }, status: 404 }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'scan_category', arguments: { category_id: '1220', max_pages: 3 } });
    const sc = res.structuredContent as any;
    expect(sc.pages_scanned).toBe(2);
    expect(sc.warnings.some((w: string) => w.includes('page 3'))).toBe(true);
    expect(sc.requests_used).toBe(3);
  });

  it('includes tile properties on request', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({
      name: 'scan_category',
      arguments: { category_id: '1220', max_pages: 1, include_properties: true },
    });
    const sc = res.structuredContent as any;
    expect(sc.items.some((r: any) => typeof r.properties === 'string' && r.properties.includes('kg'))).toBe(true);
  });
});

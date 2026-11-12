import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, text, type Route } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const historyRoutes: Route[] = [
  { path: '/api/product/history', file: 'hist_all.json' },
  { path: '/api/product/history-section', file: 'hist_section.html' },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('hunt_deals', () => {
  it('scans deals and verifies the top candidates', async () => {
    const h = await connectTools([{ path: '/tilbud', file: 'tilbud.html' }, ...historyRoutes]);
    close = h.close;
    const res = await h.client.callTool({ name: 'hunt_deals', arguments: { verify_history_top: 2, max_pages: 2 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    const deals = h.calls.filter((u) => u.pathname === '/tilbud');
    expect(deals).toHaveLength(1);
    expect(deals[0]?.searchParams.get('d_min')).toBe('20');
    expect(deals[0]?.searchParams.get('s')).toBe('discount_desc');
    expect(deals[0]?.searchParams.has('o')).toBe(false);
    const hist = h.calls.filter((u) => u.pathname === '/api/product/history').map((u) => u.searchParams.get('id'));
    expect(hist).toEqual(['i_715911', 'i_10182936']);
    expect(sc.requests_used).toBe(5);
    expect(h.calls).toHaveLength(5);
    expect(sc.verified).toBe(2);
    expect(sc.candidates_found).toBe(34);
    expect(sc.items).toHaveLength(30);
    expect(sc.items[0]).toMatchObject({ id: '715911', assessment: 'all_time_low' });
    expect(sc.items[1]).toMatchObject({ assessment: 'genuine', inflated_discount: true });
    for (const i of sc.items) expect(i.discount_pct).toBeGreaterThanOrEqual(20);
    expect(sc.mode).toBe('deals');
    expect(text(res)).toContain('Requests used: 5');
  });

  it('scans categories', async () => {
    const h = await connectTools([{ path: '/kategori/1220', file: 'kat_1220.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'hunt_deals',
      arguments: { category_ids: ['1220'], discount_min: 30, verify_history_top: 0 },
    });
    const sc = res.structuredContent as any;
    expect(h.calls[0]?.searchParams.get('s')).toBe('discount_desc');
    expect(h.calls[0]?.searchParams.get('d_min')).toBe('30');
    expect(sc.items).toHaveLength(6);
    expect(sc.requests_used).toBe(1);
    expect(sc.mode).toBe('category');
  });

  it('searches without sending d_min', async () => {
    const h = await connectTools([{ path: '/sok', file: 'search_vask.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'hunt_deals',
      arguments: { query: 'vaskemaskin', discount_min: 40, verify_history_top: 0 },
    });
    const sc = res.structuredContent as any;
    expect(h.calls[0]?.searchParams.get('q')).toBe('vaskemaskin');
    expect(h.calls[0]?.searchParams.get('s')).toBe('discount_desc');
    expect(h.calls[0]?.searchParams.has('d_min')).toBe(false);
    expect(sc.items).toHaveLength(4);
  });

  it('rejects query together with category_ids', async () => {
    const h = await connectTools([]);
    close = h.close;
    const res = await h.client.callTool({ name: 'hunt_deals', arguments: { query: 'x', category_ids: ['1220'] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('either query or category_ids');
    expect(h.calls).toEqual([]);
  });

  it('marks deals unverified when history is missing', async () => {
    const h = await connectTools([{ path: '/tilbud', file: 'tilbud.html' }, { path: '/api/product/history', status: 404 }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'hunt_deals', arguments: { verify_history_top: 1 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.items[0]).toMatchObject({ assessment: 'unverified', note: 'no price history' });
  });
});

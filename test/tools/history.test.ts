import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, text } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

interface Out {
  verdict: { verdict: string; source: string; label?: string };
  series: unknown[];
  warnings?: string[];
}

describe('get_price_history', () => {
  it('uses the site verdict when zones are present', async () => {
    const h = await connectTools([
      { path: '/api/product/history', file: 'hist_all.json' },
      { path: '/api/product/history-section', file: 'hist_section.html' },
    ]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_price_history', arguments: { product_id: '794250' } });
    expect(res.isError).toBeFalsy();
    const section = h.calls.find((u) => u.pathname === '/api/product/history-section')!;
    expect(section.searchParams.get('id')).toBe('i_794250');
    expect(section.searchParams.get('price')).toBe('2799');
    expect(section.searchParams.get('shop')).toBe('Skousen');
    const sc = res.structuredContent as Out;
    expect(sc.verdict).toMatchObject({ source: 'site', verdict: 'good' });
    expect(sc.series).toHaveLength(60);
    expect(text(res)).toContain('## Verdict: good');
  });

  it('computes the verdict when the section has no zones', async () => {
    const h = await connectTools([
      { path: '/api/product/history', file: 'hist_other.json' },
      { path: '/api/product/history-section', file: 'hist_section_other.html' },
    ]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_price_history', arguments: { product_id: '20855452' } });
    expect((res.structuredContent as Out).verdict.source).toBe('computed');
  });

  it('falls back to a computed verdict with a warning when the section fails', async () => {
    const h = await connectTools([
      { path: '/api/product/history', file: 'hist_other.json' },
      { path: '/api/product/history-section', status: 503 },
    ]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_price_history', arguments: { product_id: '20855452' } });
    const sc = res.structuredContent as Out;
    expect(sc.verdict).toMatchObject({ source: 'computed', verdict: 'ok' });
    expect(sc.warnings).toContain('site verdict unavailable');
  });

  it('reports unknown products as not found', async () => {
    const h = await connectTools([{ path: '/api/product/history', status: 500 }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_price_history', arguments: { product_id: '1' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('not found');
  });

  it('honours range and points', async () => {
    const h = await connectTools([
      { path: '/api/product/history', file: 'hist_all.json' },
      { path: '/api/product/history-section', file: 'hist_section.html' },
    ]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'get_price_history',
      arguments: { product_id: '794250', range: 'all', points: 10 },
    });
    expect((res.structuredContent as Out).series).toHaveLength(10);
  });
});

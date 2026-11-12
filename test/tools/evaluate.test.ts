import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from '../parsers/helpers.js';
import { connectTools, text, type Route } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const routes: Route[] = [
  { path: '/produkt/794250', file: 'prod_794250.html' },
  { path: '/api/product/collectAtStoreCount', json: { counts: [{ shop_id: 25, total: '2' }] } },
  { path: '/api/product/history', file: 'hist_all.json' },
  { path: '/api/product/history-section', file: 'hist_section.html' },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('evaluate_purchase', () => {
  it('recommends buy_now from the site zone and counts requests', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({ name: 'evaluate_purchase', arguments: { product_id: '794250' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.recommendation).toBe('buy_now');
    expect(sc.zone).toMatchObject({ source: 'site', label: 'God pris' });
    expect(sc.cheapest_in_stock).toMatchObject({ shop: 'Skousen', price: 2799 });
    expect(sc.history).toMatchObject({ low_all_time: 2290, vs_90d_low_pct: 0 });
    expect(sc.collect_at_store.total_stores).toBe(2);
    expect(sc.requests_used).toBe(4);
    expect(h.calls).toHaveLength(4);
    expect(h.unexpected).toEqual([]);
    expect(text(res)).toContain('BUY NOW');
    expect(text(res)).toContain('Requests used: 4');

    const again = await h.client.callTool({ name: 'evaluate_purchase', arguments: { product_id: '794250' } });
    expect((again.structuredContent as any).requests_used).toBe(0);
    expect(h.calls).toHaveLength(4);
  });

  it('counts business-only offers when every offer is business-only', async () => {
    const body = fixture('prod_794250.html').replace(/<div class="price-extra price-extra--default">/g, '$&Kun til bedrift ');
    const h = await connectTools([{ path: '/produkt/794250', body }, ...routes.filter((r) => r.path !== '/produkt/794250')]);
    close = h.close;
    const res = await h.client.callTool({ name: 'evaluate_purchase', arguments: { product_id: '794250' } });
    const sc = res.structuredContent as any;
    expect(sc.offers_in_stock).toBeGreaterThan(0);
    expect(sc.cheapest_in_stock).toMatchObject({ business_only: true });
    expect(sc.reasons).toContain('only business (Kun til bedrift) offers');
    expect(sc.reasons).not.toContain('No shop lists it in stock');
  });

  it('continues without history', async () => {
    const h = await connectTools([
      { path: '/api/product/history', status: 500 },
      ...routes.filter((r) => r.path !== '/api/product/history'),
    ]);
    close = h.close;
    const res = await h.client.callTool({ name: 'evaluate_purchase', arguments: { product_id: '794250' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.recommendation).toBe('unknown');
    expect(sc.warnings).toContain('price history unavailable');
    expect(sc.history).toBeUndefined();
    expect(sc.requests_used).toBe(h.calls.length);
  });

  it('reports an unknown product', async () => {
    const h = await connectTools([{ path: '/produkt/1', status: 404 }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'evaluate_purchase', arguments: { product_id: '1' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Product 1 not found');
  });
});

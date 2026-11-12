import { afterEach, describe, expect, it } from 'vitest';
import { connectTools, text } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const routes = [
  { path: '/produkt/4758589', file: 'prod_4758589.html' },
  { path: '/api/product/collectAtStoreCount', json: { counts: [{ shop_id: 25, total: '2' }] } },
];

describe('GODPRIS_BASE_URL', () => {
  it('is used for links in tool output', async () => {
    const h = await connectTools(routes, { env: { GODPRIS_BASE_URL: 'https://example.test' } });
    const res = await h.client.callTool({ name: 'get_product', arguments: { product_id: '4758589' } });
    await h.close();
    const all = JSON.stringify(res.structuredContent) + JSON.stringify(res.content);
    expect(all).toContain('https://example.test/produkt/4758589');
    expect(all).not.toContain('https://godpris.no');
  });
});

describe('get_product', () => {
  it('returns offers, click & collect and never touches /api/services', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_product', arguments: { product_id: '4758589' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { offers: unknown[]; collect_at_store: { total_stores: number }; title: string };
    expect(sc.offers).toHaveLength(8);
    expect(sc.collect_at_store.total_stores).toBe(2);
    expect(h.calls.some((u) => u.pathname.startsWith('/api/services/'))).toBe(false);
    expect(text(res)).toContain('## Offers (8)');
    expect(text(res)).toContain('Kun til bedrift');
  });

  it('makes exactly one request when only offers are included', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({
      name: 'get_product',
      arguments: { product_id: '4758589', include: ['offers'] },
    });
    expect(res.isError).toBeFalsy();
    expect(h.calls).toHaveLength(1);
    expect(res.structuredContent).not.toHaveProperty('specs');
  });

  it('reports unknown products as not found', async () => {
    const h = await connectTools([{ path: '/produkt/1', status: 404 }]);
    close = h.close;
    const res = await h.client.callTool({ name: 'get_product', arguments: { product_id: '1' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Product 1 not found');
  });

  it('accepts a numeric product id', async () => {
    const h = await connectTools([{ path: '/produkt/794250', file: 'prod_794250.html' }]);
    close = h.close;
    const res = await h.client.callTool({
      name: 'get_product',
      arguments: { product_id: 794250, include: ['offers'] },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { id: string }).id).toBe('794250');
  });
});

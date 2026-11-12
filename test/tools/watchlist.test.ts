import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from '../parsers/helpers.js';
import { connectTools, text, type Route } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const cheaper = (price: number) =>
  fixture('prod_794250.html').replaceAll('"price":2799', `"price":${price}`).replaceAll('"lowPrice":2799', `"lowPrice":${price}`)
    .replaceAll('data-price="2799"', `data-price="${price}"`);

type Sc = Record<string, any>;
const call = async (h: Awaited<ReturnType<typeof connectTools>>, name: string, args: Record<string, unknown> = {}) => {
  const res = await h.client.callTool({ name, arguments: args });
  return { res, sc: res.structuredContent as Sc };
};

describe('watchlist tools', () => {
  it('caps a check at 30 items and reports progress per item', async () => {
    const h = await connectTools([{ path: /^\/produkt\/\d+$/, file: 'prod_794250.html' }]);
    close = h.close;
    for (let i = 1; i <= 31; i++) await call(h, 'watchlist_add', { product_id: String(i) });
    const seen: number[] = [];
    const res = await h.client.callTool({ name: 'watchlist_check', arguments: {} }, undefined, {
      onprogress: (p) => seen.push(p.progress),
    });
    const sc = res.structuredContent as Sc;
    expect(sc['checked']).toBe(30);
    expect(sc['warnings'][0]).toContain('30 least recently checked of 31');
    expect(seen).toHaveLength(30);
    expect(seen.at(-1)).toBe(30);
  });

  it('adds with one request, upserts, lists without network and removes', async () => {
    const h = await connectTools([{ path: '/produkt/794250', file: 'prod_794250.html' }]);
    close = h.close;
    const add = await call(h, 'watchlist_add', { product_id: '794250', target_price: 2500, note: 'stovsuger' });
    expect(add.res.isError).toBeFalsy();
    expect(h.calls).toHaveLength(1);
    expect(add.sc).toMatchObject({ created: true, count: 1, target_hit: false });
    expect(add.sc['item']).toMatchObject({ product_id: '794250', last_price: 2799, last_shop: 'Skousen', lowest_seen: 2799, target_price: 2500, note: 'stovsuger' });

    const again = await call(h, 'watchlist_add', { product_id: '794250', target_price: 3000 });
    expect(again.sc).toMatchObject({ created: false, count: 1, target_hit: true });
    expect(again.sc['item']).toMatchObject({ note: 'stovsuger', target_price: 3000 });

    const before = h.calls.length;
    const list = await call(h, 'watchlist_list');
    expect(h.calls.length).toBe(before);
    expect(list.sc['count']).toBe(1);
    expect(text(list.res)).toContain('Innovac');

    const rm = await call(h, 'watchlist_remove', { product_id: '794250' });
    expect(rm.sc).toMatchObject({ removed: true, count: 0 });
    expect((await call(h, 'watchlist_remove', { product_id: '794250' })).sc['removed']).toBe(false);
  });

  it('reports a target hit, a new low and the change on check, then updates state', async () => {
    const routes: Route[] = [{ path: '/produkt/794250', file: 'prod_794250.html' }];
    const h = await connectTools(routes);
    close = h.close;
    await call(h, 'watchlist_add', { product_id: '794250', target_price: 2500 });

    routes[0]!.body = cheaper(2399);
    const { res, sc } = await call(h, 'watchlist_check');
    expect(res.isError).toBeFalsy();
    expect(sc['requests_used']).toBe(1);
    expect(sc['results'][0]).toMatchObject({
      product_id: '794250',
      price: 2399,
      previous_price: 2799,
      change_abs: -400,
      change_pct: -14.3,
      target_hit: true,
      new_low: true,
      lowest_seen: 2399,
    });
    expect(text(res)).toContain('TARGET HIT');

    // second check at the same price: no new low, no change
    const second = (await call(h, 'watchlist_check', { product_ids: ['794250'] })).sc['results'][0];
    expect(second).toMatchObject({ price: 2399, change_abs: 0, new_low: false, target_hit: true });

    const item = (await call(h, 'watchlist_list')).sc['items'][0];
    expect(item).toMatchObject({ last_price: 2399, lowest_seen: 2399 });
  });

  it('continues past item errors and unknown ids', async () => {
    const routes: Route[] = [
      { path: '/produkt/794250', file: 'prod_794250.html' },
      { path: '/produkt/4758589', file: 'prod_4758589.html' },
    ];
    const h = await connectTools(routes);
    close = h.close;
    await call(h, 'watchlist_add', { product_id: '794250' });
    await call(h, 'watchlist_add', { product_id: '4758589' });
    routes[0]!.status = 404;
    const { sc } = await call(h, 'watchlist_check', { product_ids: ['794250', '4758589', '1'] });
    const byId = Object.fromEntries(sc['results'].map((r: Sc) => [r['product_id'], r]));
    expect(byId['794250'].error).toContain('not found');
    expect(byId['4758589'].price).toBe(9171);
    expect(sc['warnings'].join(' ')).toContain('product 1 is not on the watchlist');
    expect(sc['requests_used']).toBe(2);
  });

  it('reports not found when adding an unknown product', async () => {
    const h = await connectTools([{ path: '/produkt/1', status: 404 }]);
    close = h.close;
    const { res } = await call(h, 'watchlist_add', { product_id: '1' });
    expect(res.isError).toBe(true);
  });
});


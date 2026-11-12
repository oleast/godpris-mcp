import { afterEach, describe, expect, it } from 'vitest';
import { parseComparePage } from '../../src/parsers/compare.js';
import { specDifferences } from '../../src/tools/composite/best-options.js';
import { fixture } from '../parsers/helpers.js';
import { connectTools, text, type Route } from './harness.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const routes: Route[] = [
  { path: '/api/product/search', file: 'ac_items.json' },
  { path: '/kategori/1220', file: 'kat_1220.html' },
  { path: '/sammenlign', file: 'sammenlign.html' },
  { path: '/api/product/history', file: 'hist_all.json' },
  { path: '/api/product/history-section', file: 'hist_section.html' },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('specDifferences', () => {
  const page = parseComparePage(fixture('sammenlign.html'));
  it('re-orders values to the requested ids', () => {
    const d = specDifferences(page, ['1588920', '794250']);
    expect(d.rows[0]?.values).toEqual(['', '0.7 L']);
    expect(d.missing_ids).toEqual([]);
    for (const r of d.rows) expect(new Set(r.values.map((v) => v.trim())).size).toBeGreaterThan(1);
  });
  it('returns nothing when no id is on the page', () => {
    const d = specDifferences(page, ['1', '2']);
    expect(d.rows).toEqual([]);
    expect(d.missing_ids).toEqual(['1', '2']);
  });
});

describe('compare_best_options', () => {
  it('picks the top products, compares and summarises history', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({ name: 'compare_best_options', arguments: { category_id: '1220', top_n: 2 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(h.calls.find((u) => u.pathname === '/sammenlign')?.searchParams.get('ids')).toBe('5099462,8394093');
    expect(sc.products).toHaveLength(2);
    for (const p of sc.products) expect(p.history.verdict).toBe('good');
    expect(sc.spec_differences).toEqual([]);
    expect(sc.warnings.some((w: string) => w.includes('other products'))).toBe(true);
    expect(sc.requests_used).toBe(6);
    expect(h.calls).toHaveLength(6);
    expect(h.unexpected).toEqual([]);
  });

  it('resolves the category from a query', async () => {
    const h = await connectTools(routes);
    close = h.close;
    const res = await h.client.callTool({
      name: 'compare_best_options',
      arguments: { query: 'vaskemaskin', top_n: 2, include_history: false },
    });
    const sc = res.structuredContent as any;
    expect(sc.category_id).toBe('1220');
    expect(sc.requests_used).toBe(3);
  });

  it('needs a category or a query', async () => {
    const h = await connectTools([]);
    close = h.close;
    const res = await h.client.callTool({ name: 'compare_best_options', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Give category_id or query.');
  });
});

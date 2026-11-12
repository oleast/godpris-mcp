import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTools } from './harness.js';

type Tool = Awaited<ReturnType<Awaited<ReturnType<typeof connectTools>>['client']['listTools']>>['tools'][number];

let tools: Tool[];
let instructions: string | undefined;
let close: () => Promise<void>;

beforeAll(async () => {
  const h = await connectTools([]);
  tools = (await h.client.listTools()).tools;
  instructions = h.client.getInstructions();
  close = h.close;
});
afterAll(() => close());

const EXPECTED = [
  'search_products',
  'search_listing',
  'list_categories',
  'find_category',
  'get_category_filters',
  'browse_category',
  'get_product',
  'get_price_history',
  'watchlist_add',
  'watchlist_remove',
  'watchlist_list',
  'watchlist_check',
  'list_sitemap',
  'compare_products',
  'get_deals',
  'get_expert_tests',
  'get_gift_ideas',
  'list_stores',
  'get_store',
  'get_trending',
  'evaluate_purchase',
  'find_products_by_requirements',
  'hunt_deals',
  'scan_category',
  'compare_best_options',
];

/** Local tools that change watchlist state; every other tool is read-only. */
const MUTATING = new Set(['watchlist_add', 'watchlist_remove', 'watchlist_check']);

type Schema = Record<string, unknown>;

/** Snake_case words in the server instructions that are parameters or result fields, not tools. */
const INSTRUCTION_FIELDS = new Set([
  'buy_now',
  'all_time_low',
  'unmatched_requirements',
  'available_filters',
  'browse_filters',
  'max_pages',
  'verify_history_top',
  'top_n',
]);

function walk(schema: unknown, visit: (s: Schema, path: string) => void, path = '$'): void {
  if (Array.isArray(schema)) return schema.forEach((s, i) => walk(s, visit, `${path}[${i}]`));
  if (typeof schema !== 'object' || schema === null) return;
  visit(schema as Schema, path);
  for (const [k, v] of Object.entries(schema)) walk(v, visit, `${path}.${k}`);
}

describe('tool schemas', () => {
  it('sends server instructions that only name registered tools', () => {
    const named = instructions?.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    const toolNames = new Set(tools.map((t) => t.name));
    const unknown = named.filter((n) => !toolNames.has(n) && !INSTRUCTION_FIELDS.has(n));
    expect(named.length).toBeGreaterThan(0);
    expect(unknown).toEqual([]);
  });

  it('registers exactly the expected tools with valid names', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
    for (const t of tools) expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });

  it('has 1-3 sentence descriptions, read-only annotations and output schemas', () => {
    for (const t of tools) {
      const sentences = (t.description ?? '').split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
      expect(sentences.length, t.name).toBeGreaterThanOrEqual(1);
      expect(sentences.length, t.name).toBeLessThanOrEqual(3);
      expect(t.annotations?.readOnlyHint, t.name).toBe(!MUTATING.has(t.name));
      expect(t.outputSchema, t.name).toBeDefined();
    }
  });

  it('keeps input schemas flat and portable', () => {
    for (const t of tools) {
      walk(t.inputSchema, (s, path) => {
        for (const bad of ['anyOf', 'oneOf', 'allOf', '$ref']) expect(s, `${t.name} ${path}`).not.toHaveProperty(bad);
        if (typeof s['properties'] === 'object' && s['properties'] !== null) {
          for (const name of Object.keys(s['properties'])) expect(name, `${t.name} ${path}`).toMatch(/^[a-z][a-z0-9_]*$/);
        }
        if (s['type'] === 'integer') {
          expect(Math.abs(Number(s['minimum'])), `${t.name} ${path} min`).toBeLessThan(1e15);
          expect(Math.abs(Number(s['maximum'])), `${t.name} ${path} max`).toBeLessThan(1e15);
        }
      });
      // objects only as array items directly under a top-level property
      const props = (t.inputSchema as { properties?: Record<string, Schema> }).properties ?? {};
      for (const [name, p] of Object.entries(props)) {
        expect(p['type'], `${t.name}.${name}`).not.toBe('object');
        const items = p['items'] as Schema | undefined;
        if (items?.['type'] === 'object') {
          for (const [k, v] of Object.entries((items['properties'] ?? {}) as Record<string, Schema>)) {
            expect(v['type'], `${t.name}.${name}.${k}`).not.toBe('object');
            expect((v['items'] as Schema | undefined)?.['type'], `${t.name}.${name}.${k}`).not.toBe('object');
          }
        }
      }
    }
  });
});

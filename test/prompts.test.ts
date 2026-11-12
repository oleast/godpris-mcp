import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTools } from './tools/harness.js';

let h: Awaited<ReturnType<typeof connectTools>>;
beforeAll(async () => {
  h = await connectTools([]);
});
afterAll(() => h.close());

const messageText = (r: Awaited<ReturnType<typeof h.client.getPrompt>>) =>
  r.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');

describe('prompts', () => {
  it('lists the three prompts with string arguments', async () => {
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['deal-hunt', 'find-by-requirements', 'should-i-buy']);
    const args = Object.fromEntries(prompts.map((p) => [p.name, (p.arguments ?? []).map((a) => a.name)]));
    expect(args).toEqual({
      'deal-hunt': ['what', 'max_price'],
      'should-i-buy': ['product'],
      'find-by-requirements': ['product_type', 'requirements'],
    });
  });

  it('renders deal-hunt', async () => {
    const r = await h.client.getPrompt({ name: 'deal-hunt', arguments: { what: 'robot vacuum', max_price: '4000' } });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.role).toBe('user');
    const t = messageText(r);
    for (const s of ['robot vacuum', '4000', 'find_category', 'hunt_deals', 'get_price_history', 'watchlist_add']) expect(t).toContain(s);
  });

  it('renders deal-hunt without arguments', async () => {
    expect(messageText(await h.client.getPrompt({ name: 'deal-hunt', arguments: {} }))).toContain('hunt_deals');
  });

  it('renders should-i-buy and find-by-requirements', async () => {
    const buy = messageText(await h.client.getPrompt({ name: 'should-i-buy', arguments: { product: 'iPhone 16' } }));
    for (const s of ['iPhone 16', 'search_products', 'evaluate_purchase', 'get_product', 'get_price_history']) expect(buy).toContain(s);
    const find = messageText(
      await h.client.getPrompt({ name: 'find-by-requirements', arguments: { product_type: 'washing machine', requirements: '9 kg' } }),
    );
    for (const s of ['washing machine', '9 kg', 'find_category', 'get_category_filters', 'find_products_by_requirements', 'compare_products', 'browse_category']) {
      expect(find).toContain(s);
    }
    expect(find).not.toContain('compare_best_options');
  });
});

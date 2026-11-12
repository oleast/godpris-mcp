// Live smoke test: real server + real client over an in-memory MCP transport.
// Budget: ~20 requests at 1 req/s. Usage: npm run smoke
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dataDir = await mkdtemp(join(tmpdir(), 'godpris-smoke-'));
process.env.GODPRIS_DATA_DIR = dataDir;

const { createServer } = await import('../src/server.js');

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Row {
  name: string;
  status: Status;
  ms: number;
  detail: string;
}
const rows: Row[] = [];

const server = createServer();
const client = new Client({ name: 'smoke', version: '0.0.0' });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
await client.connect(clientT);
const { tools } = await client.listTools(); // also primes output-schema validation
const toolNames = new Set(tools.map((t) => t.name));

class Skip extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  if (res.isError) {
    const text = (res.content ?? []).map((c: any) => c.text ?? '').join(' ');
    throw new Error(`isError: ${text.slice(0, 300)}`);
  }
  return res;
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  let status: Status = 'PASS';
  let detail = '';
  try {
    detail = await fn();
  } catch (e) {
    if (e instanceof Skip) {
      status = 'SKIP';
      detail = e.message;
    } else {
      status = 'FAIL';
      detail = e instanceof Error ? e.message : String(e);
    }
  }
  const row = { name, status, ms: Date.now() - t0, detail };
  rows.push(row);
  console.log(`[${status}] ${name} (${row.ms} ms) ${detail}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const EXPECTED = [
  'search_products',
  'search_listing',
  'get_product',
  'get_price_history',
  'get_category_filters',
  'browse_category',
  'get_deals',
  'compare_products',
];

await check('tools/list', async () => {
  const missing = EXPECTED.filter((n) => !toolNames.has(n));
  assert(missing.length === 0, `missing tools: ${missing.join(', ')}`);
  return `${tools.length} tools: ${[...toolNames].join(', ')}`;
});

await check('search_products "iphone 16"', async () => {
  const r = await call('search_products', { query: 'iphone 16' });
  const ids = (r.structuredContent?.products ?? []).map((p: any) => String(p.id));
  assert(ids.includes('4758589'), `4758589 not in [${ids.join(',')}]`);
  return `${ids.length} products`;
});

await check('get_product 4758589', async () => {
  const r = await call('get_product', { product_id: '4758589', include: ['offers'] });
  const n = r.structuredContent?.offers?.length ?? 0;
  assert(n >= 2, `offers=${n}`);
  return `${n} offers`;
});

await check('get_price_history 4758589', async () => {
  const r = await call('get_price_history', { product_id: '4758589' });
  const sc = r.structuredContent;
  const series = sc?.series ?? [];
  assert(series.length > 0, 'series empty');
  const v = sc?.verdict?.verdict;
  assert(['good', 'ok', 'maybe', 'expensive', 'unknown'].includes(v), `verdict=${v}`);
  return `${series.length} points, verdict=${v}, source=${sc.verdict.source}`;
});

await check('get_category_filters 1220', async () => {
  const r = await call('get_category_filters', { category_id: '1220' });
  const filters: any[] = r.structuredContent?.filters ?? [];
  const f = filters.find((x) => /vaskekapasitet/i.test(x.label ?? ''));
  assert(f, `no Vaskekapasitet among ${filters.length} filters`);
  return `${filters.length} filters, Vaskekapasitet=${f.key}`;
});

await check('browse_category 1220 f226>=9 price_asc', async () => {
  const r = await call('browse_category', {
    category_id: '1220',
    filters: [{ key: 'f226', min: 9 }],
    sort: 'price_asc',
  });
  const n = r.structuredContent?.items?.length ?? 0;
  assert(n >= 1, `items=${n}`);
  return `${n} items`;
});

await check('search_listing "iphone" price_asc page 2', async () => {
  const r = await call('search_listing', { query: 'iphone', sort: 'price_asc', page: 2 });
  const n = r.structuredContent?.items?.length ?? 0;
  const w = r.structuredContent?.warnings;
  assert(n >= 1, `items=${n}${w ? ` warnings=${JSON.stringify(w)}` : ''}`);
  return `${n} items${w?.length ? ` warnings=${JSON.stringify(w)}` : ''}`;
});

await check('get_deals discount_min 30', async () => {
  const r = await call('get_deals', { discount_min: 30 });
  const items: any[] = r.structuredContent?.items ?? [];
  assert(items.length >= 1, 'no items');
  assert(items.some((i) => i.discount_pct != null), 'no item has discount_pct');
  return `${items.length} items, first discount_pct=${items[0]?.discount_pct}`;
});

await check('compare_products 794250 vs 1588920', async () => {
  const r = await call('compare_products', { product_ids: ['794250', '1588920'] });
  const n = r.structuredContent?.products?.length ?? 0;
  assert(n === 2, `products=${n}`);
  return '2 products';
});

await check('evaluate_purchase 4758589', async () => {
  if (!toolNames.has('evaluate_purchase')) throw new Skip('tool not present');
  const r = await call('evaluate_purchase', { product_id: '4758589' });
  assert(r.structuredContent && typeof r.structuredContent === 'object', 'no structuredContent');
  return `keys: ${Object.keys(r.structuredContent).join(',')}`;
});

await check('find_products_by_requirements vaskemaskin >=9kg', async () => {
  if (!toolNames.has('find_products_by_requirements')) throw new Skip('tool not present');
  const r = await call('find_products_by_requirements', {
    query: 'vaskemaskin',
    requirements: [{ label: 'vaskekapasitet', min: 9 }],
  });
  const applied: any[] = r.structuredContent?.applied_filters ?? [];
  assert(applied.some((f) => f.key === 'f226'), `applied_filters=${JSON.stringify(applied).slice(0, 200)}`);
  return `applied f226; keys: ${Object.keys(r.structuredContent).join(',')}`;
});

for (const n of ['hunt_deals', 'compare_best_options']) {
  await check(`${n} (presence only)`, async () => {
    if (!toolNames.has(n)) throw new Skip('tool not present');
    return 'present (not exercised)';
  });
}

await client.close();
await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);

const w = Math.max(...rows.map((r) => r.name.length));
console.log('\nSummary');
for (const r of rows) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${String(r.ms).padStart(6)} ms`);
const fails = rows.filter((r) => r.status === 'FAIL').length;
console.log(
  `\n${rows.filter((r) => r.status === 'PASS').length} passed, ${fails} failed, ${rows.filter((r) => r.status === 'SKIP').length} skipped`,
);
process.exit(fails ? 1 : 0);

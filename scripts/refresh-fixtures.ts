// Re-download test fixtures listed in test/fixtures/README.md.
// Usage: npm run refresh-fixtures -- [--dry-run] [--only name1,name2]
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.js';
import { GodprisClient } from '../src/http/client.js';

interface Fixture {
  file: string;
  path: string;
  json?: boolean;
  trim?: number;
}

const FIXTURES: Fixture[] = [
  { file: 'home.html', path: '/' },
  { file: 'kat_1220.html', path: '/kategori/1220' },
  { file: 'kat1220_p2.html', path: '/kategori/1220?page=2' },
  { file: 'kat1220_price_asc.html', path: '/kategori/1220?s=price_asc' },
  { file: 'kat_449.html', path: '/kategori/449' },
  { file: 'search_vask.html', path: '/sok?q=vaskemaskin' },
  { file: 'search_iphone.html', path: '/sok?q=iphone' },
  { file: 'sok_fragment.html', path: '/sok?q=iphone&o=32&l=32&fragment=1' },
  { file: 'tilbud.html', path: '/tilbud' },
  { file: 'gavetips1.html', path: '/gavetips/1' },
  { file: 'carousel_offers.html', path: '/api/carousel/frontpage/offers' },
  { file: 'tester.html', path: '/tester' },
  { file: 'butikk.html', path: '/butikk' },
  { file: 'butikk25.html', path: '/butikk/25' },
  { file: 'prod_794250.html', path: '/produkt/794250' },
  { file: 'prod_20855452.html', path: '/produkt/20855452' },
  { file: 'prod_4758589.html', path: '/produkt/4758589' },
  { file: 'sammenlign.html', path: '/sammenlign?ids=794250,1588920' },
  { file: 'hist_all.json', path: '/api/product/history?id=i_794250&market_id=1&all=1', json: true },
  { file: 'hist_section.html', path: '/api/product/history-section?id=i_794250&market_id=1' },
  { file: 'ac_iphone.json', path: '/api/product/search?q=iphone', json: true },
  { file: 'ac_wilfa.json', path: '/api/product/search?q=wilfa', json: true },
  { file: 'ac_items.json', path: '/api/product/search?q=vask', json: true },
  { file: 'sitemap.xml', path: '/sitemap.xml' },
  { file: 'sitemap.static.xml', path: '/sitemap.static.xml' },
  { file: 'sitemap.categories.xml', path: '/sitemap.categories.xml', trim: 20 },
  { file: 'sitemap.shops.xml', path: '/sitemap.shops.xml', trim: 20 },
  { file: 'sitemap.items.xml', path: '/sitemaps/sitemap.items.0.xml', trim: 20 },
];
// Skipped (source is "another product", not a fixed URL): hist_other.json, hist_section_other.html

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
const selected = FIXTURES.filter((f) => !only || only.has(f.file) || only.has(f.file.replace(/\.[^.]+$/, '')));

if (only) {
  const known = new Set(FIXTURES.flatMap((f) => [f.file, f.file.replace(/\.[^.]+$/, '')]));
  const unknown = [...only].filter((n) => !known.has(n));
  if (unknown.length) {
    console.error(`Unknown fixture(s): ${unknown.join(', ')}`);
    process.exit(2);
  }
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

function trimSitemap(xml: string, n: number): string {
  const re = /<url>[\s\S]*?<\/url>/g;
  const matches = [...xml.matchAll(re)];
  if (matches.length <= n) return xml;
  const first = matches[0]!.index!;
  const last = matches[n - 1]!;
  const end = last.index! + last[0].length;
  const tail = xml.slice(xml.lastIndexOf('</url>') + '</url>'.length);
  return xml.slice(0, first) + xml.slice(first, end) + tail;
}

console.log(`${dryRun ? 'Would fetch' : 'Fetching'} ${selected.length} fixture(s) from https://godpris.no`);
if (dryRun) {
  for (const f of selected) console.log(`  ${f.file.padEnd(26)} ${f.path}${f.trim ? `  (trim to ${f.trim} <url>)` : ''}`);
  process.exit(0);
}

const client = new GodprisClient({ baseUrl: createConfig().baseUrl, rps: 1 });
const refreshed: string[] = [];
let failed = 0;

for (const f of selected) {
  try {
    let body = f.json ? JSON.stringify(await client.getJson(f.path, { noCache: true })) : await client.getHtml(f.path, { noCache: true });
    if (f.trim) body = trimSitemap(body, f.trim);
    const target = join(dir, f.file);
    const old = existsSync(target) ? await readFile(target, 'utf8') : undefined;
    const status = old === undefined ? 'new' : old === body ? 'unchanged' : 'changed';
    if (status !== 'unchanged') await writeFile(target, body);
    if (status !== 'unchanged') refreshed.push(f.file);
    console.log(`  ${status.padEnd(9)} ${f.file.padEnd(26)} ${old?.length ?? 0} -> ${body.length} bytes`);
  } catch (e) {
    failed++;
    console.error(`  FAILED    ${f.file}: ${e instanceof Error ? e.message : e}`);
  }
}

const today = new Date().toISOString().slice(0, 10);
if (refreshed.length) {
  console.log(`\nReminder: update the "fetched" date in test/fixtures/README.md to ${today} for: ${refreshed.join(', ')}`);
}
process.exit(failed ? 1 : 0);

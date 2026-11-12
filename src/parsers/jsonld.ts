import * as cheerio from 'cheerio';
import { categoryIdFromHref, productIdFromHref } from './util.js';

export type JsonLdNode = Record<string, unknown>;

export interface JsonLdResult {
  blocks: JsonLdNode[];
  warnings: string[];
}

function isNode(v: unknown): v is JsonLdNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Extract every JSON-LD block (arrays and @graph flattened). Bad JSON becomes a warning. */
export function extractJsonLd(html: string): JsonLdResult {
  const $ = cheerio.load(html);
  const blocks: JsonLdNode[] = [];
  const warnings: string[] = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    const raw = $(el).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      warnings.push(`Invalid JSON-LD block #${i + 1}: ${(e as Error).message}`);
      return;
    }
    const push = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(push);
      if (!isNode(v)) return;
      const graph = v['@graph'];
      if (Array.isArray(graph)) graph.forEach(push);
      else blocks.push(v);
    };
    push(parsed);
  });
  return { blocks, warnings };
}

/** All blocks whose @type equals (or includes) the given type. */
export function findByType(blocks: JsonLdNode[], type: string): JsonLdNode[] {
  return blocks.filter((b) => {
    const t = b['@type'];
    return Array.isArray(t) ? t.includes(type) : t === type;
  });
}

export interface JsonLdCrumb {
  name: string;
  url?: string;
  /** Numeric category id when the crumb links to /kategori/{id}. */
  id?: string;
}

/** BreadcrumbList -> ordered crumbs (empty when absent). */
export function parseBreadcrumbs(blocks: JsonLdNode[]): JsonLdCrumb[] {
  const list = findByType(blocks, 'BreadcrumbList')[0];
  const items = list?.['itemListElement'];
  if (!Array.isArray(items)) return [];
  const crumbs: Array<JsonLdCrumb & { pos: number }> = [];
  for (const it of items) {
    if (!isNode(it)) continue;
    const item = it['item'];
    const url = typeof item === 'string' ? item : isNode(item) ? (item['@id'] as string | undefined) : undefined;
    const name = typeof it['name'] === 'string' ? it['name'] : isNode(item) && typeof item['name'] === 'string' ? item['name'] : '';
    if (!name) continue;
    const crumb: JsonLdCrumb & { pos: number } = { name, pos: Number(it['position']) || crumbs.length + 1 };
    if (url) {
      crumb.url = url;
      const id = categoryIdFromHref(url);
      if (id) crumb.id = id;
    }
    crumbs.push(crumb);
  }
  return crumbs.sort((a, b) => a.pos - b.pos).map(({ pos: _pos, ...c }) => c);
}

export interface JsonLdItemList {
  total?: number;
  urls: string[];
  /** Product ids parsed from /produkt/{id} urls, in order. */
  productIds: string[];
}

/** ItemList (listing pages) -> urls and product ids; undefined when no ItemList block exists. */
export function parseItemList(blocks: JsonLdNode[]): JsonLdItemList | undefined {
  const list = findByType(blocks, 'ItemList')[0];
  if (!list) return undefined;
  const items = Array.isArray(list['itemListElement']) ? list['itemListElement'] : [];
  const urls: string[] = [];
  for (const it of items) {
    if (!isNode(it)) continue;
    const u = it['url'] ?? (isNode(it['item']) ? it['item']['url'] : it['item']);
    if (typeof u === 'string') urls.push(u);
  }
  const productIds = urls.map(productIdFromHref).filter((x): x is string => !!x);
  const n = Number(list['numberOfItems']);
  return { ...(Number.isFinite(n) ? { total: n } : {}), urls, productIds };
}

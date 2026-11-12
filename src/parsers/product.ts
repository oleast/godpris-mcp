import * as cheerio from 'cheerio';
import type { CategoryRef } from './category.js';
import { extractJsonLd, findByType, parseBreadcrumbs, type JsonLdNode } from './jsonld.js';
import { clean, parseNok, productIdFromHref } from './util.js';

export interface ProductOffer {
  shop: string;
  price: number;
  availability?: string;
  in_stock?: boolean;
  business_only: boolean;
  item_title?: string;
  merchant_url?: string;
  shop_item_id?: string;
}
export interface ProductVariantOption {
  dimension: string;
  label: string;
  id: string;
  selected: boolean;
}
export interface ProductSpec {
  group: string;
  name: string;
  value: string;
}
export interface ProductTest {
  outlet: string;
  title?: string;
  quote?: string;
  rating_value?: number;
  rating_max?: number;
  url?: string;
}
export interface ProductAlternative {
  id: string;
  title: string;
  brand?: string;
  price?: number;
  discount_pct?: number;
  record_low: boolean;
  url: string;
}
export interface ProductPage {
  id?: string;
  title: string;
  brand?: string;
  url?: string;
  category_id?: string;
  group_id?: string;
  gtin?: string;
  mpn?: string;
  image?: string;
  breadcrumbs: CategoryRef[];
  price_low?: number;
  price_high?: number;
  offer_count?: number;
  discount_pct?: number;
  record_low: boolean;
  highlights: string[];
  offers: ProductOffer[];
  variants: ProductVariantOption[];
  specs: ProductSpec[];
  tests: ProductTest[];
  alternatives: ProductAlternative[];
  lowest_price?: number;
  lowest_shop?: string;
  warnings: string[];
}

function isNode(v: unknown): v is JsonLdNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const asNum = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Decode ONLY the `u=` merchant URL of a godpris click URL. The click URL itself is never fetched. */
export function merchantUrlFromClickUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href, 'https://godpris.no').searchParams.get('u');
    if (!u) return undefined;
    return /^https?:\/\//i.test(u) ? u : undefined;
  } catch {
    return undefined;
  }
}

export function parseCollectAtStoreCounts(json: unknown): Array<{ shop_id: string; stores: number }> {
  const counts = isNode(json) ? json['counts'] : undefined;
  if (!Array.isArray(counts)) return [];
  const out: Array<{ shop_id: string; stores: number }> = [];
  for (const c of counts) {
    if (!isNode(c)) continue;
    const id = c['shop_id'];
    const total = asNum(c['total']);
    if ((typeof id === 'number' || typeof id === 'string') && total !== undefined) {
      out.push({ shop_id: String(id), stores: total });
    }
  }
  return out;
}

interface LdOffer {
  url?: string;
  availability?: string;
  seller?: string;
  price?: number;
}

function ldOffers(node: JsonLdNode | undefined): { offers: LdOffer[]; agg?: JsonLdNode } {
  const agg = node && isNode(node['offers']) ? node['offers'] : undefined;
  const list = agg && Array.isArray(agg['offers']) ? agg['offers'] : [];
  const offers: LdOffer[] = [];
  for (const o of list) {
    if (!isNode(o)) continue;
    const seller = isNode(o['seller']) ? asStr(o['seller']['name']) : undefined;
    const availability = asStr(o['availability'])?.replace(/^.*\//, '');
    const price = asNum(o['price']);
    offers.push({
      ...(asStr(o['url']) ? { url: asStr(o['url']) as string } : {}),
      ...(availability ? { availability } : {}),
      ...(seller ? { seller } : {}),
      ...(price !== undefined ? { price: Math.round(price) } : {}),
    });
  }
  return { offers, ...(agg ? { agg } : {}) };
}

function inStockFrom(ld: string | undefined, text: string | undefined): boolean | undefined {
  if (ld === 'InStock') return true;
  if (ld === 'BackOrder' || ld === 'OutOfStock' || ld === 'PreOrder') return false;
  if (text) return /på lager/i.test(text) ? true : undefined;
  return undefined;
}

export function parseProductPage(html: string): ProductPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const { blocks } = extractJsonLd(html);

  const id =
    $('[data-product-id]').first().attr('data-product-id') ?? productIdFromHref($('link[rel="canonical"]').attr('href'));
  const category_id = $('[data-category-id]').first().attr('data-category-id') || undefined;
  const group_id = $('[data-group-id]').first().attr('data-group-id') || undefined;

  // JSON-LD product node: plain Product, or the ProductGroup variant that has offers.
  let node = findByType(blocks, 'Product')[0];
  const variantFallback: Array<{ url: string; dimension: string; label: string }> = [];
  if (!node) {
    const group = findByType(blocks, 'ProductGroup')[0];
    const variants = group && Array.isArray(group['hasVariant']) ? group['hasVariant'].filter(isNode) : [];
    const withOffers = variants.filter((v) => isNode(v['offers']));
    node =
      withOffers.find((v) => ldOffers(v).offers.some((o) => id && o.url?.includes(`i=${id}`))) ??
      withOffers.find((v) => isNode(v['offers']) && asStr(v['offers']['url'])?.endsWith(`/produkt/${id}`)) ??
      withOffers[0];
    if (group && !node && !variants.length) node = group;
    for (const v of variants) {
      const url = asStr(v['url']);
      if (!url) continue;
      for (const [k, val] of Object.entries(v)) {
        if (k === '@type' || k === 'url') continue;
        if (typeof val === 'string') variantFallback.push({ url, dimension: k, label: val });
      }
    }
  }
  const ld = ldOffers(node);

  const h1 = $('h1.title').first();
  const brandEl = h1.find('.brand').first();
  const h1Brand = clean(brandEl.text());
  const h1Title = clean(h1.clone().find('.brand').remove().end().text());
  const title = asStr(node?.['name']) ?? h1Title;
  if (!asStr(node?.['name'])) warnings.push('Product title taken from page heading (no JSON-LD name)');
  const brandNode = node?.['brand'];
  const brand = (isNode(brandNode) ? asStr(brandNode['name']) : asStr(brandNode)) ?? (h1Brand || undefined);

  const imageRaw = node?.['image'];
  const image = Array.isArray(imageRaw) ? asStr(imageRaw[0]) : asStr(imageRaw);

  const breadcrumbs: CategoryRef[] = parseBreadcrumbs(blocks)
    .filter((c): c is typeof c & { id: string } => !!c.id)
    .map((c) => ({ id: c.id, name: c.name }));

  // discount / record low
  const badgeArea = $('.badge-area').first();
  const badgeText = clean(badgeArea.find('.app-offer-badge .sr-only').first().text()) || clean(badgeArea.text());
  const dm = /(\d+)\s*%/.exec(badgeText);
  const discount_pct = dm?.[1] ? Number(dm[1]) : undefined;
  const record_low = /rekordbillig/i.test(badgeArea.text());

  const highlights: string[] = [];
  $('.featured-props-list li .prop').each((_, el) => {
    const t = clean($(el).text());
    if (t) highlights.push(t);
  });

  // offers
  const ldBySi = new Map<string, LdOffer>();
  for (const o of ld.offers) {
    try {
      const si = o.url ? new URL(o.url, 'https://godpris.no').searchParams.get('si') : null;
      if (si) ldBySi.set(si, o);
    } catch {
      /* ignore */
    }
  }
  let rows = $('[data-price-panel="prices"] [data-price-row]');
  if (!rows.length) rows = $('[data-price-row]');
  const offers: ProductOffer[] = [];
  rows.each((_, el) => {
    const row = $(el);
    const shop = clean(row.attr('data-shop'));
    const price = parseNok(row.attr('data-price'));
    if (!shop || price === undefined) {
      warnings.push('Skipped a price row without shop or price');
      return;
    }
    const href = row.find('a[data-click-url]').first().attr('href');
    let si: string | undefined;
    try {
      si = href ? (new URL(href, 'https://godpris.no').searchParams.get('si') ?? undefined) : undefined;
    } catch {
      si = undefined;
    }
    const ldo = si ? ldBySi.get(si) : undefined;
    const extra = row.find('.price-extra--default').first();
    const availability = clean(extra.find('.availability').first().find('span').first().text()) ||
      clean(extra.find('.availability').first().attr('title')) || undefined;
    const merchant_url = merchantUrlFromClickUrl(ldo?.url);
    const item_title = clean(row.find('.item-title').first().attr('title')) || clean(row.find('.item-title').first().text());
    const in_stock = inStockFrom(ldo?.availability, availability);
    const offer: ProductOffer = {
      shop,
      price,
      business_only: /kun til bedrift/i.test(extra.text()),
      ...(availability ? { availability } : {}),
      ...(in_stock !== undefined ? { in_stock } : {}),
      ...(item_title ? { item_title } : {}),
      ...(merchant_url ? { merchant_url } : {}),
      ...(si ? { shop_item_id: si } : {}),
    };
    offers.push(offer);
  });
  if (!offers.length && ld.offers.length) {
    warnings.push('Offers built from JSON-LD (price rows not found on page)');
    for (const o of ld.offers) {
      if (!o.seller || o.price === undefined) continue;
      let si: string | undefined;
      try {
        si = o.url ? (new URL(o.url, 'https://godpris.no').searchParams.get('si') ?? undefined) : undefined;
      } catch {
        si = undefined;
      }
      const merchant_url = merchantUrlFromClickUrl(o.url);
      const in_stock = inStockFrom(o.availability, undefined);
      offers.push({
        shop: o.seller,
        price: o.price,
        business_only: false,
        ...(o.availability ? { availability: o.availability } : {}),
        ...(in_stock !== undefined ? { in_stock } : {}),
        ...(merchant_url ? { merchant_url } : {}),
        ...(si ? { shop_item_id: si } : {}),
      });
    }
  }

  // variants
  const variants: ProductVariantOption[] = [];
  $('#varianter')
    .nextAll('.app-property-box')
    .first()
    .find('.key-value-wrapper')
    .each((_, el) => {
      const w = $(el);
      const dimension = clean(w.find('dt.key').first().text());
      w.find('.values a[href*="/produkt/"]').each((__, a) => {
        const vid = productIdFromHref($(a).attr('href'));
        if (!vid) return;
        variants.push({ dimension, label: clean($(a).text()), id: vid, selected: vid === id });
      });
    });
  if (!variants.length) {
    for (const v of variantFallback) {
      const vid = productIdFromHref(v.url);
      if (vid) variants.push({ dimension: v.dimension, label: v.label, id: vid, selected: vid === id });
    }
  }

  // specs
  const specs: ProductSpec[] = [];
  $('#egenskaper')
    .nextAll('.app-property-box')
    .first()
    .find('.prop-group')
    .each((_, g) => {
      const group = clean($(g).find('.prop-group-name').first().text());
      $(g)
        .find('.key-value-wrapper')
        .each((__, kv) => {
          const w = $(kv);
          const name = clean(w.find('dt.key').first().text());
          const values = w.find('.values').first();
          const bool = values.find('svg.bool').first();
          const value = bool.length ? clean(bool.attr('aria-label')) : clean(values.text());
          if (name && value) specs.push({ group, name, value });
        });
    });

  // tests
  const tests: ProductTest[] = [];
  $('.test-section a.review-card').each((_, a) => {
    const c = $(a);
    const outlet = clean(c.find('.review-card__site').first().text());
    if (!outlet) return;
    const t: ProductTest = { outlet };
    const title = clean(c.find('.review-card__title').first().text());
    if (title) t.title = title;
    const quote = clean(c.find('.review-card__quote').first().text().replace(/[«»]/g, ''));
    if (quote) t.quote = quote;
    const ratingText = clean(c.find('.review-card__badge img[alt]').first().attr('alt')) ||
      clean(c.find('.review-card__badge .sr-only').first().text());
    const m = /([\d.,]+)\s*av\s*([\d.,]+)/i.exec(ratingText);
    if (m?.[1] && m[2]) {
      const v = Number(m[1].replace(',', '.'));
      const mx = Number(m[2].replace(',', '.'));
      if (Number.isFinite(v) && Number.isFinite(mx)) {
        t.rating_value = v;
        t.rating_max = mx;
      }
    }
    const href = c.attr('href');
    if (href) t.url = href;
    tests.push(t);
  });

  // alternatives
  const alternatives: ProductAlternative[] = [];
  $('[data-similar-products] li.item-wrapper').each((_, li) => {
    const w = $(li);
    const a = w.find('a.title-wrapper').first();
    const aid = productIdFromHref(a.attr('href'));
    const atitle = clean(a.find('span.title').first().text());
    if (!aid || !atitle) return;
    const badges = w.find('.app-offer-badge');
    const rec = badges.toArray().some((b) => /rekordbillig/i.test($(b).text()));
    const dtext = clean(w.find('.app-offer-badge .sr-only').first().text());
    const dmatch = /(\d+)\s*%/.exec(dtext);
    const abrand = clean(a.find('.brand').first().text());
    const aprice = parseNok(w.find('.price a span').first().text());
    alternatives.push({
      id: aid,
      title: atitle,
      ...(abrand ? { brand: abrand } : {}),
      ...(aprice !== undefined ? { price: aprice } : {}),
      ...(dmatch?.[1] ? { discount_pct: Number(dmatch[1]) } : {}),
      record_low: rec,
      url: `https://godpris.no/produkt/${aid}`,
    });
  });

  // history config
  let lowest_price: number | undefined;
  let lowest_shop: string | undefined;
  const cfg = $('[data-history-graph]').first().attr('data-history-graph');
  if (cfg) {
    try {
      const j = JSON.parse(cfg) as Record<string, unknown>;
      lowest_price = asNum(j['lowestPrice']);
      lowest_shop = asStr(j['lowestShop']);
    } catch {
      warnings.push('Bad history config JSON');
    }
  }

  const url = id ? `https://godpris.no/produkt/${id}` : undefined;
  const aggNode = ld.agg;
  const lowPrice = asNum(aggNode?.['lowPrice']);
  const highPrice = asNum(aggNode?.['highPrice']);
  const offerCount = asNum(aggNode?.['offerCount']);
  const gtin = asStr(node?.['gtin']) ?? asStr(node?.['gtin13']);
  const mpn = asStr(node?.['mpn']);

  return {
    ...(id ? { id } : {}),
    title,
    ...(brand ? { brand } : {}),
    ...(url ? { url } : {}),
    ...(category_id ? { category_id } : {}),
    ...(group_id ? { group_id } : {}),
    ...(gtin ? { gtin } : {}),
    ...(mpn ? { mpn } : {}),
    ...(image ? { image } : {}),
    breadcrumbs,
    ...(lowPrice !== undefined ? { price_low: Math.round(lowPrice) } : {}),
    ...(highPrice !== undefined ? { price_high: Math.round(highPrice) } : {}),
    ...(offerCount !== undefined ? { offer_count: offerCount } : {}),
    ...(discount_pct !== undefined ? { discount_pct } : {}),
    record_low,
    highlights,
    offers,
    variants,
    specs,
    tests,
    alternatives,
    ...(lowest_price !== undefined ? { lowest_price } : {}),
    ...(lowest_shop ? { lowest_shop } : {}),
    warnings,
  };
}

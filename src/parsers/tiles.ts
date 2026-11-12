import * as cheerio from 'cheerio';
import { absoluteUrl, BASE_URL, clean, parseCount, parseNok, productIdFromHref } from './util.js';

export interface ListingRating {
  value: number;
  max: number;
  source: string;
}

export interface ListingItem {
  id: string;
  title: string;
  brand?: string;
  /** Lowest price, integer NOK. */
  price?: number;
  shop_count?: number;
  discount_pct?: number;
  record_low: boolean;
  rating?: ListingRating;
  url: string;
  image?: string;
  /** Short spec summary shown on the tile. */
  properties?: string;
  /** Shop name (deal tiles only). */
  offer_shop?: string;
}

export interface TilesResult {
  items: ListingItem[];
  warnings: string[];
}

function num(s: string): number {
  return Number(s.replace(',', '.'));
}

/** Parse product tiles (`.search-item`) from any listing page or HTML fragment. */
export function parseProductTiles(html: string): TilesResult {
  const $ = cheerio.load(html);
  const items: ListingItem[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  $('.search-item').each((i, el) => {
    const tile = $(el);
    const a = tile.find('h3 a[href*="/produkt/"]').first();
    const id =
      productIdFromHref(a.attr('href')) ??
      tile.attr('data-compare-item') ??
      tile.find('[data-add-to-list]').first().attr('data-add-to-list');
    if (!id || !/^\d+$/.test(id)) {
      warnings.push(`Tile #${i + 1}: no product id`);
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);

    const title = clean(a.attr('title')) || clean(a.clone().find('.search-item__hidden').remove().end().text());
    if (!title) warnings.push(`Product ${id}: no title`);

    const item: ListingItem = { id, title, record_low: false, url: `${BASE_URL}/produkt/${id}` };

    const brand = clean(tile.find('.product-info .font-semibold').first().text());
    if (brand) item.brand = brand;

    const shopLink = tile.find('[data-price]').first();
    const price = parseNok(tile.find('.price-label').first().text()) ?? parseNok(shopLink.attr('data-price'));
    if (price !== undefined) item.price = price;
    else warnings.push(`Product ${id}: no price`);
    const shop = clean(shopLink.attr('data-shop'));
    if (shop) item.offer_shop = shop;

    const count = parseCount(tile.find('.search-item__price-count').first().text());
    if (count !== undefined) item.shop_count = count;

    const badges = tile.find('.app-offer-badge');
    badges.each((_, b) => {
      const text = clean($(b).text());
      if (/rekordbillig/i.test(text)) item.record_low = true;
      const m = /(\d+)\s*%/.exec(clean($(b).find('.sr-only').first().text()) || text);
      if (m?.[1] && item.discount_pct === undefined) item.discount_pct = Number(m[1]);
    });

    const ratingText = clean(tile.find('.app-testbadge-wrapper-icon .sr-only').first().text());
    const rm = /^(.*?):\s*([\d.,]+)\s+av\s+([\d.,]+)/i.exec(ratingText);
    if (rm?.[1] && rm[2] && rm[3]) item.rating = { source: rm[1].trim(), value: num(rm[2]), max: num(rm[3]) };

    const src = tile.find('img.search-item-image').first().attr('src');
    const image = absoluteUrl(src);
    if (image) item.image = image;

    const props = clean(tile.find('.property-wrapper p').first().text());
    if (props) item.properties = props;

    items.push(item);
  });

  return { items, warnings };
}

export interface ListingMeta {
  total?: number;
  page: number;
  has_next: boolean;
  /** Absolute URL of the next page (rel=next) or "load more" fragment, when present. */
  next_url?: string;
  heading?: string;
}

/** Parse result count, current page, next-page presence and heading of a listing page. */
export function parseListingMeta(html: string): ListingMeta {
  const $ = cheerio.load(html);
  const total =
    parseCount($('.search-count').first().text()) ?? parseCount($('[data-swap-announce]').first().text());

  const pageText = $('.pagination__page[aria-current="page"]').first().text();
  const page = parseCount(pageText) ?? 1;

  const next = $('link[rel="next"], a[rel="next"]').first().attr('href');
  const more = $('[data-load-more] [data-append-url]').first().attr('data-append-url');
  const next_url = absoluteUrl(next ?? more);

  const heading =
    clean($('.search-heading').first().text()) ||
    clean($('h1').first().clone().children().remove().end().text()) ||
    undefined;

  return {
    ...(total !== undefined ? { total } : {}),
    page,
    has_next: !!next_url,
    ...(next_url ? { next_url } : {}),
    ...(heading ? { heading } : {}),
  };
}

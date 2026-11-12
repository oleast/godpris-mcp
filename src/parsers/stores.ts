import * as cheerio from 'cheerio';
import { parseProductTiles, type ListingItem } from './tiles.js';
import { clean } from './util.js';

export interface StoreRef {
  id: string;
  name: string;
  url: string;
}

export interface StoreList {
  stores: StoreRef[];
  has_next: boolean;
  warnings: string[];
}

/** Parse the /butikk directory page: shop links and whether a "Neste" page link exists. */
export function parseStoreList(html: string): StoreList {
  const $ = cheerio.load(html);
  const stores: StoreRef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  $('.app-shop-list ul li a[href*="/butikk/"]').each((_, el) => {
    const a = $(el);
    const id = /\/butikk\/(\d+)/.exec(a.attr('href') ?? '')?.[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name =
      clean(a.attr('title')).replace(/^Besøk butikksiden til\s+/i, '') ||
      clean(a.find('span.text-xs').first().text()).replace(/^Se info til\s+/i, '');
    if (!name) warnings.push(`Store ${id}: no name`);
    stores.push({ id, name, url: `https://godpris.no/butikk/${id}` });
  });
  const has_next = $('nav[aria-label="Sider"] a').toArray().some((a) => /^Neste/i.test(clean($(a).text())));
  if (!stores.length) warnings.push('No stores found on page');
  return { stores, has_next, warnings };
}

export interface StorePage {
  name: string;
  website?: string;
  org_number?: string;
  contact: { email?: string; phone?: string; website?: string };
  popular_products: ListingItem[];
  warnings: string[];
}

/** Parse a /butikk/{id} page: name, website, org number, customer-service contact and popular products. */
export function parseStorePage(html: string): StorePage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const name = clean($('[data-shop]').first().attr('data-shop')) || clean($('h1 .sr-only').first().text());
  if (!name) warnings.push('Store name not found');

  let website: string | undefined;
  let org_number: string | undefined;
  $('.page-top div').each((_, el) => {
    const d = $(el);
    if (d.children('div').length) return; // leaf label/value blocks only
    const label = clean(d.clone().children().remove().end().text());
    const link = clean(d.find('a').first().text());
    if (!link) return;
    if (/^Nettbutikk:/i.test(label)) website ??= link;
    else if (/^Org nummer:/i.test(label)) org_number ??= link;
  });

  const contact: StorePage['contact'] = {};
  $('.page-middle li').each((_, li) => {
    const item = $(li);
    const label = clean(item.clone().children().remove().end().text());
    const value = clean(item.find('a').first().text());
    if (!value) return;
    if (/^Epost:/i.test(label)) contact.email = value;
    else if (/^Telefon:/i.test(label)) contact.phone = value;
    else if (/^Nettside:/i.test(label)) contact.website = value;
  });

  const tiles = parseProductTiles(html);
  warnings.push(...tiles.warnings);
  return {
    name,
    ...(website ? { website } : {}),
    ...(org_number ? { org_number } : {}),
    contact,
    popular_products: tiles.items,
    warnings,
  };
}

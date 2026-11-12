import * as cheerio from 'cheerio';
import { clean, parseNok, productIdFromHref } from './util.js';

export interface CompareProduct {
  id: string;
  title: string;
  brand?: string;
  price?: number;
  url: string;
}

export interface CompareRow {
  group?: string;
  name: string;
  /** One value per product, aligned with `products`; "" when unknown or missing. */
  values: string[];
}

export interface ComparePage {
  products: CompareProduct[];
  rows: CompareRow[];
  warnings: string[];
}

/** Parse /sammenlign: product columns (thead) and spec rows (tbody, grouped by colgroup headers). */
export function parseComparePage(html: string): ComparePage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const products: CompareProduct[] = [];

  $('table thead th[scope="col"]').each((_, th) => {
    const col = $(th);
    const a = col.find('a[href*="/produkt/"]').first();
    const id = productIdFromHref(a.attr('href'));
    if (!id) return void warnings.push('Compare column without a product link');
    const brand = clean(a.find('span').first().text());
    const title = clean(a.find('span').eq(1).text()) || clean(a.attr('title'));
    const price = parseNok(clean(col.find('div.font-normal span').first().text()));
    products.push({
      id,
      title,
      ...(brand ? { brand } : {}),
      ...(price !== undefined ? { price } : {}),
      url: `https://godpris.no/produkt/${id}`,
    });
  });

  const rows: CompareRow[] = [];
  let group: string | undefined;
  $('table tbody tr').each((_, tr) => {
    const row = $(tr);
    const groupHead = row.children('th[scope="colgroup"]').first();
    if (groupHead.length) {
      group = clean(groupHead.text()) || undefined;
      return;
    }
    const nameCell = row.children('th[scope="row"]').first();
    if (!nameCell.length) return;
    const values = row
      .children('td')
      .map((__, td) => {
        const cell = $(td);
        const bool = cell.find('svg[aria-label]').first().attr('aria-label');
        const v = bool ? clean(bool) : clean(cell.text());
        return /^ukjent$/i.test(v) ? '' : v;
      })
      .get();
    rows.push({ ...(group ? { group } : {}), name: clean(nameCell.text()), values });
  });

  if (!products.length) warnings.push('No products found on the compare page');
  return { products, rows, warnings };
}

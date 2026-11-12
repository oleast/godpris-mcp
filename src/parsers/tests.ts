import * as cheerio from 'cheerio';
import { clean, categoryIdFromHref, productIdFromHref } from './util.js';

export interface ExpertTest {
  product_id: string;
  product_title: string;
  outlet: string;
  quote?: string;
  rating_value?: number;
  rating_max?: number;
  /** ISO date (YYYY-MM-DD) of the review. */
  date?: string;
  review_url?: string;
  category_id?: string;
  category_name?: string;
}

export interface ExpertTestsResult {
  tests: ExpertTest[];
  warnings: string[];
}

function num(s: string): number {
  return Number(s.replace(',', '.'));
}

function stripTracking(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href);
    u.searchParams.delete('utm_source');
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Parse expert review items (`.app-critic-review-item`) from /tester or its "load more" fragment. */
export function parseExpertTests(html: string): ExpertTestsResult {
  const $ = cheerio.load(html);
  const tests: ExpertTest[] = [];
  const warnings: string[] = [];

  $('.app-critic-review-item').each((i, el) => {
    const item = $(el);
    const a = item.find('h3 a[href*="/produkt/"]').first();
    const product_id = productIdFromHref(a.attr('href'));
    if (!product_id) return void warnings.push(`Test #${i + 1}: no product id`);

    const review = item.find('a.review').first();
    const ratingText = clean(item.find('.app-testbadge-wrapper-icon .sr-only').first().text());
    const rm = /^(.*?):\s*([\d.,]+)\s+av\s+([\d.,]+)/i.exec(ratingText);
    const outlet =
      clean(item.find('.app-testbadge-wrapper-icon .caption').first().text()) ||
      rm?.[1]?.trim() ||
      clean(review.attr('title')).replace(/^Les test hos\s+/i, '');
    if (!outlet) warnings.push(`Test of ${product_id}: no outlet`);

    const quote = clean(item.find('.description').first().text());
    const date = /^\d{4}-\d{2}-\d{2}/.exec(item.find('time[datetime]').first().attr('datetime') ?? '')?.[0];
    const review_url = stripTracking(review.attr('href'));
    const cat = item.find('a.category-link').first();
    const category_id = categoryIdFromHref(cat.attr('href'));
    const category_name = clean(cat.text());

    tests.push({
      product_id,
      product_title: clean(a.text()),
      outlet,
      ...(quote ? { quote } : {}),
      ...(rm?.[2] && rm[3] ? { rating_value: num(rm[2]), rating_max: num(rm[3]) } : {}),
      ...(date ? { date } : {}),
      ...(review_url ? { review_url } : {}),
      ...(category_id ? { category_id } : {}),
      ...(category_name ? { category_name } : {}),
    });
  });

  return { tests, warnings };
}

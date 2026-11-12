import * as cheerio from 'cheerio';
import { extractJsonLd, parseBreadcrumbs } from './jsonld.js';
import { categoryIdFromHref, clean, parseCount } from './util.js';

export interface CategoryRef {
  id: string;
  name: string;
}

export interface CategoryPage {
  id?: string;
  name: string;
  breadcrumbs: CategoryRef[];
  subcategories: CategoryRef[];
  total?: number;
  warnings: string[];
}

/** Parse a /kategori/{id} page: name, breadcrumbs, "Underkategorier" chips and product total. */
export function parseCategoryPage(html: string): CategoryPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  const id =
    $('[data-category-page]').first().attr('data-category-page') ??
    categoryIdFromHref($('link[rel="canonical"]').attr('href')) ??
    undefined;

  const h1 = $('h1').first().clone();
  h1.children().remove();
  const name = clean(h1.text());
  if (!name) warnings.push('Category name (h1) not found');

  // Breadcrumbs: JSON-LD first, then the visible nav.
  let breadcrumbs: CategoryRef[] = parseBreadcrumbs(extractJsonLd(html).blocks)
    .filter((c): c is typeof c & { id: string } => !!c.id)
    .map((c) => ({ id: c.id, name: c.name }));
  if (!breadcrumbs.length) {
    $('.app-breadcrumb__item a[href*="/kategori/"]').each((_, a) => {
      const cid = categoryIdFromHref($(a).attr('href'));
      if (cid) breadcrumbs.push({ id: cid, name: clean($(a).text()) });
    });
  }
  breadcrumbs = breadcrumbs.filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);

  const subcategories: CategoryRef[] = [];
  const seen = new Set<string>();
  $('nav[aria-label="Underkategorier"] a[href*="/kategori/"]').each((_, a) => {
    const cid = categoryIdFromHref($(a).attr('href'));
    const title = clean($(a).find('.category-chip__title').text()) || clean($(a).text());
    if (!cid || !title || seen.has(cid)) return;
    seen.add(cid);
    subcategories.push({ id: cid, name: title });
  });

  const total =
    parseCount($('.search-count').first().text()) ?? parseCount($('[data-swap-announce]').first().text());

  return {
    ...(id ? { id } : {}),
    name,
    breadcrumbs,
    subcategories,
    ...(total !== undefined ? { total } : {}),
    warnings,
  };
}

export interface TopCategoriesResult {
  categories: CategoryRef[];
  warnings: string[];
}

/** Top-level categories from the megamenu on the front page. */
export function parseTopCategories(homeHtml: string): TopCategoriesResult {
  const $ = cheerio.load(homeHtml);
  const categories: CategoryRef[] = [];
  const seen = new Set<string>();
  $('[data-megamenu] a[href*="/kategori/"]:not([aria-hidden="true"])').each((_, a) => {
    const id = categoryIdFromHref($(a).attr('href'));
    const name = clean($(a).text());
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    categories.push({ id, name });
  });
  const warnings = categories.length ? [] : ['No categories found in megamenu'];
  return { categories, warnings };
}

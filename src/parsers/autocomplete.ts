import { CoreDataMissingError, categoryUrl, productUrl } from '../tools/shared.js';
import type { ListingRating } from './tiles.js';

export interface AutocompleteProduct {
  id: string;
  title: string;
  brand?: string;
  price?: number;
  shop_count?: number;
  discount_pct?: number;
  rating?: ListingRating;
  record_low?: boolean;
  url: string;
  category_id?: string;
  variant_count?: number;
}

export interface AutocompleteCategory {
  id: string;
  name: string;
  product_count?: number;
  total?: number;
  match?: string;
  brand?: string;
  url: string;
}

export interface AutocompleteResult {
  query?: string;
  total: number;
  products: AutocompleteProduct[];
  categories: AutocompleteCategory[];
  warnings: string[];
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Parse the /api/product/search autocomplete JSON. Throws CoreDataMissingError on a bad shape. */
export function parseAutocomplete(json: unknown): AutocompleteResult {
  if (!isRec(json) || !Array.isArray(json['results'])) throw new CoreDataMissingError('search results');
  const warnings: string[] = [];
  const products: AutocompleteProduct[] = [];

  for (const r of json['results']) {
    if (!isRec(r)) continue;
    const idRaw = r['id'];
    const id = typeof idRaw === 'number' ? String(idRaw) : str(idRaw);
    const title = str(r['title']);
    if (!id || !/^\d+$/.test(id) || !title) {
      warnings.push('Skipped a search result without id or title');
      continue;
    }
    const p: AutocompleteProduct = { id, title, url: productUrl(id) };
    const brand = str(r['brand']);
    if (brand) p.brand = brand;
    const price = num(r['price']);
    if (price !== undefined) p.price = Math.round(price);
    const count = num(r['price_count']);
    if (count !== undefined) p.shop_count = count;
    const discount = num(r['discount']);
    if (discount !== undefined) p.discount_pct = discount;
    const rv = num(r['featured_rating_value']);
    const rmax = num(r['featured_rating_max']);
    const rsrc = str(r['featured_rating_critic_site_title']);
    if (rv !== null && rv !== undefined && rmax !== undefined && rsrc) p.rating = { value: rv, max: rmax, source: rsrc };
    const cats = r['category_ids'];
    if (Array.isArray(cats) && cats.length) {
      const last = cats[cats.length - 1];
      if (typeof last === 'number' || typeof last === 'string') p.category_id = String(last);
    }
    const variants = num(r['group_item_count']);
    if (variants !== undefined && variants > 0) p.variant_count = variants;
    products.push(p);
  }

  const categories: AutocompleteCategory[] = [];
  const rawCats = json['categories'];
  if (Array.isArray(rawCats)) {
    for (const c of rawCats) {
      if (!isRec(c)) continue;
      const id = typeof c['id'] === 'number' || typeof c['id'] === 'string' ? String(c['id']) : undefined;
      const name = str(c['label']);
      if (!id || !/^\d+$/.test(id) || !name) continue;
      const match = str(c['match']);
      const brand = str(c['brand']);
      const cat: AutocompleteCategory = {
        id,
        name,
        url: match === 'brand' && brand ? categoryUrl(id, { b: brand }) : categoryUrl(id),
      };
      const pc = num(c['count']);
      if (pc !== undefined) cat.product_count = pc;
      const total = num(c['total']);
      if (total !== undefined) cat.total = total;
      if (match) cat.match = match;
      if (brand) cat.brand = brand;
      categories.push(cat);
    }
  }

  const query = str(json['query']);
  return {
    ...(query ? { query } : {}),
    total: num(json['totalResults']) ?? products.length,
    products,
    categories,
    warnings,
  };
}

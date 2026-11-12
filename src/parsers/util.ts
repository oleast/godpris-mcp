export const BASE_URL = 'https://godpris.no';

/** Collapse whitespace (incl. nbsp) and trim. */
export function clean(text: string | undefined | null): string {
  return (text ?? '').replace(/[\s  ]+/g, ' ').trim();
}

/** Parse a Norwegian price string ("kr 9 171", "9 171,-", "9171", "1 299,50") to integer NOK. */
export function parseNok(text: string | undefined | null): number | undefined {
  if (!text) return undefined;
  const s = text.replace(/[\s  ]/g, '').replace(/kr\.?/gi, '').replace(/,-$/, '').replace(/-$/, '');
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const n = Number(`${m[1]}${m[2] ? `.${m[2]}` : ''}`);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/** Parse an integer that may contain nbsp/space thousands separators ("184 593 tilbud" -> 184593). */
export function parseCount(text: string | undefined | null): number | undefined {
  const m = /\d[\d\s  ]*/.exec(text ?? '');
  if (!m) return undefined;
  const n = Number(m[0].replace(/[\s  ]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Make a (possibly relative) URL absolute against godpris.no. */
export function absoluteUrl(href: string | undefined | null, base: string = BASE_URL): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/** Numeric product id from a /produkt/{id} href (or undefined). */
export function productIdFromHref(href: string | undefined | null): string | undefined {
  return /\/produkt\/(\d+)/.exec(href ?? '')?.[1];
}

/** Numeric category id from a /kategori/{id} href (or undefined). */
export function categoryIdFromHref(href: string | undefined | null): string | undefined {
  return /\/kategori\/(\d+)/.exec(href ?? '')?.[1];
}

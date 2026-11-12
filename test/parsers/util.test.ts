import { describe, expect, it } from 'vitest';
import { absoluteUrl, categoryIdFromHref, parseCount, parseNok, productIdFromHref } from '../../src/parsers/util.js';

describe('parser util', () => {
  it('parses NOK strings', () => {
    expect(parseNok('kr 9 171')).toBe(9171);
    expect(parseNok('kr 9 171')).toBe(9171);
    expect(parseNok('9 171,-')).toBe(9171);
    expect(parseNok('9171')).toBe(9171);
    expect(parseNok('1 299,50')).toBe(1300);
    expect(parseNok('gratis')).toBeUndefined();
    expect(parseNok(undefined)).toBeUndefined();
  });

  it('parses counts', () => {
    expect(parseCount('184 593 tilbud')).toBe(184593);
    expect(parseCount('1581 treff')).toBe(1581);
    expect(parseCount('ingen')).toBeUndefined();
  });

  it('builds absolute urls and ids', () => {
    expect(absoluteUrl('/produkt/1')).toBe('https://godpris.no/produkt/1');
    expect(absoluteUrl('https://x.test/a')).toBe('https://x.test/a');
    expect(absoluteUrl(undefined)).toBeUndefined();
    expect(productIdFromHref('https://godpris.no/produkt/794250?x=1')).toBe('794250');
    expect(productIdFromHref('/kategori/1')).toBeUndefined();
    expect(categoryIdFromHref('https://godpris.no/kategori/1220')).toBe('1220');
  });
});

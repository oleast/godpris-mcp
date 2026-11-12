import { describe, expect, it } from 'vitest';
import { extractJsonLd, findByType, parseBreadcrumbs, parseItemList } from '../../src/parsers/jsonld.js';
import { fixture } from './helpers.js';

describe('jsonld', () => {
  it('extracts blocks from a category page', () => {
    const { blocks, warnings } = extractJsonLd(fixture('kat_1220.html'));
    expect(warnings).toEqual([]);
    expect(findByType(blocks, 'WebSite')).toHaveLength(1);
    expect(findByType(blocks, 'BreadcrumbList')).toHaveLength(1);
    expect(findByType(blocks, 'ItemList')).toHaveLength(1);
  });

  it('parses breadcrumbs with category ids', () => {
    const crumbs = parseBreadcrumbs(extractJsonLd(fixture('kat_1220.html')).blocks);
    expect(crumbs).toEqual([
      { name: 'Hvitevarer', url: 'https://godpris.no/kategori/1219', id: '1219' },
      { name: 'Vaskemaskin', url: 'https://godpris.no/kategori/1220', id: '1220' },
    ]);
  });

  it('parses the listing ItemList', () => {
    const list = parseItemList(extractJsonLd(fixture('kat_1220.html')).blocks);
    expect(list?.total).toBe(36);
    expect(list?.productIds).toHaveLength(36);
    expect(list?.productIds[0]).toBe('5099462');
  });

  it('finds Product and ProductGroup blocks', () => {
    expect(findByType(extractJsonLd(fixture('prod_794250.html')).blocks, 'Product')).toHaveLength(1);
    const group = findByType(extractJsonLd(fixture('prod_4758589.html')).blocks, 'ProductGroup');
    expect(group).toHaveLength(1);
    expect(Array.isArray(group[0]?.['hasVariant'])).toBe(true);
  });

  it('flattens @graph and tolerates bad JSON with a warning', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"a"},{"@type":["Thing","ItemList"]}]}</script>
      <script type="application/ld+json">{oops</script>`;
    const { blocks, warnings } = extractJsonLd(html);
    expect(blocks).toHaveLength(2);
    expect(findByType(blocks, 'ItemList')).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('returns empty results for pages without JSON-LD', () => {
    const { blocks } = extractJsonLd('<html></html>');
    expect(blocks).toEqual([]);
    expect(parseBreadcrumbs(blocks)).toEqual([]);
    expect(parseItemList(blocks)).toBeUndefined();
  });
});

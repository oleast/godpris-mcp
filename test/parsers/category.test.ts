import { describe, expect, it } from 'vitest';
import { parseCategoryPage, parseTopCategories } from '../../src/parsers/category.js';
import { fixture } from './helpers.js';

describe('parseCategoryPage', () => {
  it('parses a leaf category', () => {
    expect(parseCategoryPage(fixture('kat_1220.html'))).toEqual({
      id: '1220',
      name: 'Vaskemaskin',
      breadcrumbs: [
        { id: '1219', name: 'Hvitevarer' },
        { id: '1220', name: 'Vaskemaskin' },
      ],
      subcategories: [],
      total: 1581,
      warnings: [],
    });
  });

  it('parses subcategory chips', () => {
    const c = parseCategoryPage(fixture('kat_449.html'));
    expect(c.id).toBe('449');
    expect(c.name).toBe('Hjem og husholdning');
    expect(c.subcategories).toHaveLength(14);
    expect(c.subcategories).toContainEqual({ id: '592', name: 'Kjøkken' });
    expect(c.breadcrumbs).toEqual([{ id: '449', name: 'Hjem og husholdning' }]);
  });

  it('warns on a page without category data', () => {
    const c = parseCategoryPage('<html></html>');
    expect(c.name).toBe('');
    expect(c.warnings).toHaveLength(1);
  });
});

describe('parseTopCategories', () => {
  it('finds the 17 megamenu categories', () => {
    const { categories, warnings } = parseTopCategories(fixture('home.html'));
    expect(warnings).toEqual([]);
    expect(categories).toHaveLength(17);
    expect(categories.map((c) => c.id)).toEqual([
      '524', '523', '520', '881', '448', '449', '459', '1721', '1', '1337', '1219', '1605', '1237', '1259', '2376', '835', '26',
    ]);
    expect(categories).toContainEqual({ id: '1219', name: 'Hvitevarer' });
  });

  it('warns when there is no megamenu', () => {
    expect(parseTopCategories('<html></html>').warnings).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { parseFilters } from '../../src/parsers/filters.js';
import { parseExpertTests } from '../../src/parsers/tests.js';
import { fixture } from './helpers.js';

describe('parseExpertTests', () => {
  const { tests, warnings } = parseExpertTests(fixture('tester.html'));

  it('parses 30 review items', () => {
    expect(warnings).toEqual([]);
    expect(tests).toHaveLength(30);
    expect(tests[0]).toMatchObject({
      product_id: '21798663',
      product_title: 'Robot Vacuum Omni E35 Black',
      outlet: 'Lyd & bilde',
      rating_value: 4,
      rating_max: 6,
      date: '2026-11-09',
      review_url: 'https://www.lydogbilde.no/test/smart-hjem/anker-eufy-robot-vacuum-omni-e35/',
      category_id: '678',
      category_name: 'Robotstøvsuger',
    });
    expect(tests[0]?.quote).toMatch(/^«Eufys kraftige robot/);
    expect(tests[1]).toMatchObject({ product_id: '20331101', outlet: "Tom's Guide", rating_value: 4, rating_max: 5 });
  });

  it('keeps reviews without a score', () => {
    const unrated = tests.filter((t) => t.rating_value === undefined);
    expect(unrated).toHaveLength(1);
    expect(unrated[0]).toMatchObject({ product_id: '3653974', outlet: 'Tek.no', date: '2026-10-31' });
  });

  it('exposes the outlet filter options', () => {
    const site = parseFilters(fixture('tester.html')).filters.find((f) => f.key === 'site');
    expect(site?.options?.find((o) => o.value === 'Lyd & bilde')).toMatchObject({ count: 599 });
    expect(site?.options?.find((o) => o.value === 'Tek.no')).toMatchObject({ count: 1395 });
  });
});

import { describe, expect, it } from 'vitest';
import { availableFilters, matchRequirements, parseNumeric } from '../../src/match/requirements.js';
import { parseFilters } from '../../src/parsers/filters.js';
import { fixture } from '../parsers/helpers.js';

const defs = parseFilters(fixture('kat_1220.html')).filters;

describe('matchRequirements', () => {
  it('maps a range label with min', () => {
    const m = matchRequirements([{ label: 'vaskekapasitet', min: 9 }], defs);
    expect(m.applied[0]).toMatchObject({ key: 'f226', type: 'range', min: 9 });
    expect(m.filters).toEqual([{ key: 'f226', min: 9 }]);
  });

  it('reads a bare value as minimum', () => {
    const m = matchRequirements([{ label: 'Kapasitet', values: ['9 kg'] }], defs);
    expect(m.applied[0]).toMatchObject({ key: 'f226', min: 9 });
    expect(m.applied[0]?.note).toContain('minimum');
  });

  it('maps English labels and option values', () => {
    const m = matchRequirements([{ label: 'energy class', values: ['a', 'B'] }], defs);
    expect(m.applied[0]).toMatchObject({ key: 'f189', values: ['A', 'B'] });
  });

  it('accepts exact filter keys', () => {
    const m = matchRequirements([{ label: 'F189', values: ['C'] }], defs);
    expect(m.applied[0]).toMatchObject({ key: 'f189', score: 1 });
  });

  it('maps bool filters', () => {
    expect(matchRequirements([{ label: 'børsteløs motor' }], defs).filters).toEqual([{ key: 'f235', values: ['1'] }]);
    expect(matchRequirements([{ label: 'Innvendig belysning', values: ['nei'] }], defs).filters).toEqual([{ key: 'f236', values: ['0'] }]);
  });

  it('maps value synonyms and reports unknown options', () => {
    const m = matchRequirements([{ label: 'farge', values: ['sort', 'lilla'] }], defs);
    expect(m.applied[0]).toMatchObject({ key: 'f472', values: ['Svart'] });
    expect(m.unmatched).toHaveLength(1);
    expect(m.unmatched[0]?.reason).toBe('value_not_found');
    expect(m.unmatched[0]?.detail).toContain('lilla');
    expect(m.unmatched[0]?.suggestions.length).toBeGreaterThan(0);
  });

  it('maps brands', () => {
    const m = matchRequirements([{ label: 'merke', values: ['bosch', 'aeg'] }], defs);
    expect(m.filters).toEqual([{ key: 'b', values: ['Bosch', 'AEG'] }]);
  });

  it('prefers the range filter for a numeric noise requirement', () => {
    const m = matchRequirements([{ label: 'støynivå', max: 75 }], defs);
    expect(m.applied[0]).toMatchObject({ key: 'f228', max: 75 });
    expect(m.filters[0]?.key).toBe('f228');
  });

  it('reports unmatched requirements', () => {
    const none = matchRequirements([{ label: 'wifi' }], defs);
    expect(none.unmatched[0]?.reason).toBe('no_matching_filter');
    expect(none.filters).toEqual([]);
    expect(matchRequirements([{ label: 'f9999', min: 1 }], defs).unmatched[0]?.reason).toBe('unknown_key');
    const nv = matchRequirements([{ label: 'Energiklasse' }], defs);
    expect(nv.unmatched[0]?.reason).toBe('needs_value');
    expect(nv.unmatched[0]?.detail).toContain('values');
    expect(matchRequirements([{ label: 'vaskekapasitet', min: 10, max: 8 }], defs).unmatched[0]?.reason).toBe('invalid_range');
  });

  it('merges requirements that map to the same filter', () => {
    const m = matchRequirements(
      [
        { label: 'vaskekapasitet', min: 8 },
        { label: 'kapasitet', min: 9 },
      ],
      defs,
    );
    expect(m.filters).toEqual([{ key: 'f226', min: 9 }]);
    expect(m.applied).toHaveLength(2);
    expect(m.warnings.some((w) => w.includes('merged'))).toBe(true);
  });

  it('parses bounds and converts units', () => {
    expect(matchRequirements([{ label: 'bredde', values: ['maks 60 cm'] }], defs).applied[0]).toMatchObject({ key: 'f157', max: 60 });
    const d = matchRequirements([{ label: 'dybde', values: ['under 600 mm'] }], defs).applied[0];
    expect(d).toMatchObject({ key: 'f175', max: 60 });
    expect(d?.note).toContain('converted');
  });

  it('warns when the range is outside what exists but still applies it', () => {
    const m = matchRequirements([{ label: 'vaskekapasitet', min: 25 }], defs);
    expect(m.filters).toEqual([{ key: 'f226', min: 25 }]);
    expect(m.warnings.some((w) => w.includes('No product'))).toBe(true);
  });
});

describe('parseNumeric', () => {
  it('parses numbers, units and bounds', () => {
    expect(parseNumeric('9 kg')).toEqual({ value: 9, unit: 'kg' });
    expect(parseNumeric('1 400 rpm')).toMatchObject({ value: 1400 });
    expect(parseNumeric('8,5')).toMatchObject({ value: 8.5 });
    expect(parseNumeric('8-10 kg')).toMatchObject({ min: 8, max: 10 });
    expect(parseNumeric('abc')).toBeUndefined();
    expect(parseNumeric('maks 60 cm')).toMatchObject({ value: 60, bound: 'max' });
  });

  it('reads space-grouped numbers as thousands only when unambiguous', () => {
    expect(parseNumeric('10 000 kr')).toMatchObject({ value: 10000 });
    expect(parseNumeric('kr 1 299')).toMatchObject({ value: 1299 });
    expect(parseNumeric('1 299 kr')).toMatchObject({ value: 1299 });
    expect(parseNumeric('under 12 990 kr')).toMatchObject({ value: 12990, bound: 'max' });
    expect(parseNumeric('1 299 000')).toMatchObject({ value: 1299000 });
    expect(parseNumeric('50\u00a0100')).toMatchObject({ value: 50100 });
    expect(parseNumeric('50 100')).toMatchObject({ min: 50, max: 100 });
    expect(parseNumeric('50 - 100')).toMatchObject({ min: 50, max: 100 });
    expect(parseNumeric('3 - 20 kg')).toMatchObject({ min: 3, max: 20, unit: 'kg' });
  });
});

describe('availableFilters', () => {
  it('summarises filters', () => {
    const a = availableFilters(defs);
    const f226 = a.find((f) => f.key === 'f226');
    expect(f226?.options).toBeUndefined();
    expect(f226?.unit).toBe('kg');
    expect(a.find((f) => f.key === 'f472')?.options).toContain('Hvit');
    expect(a.find((f) => f.key === 'b')?.options?.length).toBeLessThanOrEqual(12);
  });
});

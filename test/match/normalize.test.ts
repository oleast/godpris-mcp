import { describe, expect, it } from 'vitest';
import { fuzzyScore, matchScore, normalizeText, tokens } from '../../src/match/normalize.js';

describe('normalize', () => {
  it('folds case, Norwegian letters and punctuation', () => {
    expect(normalizeText('Kjøkken-Maskin, Å!')).toBe('kjokken maskin a');
    expect(tokens('  a  b ')).toEqual(['a', 'b']);
  });
  it('scores matches', () => {
    expect(matchScore('Vaskemaskin', 'vaskemaskin')).toBe(1);
    expect(matchScore('Kjøkken', 'kjokken')).toBe(1);
    expect(matchScore('vask', 'Vaskemaskin')).toBe(0.9);
    expect(matchScore('kaffe maskin', 'Maskin for kaffe')).toBe(1);
    expect(matchScore('tv', 'Vaskemaskin')).toBe(0);
  });
});

describe('fuzzyScore', () => {
  it('handles compound words and spacing', () => {
    expect(fuzzyScore('kapasitet', 'Vaskekapasitet')).toBeCloseTo(0.8);
    expect(fuzzyScore('energi klasse', 'Energiklasse')).toBeCloseTo(0.95);
    expect(fuzzyScore('lydniva', 'Lydnivå (sentrifugering)')).toBeCloseTo(0.9);
    expect(fuzzyScore('wifi', 'Vaskekapasitet')).toBe(0);
    expect(fuzzyScore('Vaskemaskin', 'vaskemaskin')).toBe(1);
  });
});

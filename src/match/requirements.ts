import { fuzzyScore, normalizeText } from './normalize.js';
import type { FilterDef, FilterOption } from '../parsers/filters.js';
import type { FilterInput } from '../tools/shared.js';

export interface Requirement {
  label: string;
  min?: number | undefined;
  max?: number | undefined;
  values?: string[] | undefined;
}
export type UnmatchedReason =
  | 'no_matching_filter'
  | 'ambiguous'
  | 'unknown_key'
  | 'needs_value'
  | 'value_not_found'
  | 'invalid_range';
export interface AppliedFilter {
  requirement: string;
  key: string;
  filter_label: string;
  type: 'range' | 'enum' | 'bool';
  min?: number;
  max?: number;
  unit?: string;
  values?: string[];
  value_labels?: string[];
  score: number;
  note?: string;
}
export interface UnmatchedRequirement {
  requirement: string;
  reason: UnmatchedReason;
  detail: string;
  suggestions: string[];
}
export interface MatchResult {
  applied: AppliedFilter[];
  filters: FilterInput[];
  unmatched: UnmatchedRequirement[];
  warnings: string[];
}
export interface AvailableFilter {
  key: string;
  label: string;
  type: 'range' | 'enum' | 'bool';
  unit?: string;
  min?: number;
  max?: number;
  options?: string[];
}

export const ACCEPT_SCORE = 0.8;
export const MARGIN = 0.05;
export const SUGGEST_SCORE = 0.4;
export const VALUE_ACCEPT = 0.8;

const LABEL_SYNONYMS: Record<string, string> = {
  capacity: 'kapasitet',
  energy: 'energi',
  class: 'klasse',
  noise: 'lydniva',
  sound: 'lyd',
  stoy: 'lyd',
  stoyniva: 'lydniva',
  loudness: 'lydniva',
  color: 'farge',
  colour: 'farge',
  width: 'bredde',
  height: 'hoyde',
  depth: 'dybde',
  weight: 'vekt',
  brand: 'produsent',
  merke: 'produsent',
  manufacturer: 'produsent',
  price: 'pris',
  spin: 'sentrifugering',
  speed: 'hastighet',
  rpm: 'sentrifugeringshastighet',
  drum: 'trommel',
  volume: 'volum',
  water: 'vann',
  screen: 'skjerm',
  storage: 'lagringsplass',
  memory: 'minne',
  battery: 'batteri',
  size: 'storrelse',
  motor: 'motor',
};

const VALUE_SYNONYMS: Record<string, string> = {
  black: 'svart',
  sort: 'svart',
  white: 'hvit',
  grey: 'gra',
  gray: 'gra',
  silver: 'solv',
  red: 'rod',
  blue: 'bla',
  green: 'gronn',
  stainless: 'rustfritt stal',
  'stainless steel': 'rustfritt stal',
};

const TRUE_WORDS = ['1', 'ja', 'yes', 'true', 'y', 'med', 'with'];
const FALSE_WORDS = ['0', 'nei', 'no', 'false', 'n', 'uten', 'without'];
const UNIT_TOKENS = ['kg', 'g', 'l', 'liter', 'cm', 'mm', 'm', 'db', 'rpm', 'kwh', 'w', 'watt', 'gb', 'tb', 'mb', 'hz', 'tommer', 'inch', 'v', 'mah'];
const UNIT_FACTORS: Record<string, Record<string, number>> = {
  mm: { cm: 0.1, m: 0.001 },
  cm: { mm: 10, m: 0.01 },
  m: { cm: 100, mm: 1000 },
  g: { kg: 0.001 },
  kg: { g: 1000 },
};
const MAX_MARKERS = /\b(max|maks|under|hoyst|høyst|inntil|opptil|below|at most)\b|<|≤/;
const MIN_MARKERS = /\b(min|minst|over|fra|above|at least)\b|>|≥|\+$/;
const KEY_PATTERN = /^(f\d+|b|p|d_min|rekordbillig|c|shop)$/;

const round = (n: number, d = 2): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * Whether a "d{1,3}( d{3})+" match is one number with space thousands separators or several numbers.
 * Thousands when: a non-breaking space is used, there are 2+ three-digit groups ("1 299 000"), the leading
 * group is a single digit ("1 299"), the group is "000" ("10 000"), or a currency marker is adjacent
 * ("kr 12 990", "12 990 kr"). Otherwise ("50 100", "20 500") it is read as two numbers.
 */
function isThousands(match: string, before: string, after: string): boolean {
  const groups = match.split(/[ \u00a0\u202f]/);
  if (groups.length > 2 || /[\u00a0\u202f]/.test(match)) return true;
  const [lead = '', group = ''] = groups;
  if (lead.length === 1 || group.startsWith('000')) return true;
  return /(?:kr|nok)\.?\s*$/.test(before) || /^\s*(?:kr|nok|,-|:-)/.test(after);
}

export function parseNumeric(
  text: string,
): { min?: number; max?: number; value?: number; unit?: string; bound?: 'min' | 'max' } | undefined {
  const lower = text.toLowerCase();
  const re = /\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
  const nums: number[] = [];
  let lastEnd = 0;
  for (const m of lower.matchAll(re)) {
    const start = m.index ?? 0;
    lastEnd = start + m[0].length;
    const grouped = /[ \u00a0\u202f]/.test(m[0]);
    if (grouped && !isThousands(m[0], lower.slice(0, start), lower.slice(lastEnd))) {
      for (const part of m[0].split(/[ \u00a0\u202f]/)) nums.push(Number(part.replace(',', '.')));
    } else {
      nums.push(Number(m[0].replace(/[ \u00a0\u202f]/g, '').replace(',', '.')));
    }
  }
  if (!nums.length) return undefined;
  const after = lower.slice(lastEnd).split(/[^a-zæøå0-9%]+/);
  const unit = after.find((t) => UNIT_TOKENS.includes(t));
  if (nums.length >= 2) {
    return { min: Math.min(...nums), max: Math.max(...nums), ...(unit ? { unit } : {}) };
  }
  const bound = MAX_MARKERS.test(lower) ? 'max' : MIN_MARKERS.test(lower) ? 'min' : undefined;
  return { value: nums[0] as number, ...(unit ? { unit } : {}), ...(bound ? { bound } : {}) };
}

function synonymizeLabel(label: string): { text: string; unitHint?: string } {
  let toks = normalizeText(label).split(' ').filter(Boolean);
  let unitHint: string | undefined;
  const kept = toks.filter((t) => !UNIT_TOKENS.includes(t));
  if (kept.length && kept.length < toks.length) {
    unitHint = toks.find((t) => UNIT_TOKENS.includes(t));
    toks = kept;
  }
  return { text: toks.map((t) => LABEL_SYNONYMS[t] ?? t).join(' '), ...(unitHint ? { unitHint } : {}) };
}

function synonymizeValue(v: string): string {
  const n = normalizeText(v);
  const whole = VALUE_SYNONYMS[n];
  if (whole) return whole;
  return n
    .split(' ')
    .map((t) => VALUE_SYNONYMS[t] ?? t)
    .join(' ');
}

interface Scored {
  def: FilterDef;
  score: number;
}

function matchValue(v: string, options: FilterOption[]): FilterOption | undefined {
  const lower = v.trim().toLowerCase();
  const byValue = options.find((o) => o.value.toLowerCase() === lower);
  if (byValue) return byValue;
  const syn = normalizeText(synonymizeValue(v));
  const byLabel = options.find((o) => normalizeText(o.label) === syn);
  if (byLabel) return byLabel;
  const num = parseNumeric(v)?.value;
  if (num !== undefined) {
    const byNum = options.find((o) => parseNumeric(o.label)?.value === num);
    if (byNum) return byNum;
  }
  if (normalizeText(v).length <= 2) return undefined;
  const scored = options
    .map((o) => ({ o, s: fuzzyScore(syn, o.label) }))
    .filter((x) => x.s >= VALUE_ACCEPT)
    .sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (!best) return undefined;
  const close = scored.filter((x) => best.s - x.s < MARGIN - 1e-9);
  if (close.length === 1) return best.o;
  const top = [...close].sort((a, b) => (b.o.count ?? 0) - (a.o.count ?? 0));
  if ((top[0]?.o.count ?? 0) > (top[1]?.o.count ?? 0)) return top[0]?.o;
  return undefined;
}

function kindOf(r: Requirement): 'range' | 'enum' | 'bool' {
  const values = r.values ?? [];
  if (r.min !== undefined || r.max !== undefined) return 'range';
  if (values.length && values.every((v) => parseNumeric(v) !== undefined)) return 'range';
  if (!values.length) return 'bool';
  const words = new Set([...TRUE_WORDS, ...FALSE_WORDS]);
  if (values.every((v) => words.has(v.trim().toLowerCase()))) return 'bool';
  return 'enum';
}

const fmt = (n: number): string => String(round(n, 4));

export function matchRequirements(reqs: Requirement[], defs: FilterDef[]): MatchResult {
  const applied: AppliedFilter[] = [];
  const unmatched: UnmatchedRequirement[] = [];
  const warnings: string[] = [];
  const outFilters = new Map<string, FilterInput & { _labels: string[] }>();
  const byKey = new Map(defs.map((d) => [d.key, d]));

  for (const r of reqs) {
    const display = r.label.trim();
    const kind = kindOf(r);
    const fail = (reason: UnmatchedReason, detail: string, suggestions: string[] = []): void => {
      unmatched.push({ requirement: display, reason, detail, suggestions });
    };

    // --- locate filter
    let def: FilterDef | undefined;
    let score = 1;
    const k = display.toLowerCase().replace(/_(min|max)$/, '');
    if (KEY_PATTERN.test(k)) {
      def = byKey.get(k);
      if (!def) {
        fail('unknown_key', `Filter key ${k} does not exist in this category`);
        continue;
      }
    } else {
      const { text, unitHint } = synonymizeLabel(r.label);
      const scored: Scored[] = defs
        .map((d) => {
          let s = fuzzyScore(text, d.label);
          if ((kind === 'range' && d.type === 'range') || (kind === 'enum' && d.type !== 'range') || (kind === 'bool' && d.type === 'bool')) s += 0.05;
          if (unitHint && d.unit && unitHint === normalizeText(d.unit)) s += 0.05;
          return { def: d, score: s };
        })
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      const second = scored[1];
      const suggestions = scored
        .filter((x) => x.score >= SUGGEST_SCORE)
        .slice(0, 3)
        .map((x) => `${x.def.label} (${x.def.key})`);
      if (!best || best.score < ACCEPT_SCORE) {
        fail('no_matching_filter', `No filter label matches "${display}"`, suggestions);
        continue;
      }
      if (second && best.score - second.score < MARGIN - 1e-9) {
        fail('ambiguous', `"${display}" matches several filters equally well`, suggestions);
        continue;
      }
      def = best.def;
      score = Math.min(1, round(best.score));
    }

    // --- map values
    const a: AppliedFilter = { requirement: display, key: def.key, filter_label: def.label, type: def.type, score, ...(def.unit ? { unit: def.unit } : {}) };
    const notes: string[] = [];
    const rawValues = (r.values ?? []).filter((v) => v.trim());
    let min: number | undefined;
    let max: number | undefined;
    let values: string[] | undefined;

    if (def.type === 'range') {
      if (r.min !== undefined || r.max !== undefined) {
        min = r.min;
        max = r.max;
        if (rawValues.length) notes.push('values ignored; min/max used');
      } else {
        const found: number[] = [];
        let singleBound: 'min' | 'max' | undefined;
        let singleText = '';
        for (const v of rawValues) {
          const p = parseNumeric(v);
          if (!p) continue;
          const nums = p.min !== undefined && p.max !== undefined ? [p.min, p.max] : [p.value as number];
          let converted = nums;
          const defUnit = def.unit?.toLowerCase();
          if (p.unit && defUnit && p.unit !== defUnit) {
            const factor = UNIT_FACTORS[p.unit]?.[defUnit];
            if (factor !== undefined) {
              converted = nums.map((n) => round(n * factor, 4));
              notes.push(`converted ${nums.map(fmt).join('–')} ${p.unit} to ${converted.map(fmt).join('–')} ${defUnit}`);
            } else {
              notes.push(`unit ${p.unit} ignored (filter unit ${def.unit})`);
            }
          }
          found.push(...converted);
          singleBound = p.bound;
          singleText = v;
        }
        if (!found.length) {
          fail('needs_value', `${def.label} is a range filter; pass min/max, e.g. {"label":"${display}","min":9}`);
          continue;
        }
        if (found.length >= 2) {
          min = Math.min(...found);
          max = Math.max(...found);
        } else if (singleBound === 'max') {
          max = found[0];
        } else {
          min = found[0];
          notes.push(`interpreted "${singleText}" as minimum; pass min/max for exact control`);
        }
      }
      if (min !== undefined && max !== undefined && min > max) {
        fail('invalid_range', `min ${fmt(min)} is greater than max ${fmt(max)} for ${def.label}`);
        continue;
      }
      if ((min !== undefined && def.max !== undefined && min > def.max) || (max !== undefined && def.min !== undefined && max < def.min)) {
        warnings.push(`No product in this category has ${def.label} in that range (${def.min ?? ''}–${def.max ?? ''}${def.unit ? ` ${def.unit}` : ''})`);
      }
      if (min !== undefined) a.min = min;
      if (max !== undefined) a.max = max;
    } else if (def.type === 'bool') {
      const opts = def.options ?? [];
      const trueVal = opts.some((o) => o.value === '1') || !opts.length ? '1' : (opts[0]?.value ?? '1');
      const falseVal = opts.some((o) => o.value === '0') || !opts.length ? '0' : (opts.find((o) => o.value !== trueVal)?.value ?? '0');
      if (!rawValues.length) {
        values = [trueVal];
        notes.push('no value given; requiring Ja');
      } else {
        values = [];
        const bad: string[] = [];
        for (const v of rawValues) {
          const w = v.trim().toLowerCase();
          if (TRUE_WORDS.includes(w)) values.push(trueVal);
          else if (FALSE_WORDS.includes(w)) values.push(falseVal);
          else bad.push(v);
        }
        if (bad.length) {
          fail('value_not_found', `"${bad.join('", "')}" is not a yes/no value for ${def.label}`, ['Ja', 'Nei']);
          if (!values.length) continue;
        }
        values = [...new Set(values)];
      }
      a.values = values;
    } else {
      const opts = def.options ?? [];
      const chosen: FilterOption[] = [];
      const bad: string[] = [];
      if (rawValues.length) {
        for (const v of rawValues) {
          const o = matchValue(v, opts);
          if (o) {
            if (!chosen.includes(o)) chosen.push(o);
          } else bad.push(v);
        }
      } else if (r.min !== undefined || r.max !== undefined) {
        for (const o of opts) {
          const n = parseNumeric(o.label)?.value;
          if (n !== undefined && (r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max)) chosen.push(o);
        }
        if (!chosen.length) {
          fail('needs_value', `${def.label} is a list filter; pass values, e.g. ["${opts[0]?.label ?? ''}"]`);
          continue;
        }
      } else {
        fail('needs_value', `${def.label} is a list filter; pass values, e.g. ["${opts[0]?.label ?? ''}"]`);
        continue;
      }
      if (bad.length) {
        const first = bad[0] as string;
        const ranked = opts
          .map((o) => ({ o, s: fuzzyScore(synonymizeValue(first), o.label) }))
          .filter((x) => x.s > 0)
          .sort((x, y) => y.s - x.s)
          .map((x) => x.o.label);
        const suggestions = (ranked.length ? ranked : opts.map((o) => o.label)).slice(0, 5);
        fail('value_not_found', `${bad.map((b) => `"${b}"`).join(', ')} ${bad.length > 1 ? 'are' : 'is'} not an option of ${def.label}`, suggestions);
      }
      if (!chosen.length) continue;
      a.values = chosen.map((o) => o.value);
      a.value_labels = chosen.map((o) => o.label);
    }
    if (notes.length) a.note = notes.join('; ');
    applied.push(a);

    // --- merge by key
    const prev = outFilters.get(def.key);
    if (!prev) {
      outFilters.set(def.key, {
        key: def.key,
        ...(a.min !== undefined ? { min: a.min } : {}),
        ...(a.max !== undefined ? { max: a.max } : {}),
        ...(a.values ? { values: [...a.values] } : {}),
        _labels: [display],
      });
    } else {
      warnings.push(`Requirements "${prev._labels.join('", "')}" and "${display}" both map to ${def.label} (${def.key}); merged`);
      prev._labels.push(display);
      if (a.min !== undefined) prev.min = prev.min !== undefined ? Math.max(prev.min, a.min) : a.min;
      if (a.max !== undefined) prev.max = prev.max !== undefined ? Math.min(prev.max, a.max) : a.max;
      if (a.values) prev.values = [...new Set([...(prev.values ?? []), ...a.values])];
    }
  }

  const filters: FilterInput[] = [...outFilters.values()].map(({ _labels, ...f }) => {
    void _labels;
    return f;
  });
  return { applied, filters, unmatched, warnings };
}

export function availableFilters(defs: FilterDef[], maxOptions = 12): AvailableFilter[] {
  return defs.map((d) => ({
    key: d.key,
    label: d.label,
    type: d.type,
    ...(d.unit ? { unit: d.unit } : {}),
    ...(d.min !== undefined ? { min: d.min } : {}),
    ...(d.max !== undefined ? { max: d.max } : {}),
    ...(d.type !== 'range' && d.options?.length ? { options: d.options.slice(0, maxOptions).map((o) => o.label) } : {}),
  }));
}

import * as cheerio from 'cheerio';
import { clean, parseCount } from './util.js';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface FilterDef {
  /** Query-string key: "p", "b", "f226", "d_min", "rekordbillig", ... For ranges use `{key}_min` / `{key}_max`. */
  key: string;
  label: string;
  type: 'range' | 'enum' | 'bool';
  min?: number;
  max?: number;
  unit?: string;
  options?: FilterOption[];
}

export interface SortOption {
  value: string;
  label: string;
}

export interface FiltersResult {
  filters: FilterDef[];
  sort_options: SortOption[];
  /** Currently selected sort value, if shown. */
  current_sort?: string;
  warnings: string[];
}

function numAttr(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse the filter sidebar (range / enum / bool / discount) and sort options of a listing page. */
export function parseFilters(html: string): FiltersResult {
  const $ = cheerio.load(html);
  const filters: FilterDef[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();

  $('[data-filter-item]').each((_, el) => {
    const group = $(el);
    const id = group.attr('data-filter-item') ?? '';
    if (seenIds.has(id)) return; // same filter rendered for desktop + sidebar
    seenIds.add(id);
    const label = clean((group.attr('aria-label') ?? '').replace(/^Filter for\s+/i, ''));

    const add = (def: FilterDef): void => {
      if (seenKeys.has(def.key)) return;
      seenKeys.add(def.key);
      filters.push(def);
    };

    // Discount buckets (Rabatt): d_min
    if (group.find('.discount-buckets').length) {
      const input = group.find('input[name="d_min"]').first();
      const options: FilterOption[] = [];
      group.find('a.discount-bucket').each((_, a) => {
        const href = $(a).attr('href') ?? '';
        const v = /[?&]d_min=(\d+)/.exec(href)?.[1];
        const count = parseCount($(a).find('.discount-bucket__count').text());
        const lbl = clean($(a).find('.discount-bucket__label').text());
        if (v) options.push({ value: v, label: lbl, ...(count !== undefined ? { count } : {}) });
      });
      const min = numAttr(input.attr('min'));
      const max = numAttr(input.attr('max'));
      add({
        key: 'd_min',
        label: label || 'Rabatt',
        type: 'range',
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        unit: '%',
        options,
      });
      return;
    }

    // Range / histogram slider
    const range = group.find('[data-range-filter]').first();
    if (range.length) {
      const key = range.attr('data-filter-key');
      if (!key) return void warnings.push(`Range filter "${label}" has no key`);
      let min = numAttr(group.find('input[data-range-input="0"]').first().attr('min'));
      let max = numAttr(group.find('input[data-range-input="1"]').first().attr('max'));
      if (min === undefined || max === undefined) {
        try {
          const sel = JSON.parse(range.attr('data-selected') ?? 'null') as unknown;
          if (Array.isArray(sel)) {
            min ??= numAttr(String(sel[0]));
            max ??= numAttr(String(sel[1]));
          }
        } catch {
          /* ignore */
        }
      }
      const unit = clean(range.attr('data-unit'));
      add({
        key,
        label,
        type: 'range',
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(unit ? { unit } : {}),
      });
      return;
    }

    // Category tree (c): top-level nodes only
    const tree = group.find('[data-category-tree]').first();
    if (tree.length) {
      const key = tree.attr('data-filter-key') ?? 'c';
      const options: FilterOption[] = [];
      tree.children('[data-category-node]').each((_, n) => {
        const node = $(n);
        const value = node.attr('data-category-key');
        const lbl = clean(node.children('.filter-option').find('label span').first().text());
        if (value) options.push({ value, label: lbl });
      });
      add({ key, label, type: 'enum', options });
      return;
    }

    // Enum / bool checkboxes (inline options + deferred JSON options)
    const inputs = group.find('input[data-filter-option]');
    const key = inputs.first().attr('data-filter-key') ?? group.find('[data-filter-key]').first().attr('data-filter-key');
    if (!key) return void warnings.push(`Filter "${label}" (${id}): no key found`);
    const options: FilterOption[] = [];
    const seenVals = new Set<string>();
    inputs.each((_, inp) => {
      const value = $(inp).attr('value') ?? '';
      const row = $(inp).closest('.filter-option');
      const lbl = clean(row.find('label span').first().text());
      const count = parseCount(row.find('.count').first().text());
      if (!value || seenVals.has(value)) return;
      seenVals.add(value);
      options.push({ value, label: lbl || value, ...(count !== undefined ? { count } : {}) });
    });
    const deferred = $(`script[data-filter-data="${id}"]`).first().text();
    if (deferred) {
      try {
        const data = JSON.parse(deferred) as { options?: Array<{ k: string; l?: string; c?: number | null }> };
        for (const o of data.options ?? []) {
          const value = String(o.k);
          if (seenVals.has(value)) continue;
          seenVals.add(value);
          options.push({ value, label: o.l ?? value, ...(typeof o.c === 'number' ? { count: o.c } : {}) });
        }
      } catch {
        warnings.push(`Filter "${label}" (${id}): bad deferred options JSON`);
      }
    }
    const isBool = key === 'rekordbillig' || (options.length > 0 && options.every((o) => o.value === '0' || o.value === '1'));
    add({ key, label, type: isBool ? 'bool' : 'enum', options });
  });

  if (!filters.length) warnings.push('No filters found on page');

  const menu = $('[data-select-menu]').first();
  const sort_options: SortOption[] = [];
  menu.find('[role="option"][data-value]').each((_, o) => {
    sort_options.push({ value: $(o).attr('data-value') ?? '', label: clean($(o).text()) });
  });
  const current = menu.attr('data-value');

  return { filters, sort_options, ...(current ? { current_sort: current } : {}), warnings };
}

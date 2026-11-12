import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Watchlist, type WatchItem } from '../../src/store/watchlist.js';

const dir = () => mkdtempSync(join(tmpdir(), 'godpris-wl-'));
const item = (id: string, extra: Partial<WatchItem> = {}): WatchItem => ({
  product_id: id,
  title: `P${id}`,
  url: `https://godpris.no/produkt/${id}`,
  added_at: '2026-11-11T00:00:00.000Z',
  ...extra,
});

describe('Watchlist store', () => {
  it('starts empty when the file is missing', async () => {
    expect(await new Watchlist(join(dir(), 'watchlist.json')).list()).toEqual([]);
  });

  it('adds, upserts and removes', async () => {
    const w = new Watchlist(join(dir(), 'watchlist.json'));
    await w.update((items) => items.push(item('1', { target_price: 100 })));
    await w.update((items) => {
      const i = items.find((x) => x.product_id === '1')!;
      i.target_price = 90;
    });
    expect(await w.list()).toEqual([item('1', { target_price: 90 })]);
    await w.update((items) => items.splice(0, 1));
    expect(await w.list()).toEqual([]);
  });

  it('does not lose concurrent adds, across instances of the same file', async () => {
    const file = join(dir(), 'watchlist.json');
    const a = new Watchlist(file);
    const b = new Watchlist(file);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).update((items) => items.push(item(String(i))))),
    );
    expect((await a.list()).map((i) => i.product_id).sort()).toEqual(Array.from({ length: 30 }, (_, i) => String(i)).sort());
  });

  it('leaves no temp files behind', async () => {
    const d = dir();
    const w = new Watchlist(join(d, 'watchlist.json'));
    await w.update((items) => items.push(item('1')));
    expect(readdirSync(d)).toEqual(['watchlist.json']);
  });

  it('recovers from a corrupt file with a warning', async () => {
    const d = dir();
    const file = join(d, 'watchlist.json');
    writeFileSync(file, '{not json');
    const w = new Watchlist(file, () => 123);
    const warnings: string[] = [];
    expect(await w.list(warnings)).toEqual([]);
    expect(warnings[0]).toContain('watchlist.json.corrupt-123');
    expect(readdirSync(d)).toEqual(['watchlist.json.corrupt-123']);
    await w.update((items) => items.push(item('1')));
    expect(await w.list()).toHaveLength(1);
  });
});

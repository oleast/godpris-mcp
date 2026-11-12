import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskCache, TtlCache } from '../../src/http/cache.js';

describe('TtlCache', () => {
  it('expires entries after ttl', () => {
    let t = 0;
    const c = new TtlCache<number>(100, 10, () => t);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    t = 101;
    expect(c.get('a')).toBeUndefined();
  });

  it('evicts least recently used beyond max size', () => {
    const c = new TtlCache<number>(1000, 2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('evicts LRU entries to stay under the byte budget', () => {
    // 'x'.repeat(10) = 20 bytes; budget 100 -> at most 5 entries fit, entries over 25 bytes are skipped
    const c = new TtlCache<string>(1000, 100, Date.now, 100);
    for (const k of ['a', 'b', 'c', 'd', 'e']) c.set(k, 'x'.repeat(10));
    expect(c.size).toBe(5);
    c.get('a');
    c.set('f', 'x'.repeat(10));
    expect(c.size).toBe(5);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
  });

  it('does not cache entries larger than a quarter of the budget', () => {
    const c = new TtlCache<string>(1000, 100, Date.now, 100);
    c.set('big', 'x'.repeat(13)); // 26 bytes > 25
    expect(c.get('big')).toBeUndefined();
    c.set('ok', 'x'.repeat(12)); // 24 bytes
    expect(c.get('ok')).toBeDefined();
  });

  it('releases bytes when entries are replaced or expire', () => {
    let t = 0;
    const c = new TtlCache<string>(10, 100, () => t, 100);
    for (let i = 0; i < 20; i++) c.set('same', 'x'.repeat(12));
    expect(c.size).toBe(1);
    c.set('b', 'y'.repeat(12));
    c.set('c', 'y'.repeat(12));
    c.set('d', 'y'.repeat(12));
    t = 11;
    expect(c.get('same')).toBeUndefined();
    c.set('e', 'z'.repeat(12));
    c.set('f', 'z'.repeat(12));
    expect(c.get('e')).toBeDefined();
  });
});

describe('DiskCache', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'godpris-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates dirs lazily, round-trips values, uses hashed filenames', async () => {
    const dir = join(root, 'nested', 'cache');
    const c = new DiskCache(dir, 1000);
    expect(await c.get('k')).toBeUndefined();
    await c.set('https://x/y?z=æøå', { a: [1, 2] });
    expect(await c.get('https://x/y?z=æøå')).toEqual({ a: [1, 2] });
    expect((await readdir(dir))[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('expires after ttl', async () => {
    let t = 1000;
    const c = new DiskCache(join(root, 'cache'), 500, () => t);
    await c.set('k', 'v');
    t = 1499;
    expect(await c.get('k')).toBe('v');
    t = 1500;
    expect(await c.get('k')).toBeUndefined();
  });
});

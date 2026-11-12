import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDiskCache } from '../../src/http/cache.js';
import { CategoryIndex } from '../../src/store/category-index.js';

const fresh = () => new CategoryIndex(createDiskCache(mkdtempSync(join(tmpdir(), 'godpris-idx-'))));

describe('CategoryIndex', () => {
  it('records and searches', async () => {
    const idx = fresh();
    await idx.record([
      { id: '1220', name: 'Vaskemaskin', path: ['Hvitevarer', 'Vaskemaskin'] },
      { id: '592', name: 'Kjøkken' },
    ]);
    const r = await idx.search('kjokken', 5);
    expect(r.map((c) => c.id)).toEqual(['592']);
    expect((await idx.search('vask', 5))[0]).toMatchObject({ id: '1220', path: ['Hvitevarer', 'Vaskemaskin'] });
    expect(await idx.search('tv', 5)).toEqual([]);
  });

  it('does not overwrite fields with empty values', async () => {
    const idx = fresh();
    await idx.record([{ id: '1', name: 'Foo', parent_id: '9', path: ['A', 'Foo'] }]);
    await idx.record([{ id: '1', name: 'Foo' }]);
    expect((await idx.search('foo', 1))[0]).toMatchObject({ parent_id: '9', path: ['A', 'Foo'] });
  });

  it('keeps concurrent records', async () => {
    const idx = fresh();
    await Promise.all(Array.from({ length: 20 }, (_, i) => idx.record([{ id: String(i + 1), name: `Kategori ${i + 1}` }])));
    expect((await idx.search('kategori', 50)).length).toBe(20);
  });
});

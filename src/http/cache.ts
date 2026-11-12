import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_TTL_MS = 600_000;
export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_DISK_TTL_MS = 24 * 60 * 60 * 1000;

interface Entry<T> {
  value: T;
  expires: number;
  bytes: number;
}

/** Rough memory footprint: JS strings are ~2 bytes per char. Strings are counted directly, other values via JSON. */
function approxBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 2;
  try {
    return (JSON.stringify(value) ?? '').length * 2;
  } catch {
    return 0;
  }
}

/** In-memory TTL cache with LRU eviction (Map insertion order). */
export class TtlCache<T = unknown> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  private totalBytes = 0;

  private drop(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.totalBytes -= e.bytes;
    this.map.delete(key);
  }

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.drop(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    this.drop(key);
    const bytes = approxBytes(value);
    if (bytes > this.maxBytes / 4) return; // too large to be worth caching
    this.map.set(key, { value, expires: this.now() + ttlMs, bytes });
    this.totalBytes += bytes;
    while (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

interface DiskRecord<T> {
  storedAt: number;
  value: T;
}

/** JSON-file cache for slow data. Directories are created lazily on first write. */
export class DiskCache {
  constructor(
    private readonly dir: string,
    private readonly ttlMs = DEFAULT_DISK_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private file(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  async get<T>(key: string, ttlMs = this.ttlMs): Promise<T | undefined> {
    try {
      const rec = JSON.parse(await readFile(this.file(key), 'utf8')) as DiskRecord<T>;
      if (typeof rec.storedAt !== 'number' || this.now() - rec.storedAt >= ttlMs) return undefined;
      return rec.value;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const file = this.file(key);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify({ storedAt: this.now(), value } satisfies DiskRecord<T>));
    await rename(tmp, file);
  }
}

/** Disk cache rooted at <dataDir>/cache. */
export function createDiskCache(dataDir: string, ttlMs = DEFAULT_DISK_TTL_MS): DiskCache {
  return new DiskCache(join(dataDir, 'cache'), ttlMs);
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolContext } from '../tools/index.js';

export const watchItemSchema = z.object({
  product_id: z.string(),
  title: z.string(),
  url: z.string(),
  target_price: z.number().optional(),
  note: z.string().optional(),
  added_at: z.string(),
  last_checked_at: z.string().optional(),
  last_price: z.number().optional(),
  last_shop: z.string().optional(),
  lowest_seen: z.number().optional(),
  lowest_seen_at: z.string().optional(),
});
export type WatchItem = z.infer<typeof watchItemSchema>;

const fileSchema = z.object({ version: z.literal(1), items: z.array(watchItemSchema) });

/** One chain for every watchlist in the process: all read-modify-write cycles are serialized. */
let chain: Promise<unknown> = Promise.resolve();

/** JSON watchlist file with an in-process mutex and atomic (temp file + rename) writes. */
export class Watchlist {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(warnings?: string[]): Promise<WatchItem[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      return fileSchema.parse(JSON.parse(raw)).items;
    } catch {
      const moved = `${this.file}.corrupt-${this.now()}`;
      await rename(this.file, moved).catch(() => undefined);
      warnings?.push(`watchlist file was unreadable; moved to ${moved} and started empty`);
      return [];
    }
  }

  private async save(items: WatchItem[]): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, items } satisfies z.infer<typeof fileSchema>, null, 2));
    await rename(tmp, this.file);
  }

  private locked<T>(run: () => Promise<T>): Promise<T> {
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    return result;
  }

  list(warnings?: string[]): Promise<WatchItem[]> {
    return this.locked(() => this.load(warnings));
  }

  /** Read-modify-write under the mutex. `fn` may mutate the array in place or return a new one via `set`. */
  update<T>(fn: (items: WatchItem[]) => T, warnings?: string[]): Promise<T> {
    return this.locked(async () => {
      const items = await this.load(warnings);
      const out = fn(items);
      await this.save(items);
      return out;
    });
  }
}

const lists = new Map<string, Watchlist>();

export function getWatchlist(ctx: ToolContext): Watchlist {
  const dir = ctx.config.dataDir;
  let w = lists.get(dir);
  if (!w) {
    w = new Watchlist(join(dir, 'watchlist.json'));
    lists.set(dir, w);
  }
  return w;
}

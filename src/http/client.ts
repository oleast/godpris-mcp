import { getConfig, type Config } from '../config.js';
import { TtlCache } from './cache.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Paths we never call (robots.txt disallows them / they need a login). */
export const BLOCKED_PATH_PREFIXES = ['/api/services/click', '/api/services/event', '/me/'];

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

export class NotFoundError extends Error {
  constructor(public readonly url: string) {
    super(`Not found: ${url}`);
    this.name = 'NotFoundError';
  }
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class BlockedPathError extends Error {
  constructor(path: string) {
    super(`Refusing to call blocked path: ${path}`);
    this.name = 'BlockedPathError';
  }
}

export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  /** Query parameters; undefined/null values are skipped, arrays repeat the key. */
  query?: Query;
  /** Treat HTTP 500 as "not found" (the site returns 500 for unknown ids on some endpoints). */
  notFoundOn500?: boolean;
  /** Override the cache TTL for this call. */
  ttlMs?: number;
  /** Skip the cache for this call. */
  noCache?: boolean;
}

/** Minimal GET interface shared by the client and scoped (counting) views. */
export interface HttpClient {
  getJson<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  getHtml(path: string, opts?: RequestOptions): Promise<string>;
}

export interface ScopedClient extends HttpClient {
  /** Network requests made through this view (cache hits excluded; retries included). */
  readonly requests: number;
}

export interface ClientOptions {
  baseUrl: string;
  /** Requests per second (default 1). */
  rps?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  /** Per-request timeout (default 15000). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  cache?: TtlCache<unknown>;
}

type Kind = 'json' | 'html';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GodprisClient implements HttpClient {
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly maxConcurrency: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly cache: TtlCache<unknown>;

  private nextSlot = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private total = 0;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.intervalMs = 1000 / (opts.rps ?? 1);
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.cache = opts.cache ?? new TtlCache<unknown>();
  }

  /** Total network requests made by this client instance. */
  get requests(): number {
    return this.total;
  }

  getJson<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('json', path, opts, undefined);
  }

  getHtml(path: string, opts?: RequestOptions): Promise<string> {
    return this.request<string>('html', path, opts, undefined);
  }

  /** A view that shares cache and rate limiter but counts its own network requests. */
  withCounter(): ScopedClient {
    const counter = { n: 0 };
    return {
      getJson: <T = unknown>(path: string, opts?: RequestOptions) => this.request<T>('json', path, opts, counter),
      getHtml: (path: string, opts?: RequestOptions) => this.request<string>('html', path, opts, counter),
      get requests() {
        return counter.n;
      },
    };
  }

  /** Resolve against the base URL and enforce the block-list and same-origin rule. */
  private resolve(path: string, query?: RequestOptions['query']): URL {
    const base = new URL(this.baseUrl);
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== base.origin) throw new BlockedPathError(path);
    const p = url.pathname;
    if (BLOCKED_PATH_PREFIXES.some((b) => p.startsWith(b) || p === b.replace(/\/$/, ''))) {
      throw new BlockedPathError(path);
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
    return url;
  }

  private async request<T>(
    kind: Kind,
    path: string,
    opts: RequestOptions = {},
    counter: { n: number } | undefined,
  ): Promise<T> {
    const url = this.resolve(path, opts.query);
    const href = url.toString();
    const key = `${kind}:${href}`;

    if (!opts.noCache) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit as T;
    }

    const headers: Record<string, string> =
      kind === 'json'
        ? {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.5',
          }
        : {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.5',
          };

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let retryAfterMs: number | undefined;
      await this.acquireConcurrency();
      try {
        let res: Response | undefined;
        let current = href;
        for (let hop = 0; ; hop++) {
          await this.waitForSlot();
          this.total++;
          if (counter) counter.n++;
          try {
            res = await this.fetchFn(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
          } catch (err) {
            lastError = new UpstreamError(`Network error for ${current}: ${(err as Error).message}`, current);
            res = undefined;
            break;
          }
          if (!REDIRECT_STATUSES.has(res.status)) break;
          const location = res.headers.get('location');
          if (!location) throw new UpstreamError(`HTTP ${res.status} without Location for ${current}`, current, res.status);
          if (hop >= MAX_REDIRECTS) throw new UpstreamError(`Too many redirects for ${href}`, href, res.status);
          // Same block-list and same-origin rules as the initial request.
          current = this.resolve(new URL(location, current).toString()).toString();
        }
        if (res) {
          if (res.status === 404 || (res.status === 500 && opts.notFoundOn500)) {
            throw new NotFoundError(href);
          }
          if (res.ok) {
            let value: T;
            try {
              value = (kind === 'json' ? await res.json() : await res.text()) as T;
            } catch (err) {
              if (err instanceof SyntaxError) {
                throw new UpstreamError(`godpris.no returned non-JSON for ${href}: ${err.message}`, href, res.status);
              }
              throw new UpstreamError(`Failed to read response body for ${href}: ${(err as Error).message}`, href);
            }
            if (!opts.noCache) this.cache.set(key, value, opts.ttlMs);
            return value;
          }
          lastError = new UpstreamError(`HTTP ${res.status} for ${href}`, href, res.status);
          if (!RETRY_STATUSES.has(res.status)) throw lastError;
          retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        }
      } finally {
        this.releaseConcurrency();
      }
      if (attempt < this.maxAttempts) {
        await sleep(retryAfterMs ?? this.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new UpstreamError(`Request failed for ${href}`, href);
  }

  /** Token bucket with burst 1: reserve the next free slot, spaced 1/rps apart. */
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await sleep(slot - now);
  }

  private async acquireConcurrency(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private releaseConcurrency(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot over directly
    else this.active--;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  let ms: number;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const date = Date.parse(value);
    if (Number.isNaN(date)) return undefined;
    ms = date - Date.now();
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

let singleton: GodprisClient | undefined;

/** Process-wide client: one cache and one rate limiter shared by every MCP server instance. */
export function getClient(config: Config = getConfig()): GodprisClient {
  return (singleton ??= new GodprisClient({ baseUrl: config.baseUrl, rps: config.rps, timeoutMs: config.timeoutMs }));
}

/** Test helper: drop the singleton. */
export function resetClient(): void {
  singleton = undefined;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedPathError, GodprisClient, NotFoundError, UpstreamError } from '../../src/http/client.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function make(fetchFn: ReturnType<typeof vi.fn>, extra: Partial<ConstructorParameters<typeof GodprisClient>[0]> = {}) {
  return new GodprisClient({ baseUrl: 'https://godpris.test', rps: 1000, fetch: fetchFn as unknown as typeof fetch, ...extra });
}

describe('GodprisClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves relative paths, sends browser-like headers', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: 1 }));
    const c = make(f);
    await expect(c.getJson('/api/product/search', { query: { q: 'iphone', l: 5, skip: undefined } })).resolves.toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://godpris.test/api/product/search?q=iphone&l=5');
    expect(init.headers['User-Agent']).toMatch(/Mozilla\/5\.0.*Chrome/);
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('getHtml sends text/html accept', async () => {
    const f = vi.fn().mockResolvedValue(new Response('<p>hi</p>'));
    await expect(make(f).getHtml('/sok')).resolves.toBe('<p>hi</p>');
    expect(f.mock.calls[0]![1].headers.Accept).toMatch(/^text\/html/);
  });

  it('spaces requests by 1/rps', async () => {
    const times: number[] = [];
    const f = vi.fn().mockImplementation(async () => {
      times.push(Date.now());
      return json({});
    });
    const c = make(f, { rps: 1 });
    const all = Promise.all([c.getJson('/a'), c.getJson('/b'), c.getJson('/c')]);
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1000);
  });

  it('limits concurrency to 2', async () => {
    let active = 0;
    let max = 0;
    const f = vi.fn().mockImplementation(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
      return json({});
    });
    const c = make(f);
    const all = Promise.all(['/a', '/b', '/c', '/d'].map((p) => c.getJson(p)));
    await vi.advanceTimersByTimeAsync(2000);
    await all;
    expect(max).toBe(2);
  });

  it('retries 503 with backoff then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(json({ ok: true }));
    const c = make(f);
    const p = c.getJson('/x');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors and gives up after 3 attempts', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const c = make(f);
    const p = c.getJson('/x');
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('respects Retry-After', async () => {
    const times: number[] = [];
    const f = vi.fn().mockImplementation(async () => {
      times.push(Date.now());
      return times.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : json({});
    });
    const p = make(f).getJson('/x');
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(7000);
  });

  it('maps 404 to NotFoundError and does not retry', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    await expect(make(f).getJson('/x')).rejects.toBeInstanceOf(NotFoundError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('maps 500 to NotFoundError only with notFoundOn500', async () => {
    vi.useRealTimers(); // sequential awaits with 1ms rate spacing
    const f = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const c = make(f);
    await expect(c.getJson('/x', { notFoundOn500: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.getJson('/y')).rejects.toBeInstanceOf(UpstreamError);
  });

  it.each(['/api/services/click', '/api/services/event?x=1', '/me/lists', '/me/', '//godpris.test/me/x', '/a/../me/x'])(
    'blocks %s',
    async (path) => {
      const f = vi.fn();
      await expect(make(f).getHtml(path)).rejects.toBeInstanceOf(BlockedPathError);
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('refuses other origins', async () => {
    const f = vi.fn();
    await expect(make(f).getHtml('https://evil.example/x')).rejects.toBeInstanceOf(BlockedPathError);
  });

  it('cache hit avoids second fetch and does not count as a request', async () => {
    vi.useRealTimers(); // sequential awaits with 1ms rate spacing
    const f = vi.fn().mockImplementation(async () => json({ n: 1 }));
    const c = make(f);
    const scoped = c.withCounter();
    await scoped.getJson('/x');
    await scoped.getJson('/x');
    await c.getJson('/x');
    expect(f).toHaveBeenCalledTimes(1);
    expect(scoped.requests).toBe(1);
    expect(c.requests).toBe(1);
    await c.getJson('/x', { noCache: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('scoped counters are independent', async () => {
    vi.useRealTimers(); // sequential awaits with 1ms rate spacing
    const f = vi.fn().mockImplementation(async () => json({}));
    const c = make(f);
    const a = c.withCounter();
    const b = c.withCounter();
    await a.getJson('/1');
    await a.getJson('/2');
    await b.getJson('/3');
    expect(a.requests).toBe(2);
    expect(b.requests).toBe(1);
  });

  describe('redirects, timeout and bad bodies', () => {
    beforeEach(() => {
      vi.useRealTimers(); // rps 1000 keeps rate spacing at 1ms
    });

    const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

    it('follows an allowed redirect manually and counts both hops', async () => {
      const f = vi
        .fn()
        .mockResolvedValueOnce(redirect('/api/new'))
        .mockResolvedValueOnce(json({ ok: 1 }));
      const c = make(f);
      const scoped = c.withCounter();
      await expect(scoped.getJson('/api/old')).resolves.toEqual({ ok: 1 });
      expect(f.mock.calls[0]![1].redirect).toBe('manual');
      expect(f.mock.calls[1]![0]).toBe('https://godpris.test/api/new');
      expect(scoped.requests).toBe(2);
      expect(c.requests).toBe(2);
    });

    it('blocks redirects to blocked paths and other hosts', async () => {
      const f1 = vi.fn().mockResolvedValue(redirect('/me/x'));
      await expect(make(f1).getJson('/a')).rejects.toBeInstanceOf(BlockedPathError);
      expect(f1).toHaveBeenCalledTimes(1);
      const f2 = vi.fn().mockResolvedValue(redirect('https://evil.example/x', 301));
      await expect(make(f2).getJson('/a')).rejects.toBeInstanceOf(BlockedPathError);
      expect(f2).toHaveBeenCalledTimes(1);
    });

    it('gives up after 3 redirects', async () => {
      const f = vi.fn().mockImplementation(async () => redirect('/loop', 307));
      await expect(make(f).getJson('/a')).rejects.toBeInstanceOf(UpstreamError);
      expect(f).toHaveBeenCalledTimes(4);
    });

    it('times out hung requests and reports an UpstreamError after retries', async () => {
      const f = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      );
      const c = make(f, { timeoutMs: 20, maxAttempts: 2, backoffBaseMs: 1 });
      await expect(c.getJson('/slow')).rejects.toBeInstanceOf(UpstreamError);
      expect(f).toHaveBeenCalledTimes(2);
    });

    it('wraps non-JSON 200 bodies in an UpstreamError without retrying', async () => {
      const f = vi.fn().mockImplementation(async () => new Response('<html>oops</html>', { status: 200 }));
      await expect(make(f).getJson('/x')).rejects.toThrow(/non-JSON/);
      await expect(make(f).getJson('/y')).rejects.toBeInstanceOf(UpstreamError);
      expect(f).toHaveBeenCalledTimes(2);
    });
  });
});

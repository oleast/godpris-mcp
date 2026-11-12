import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConfig } from '../../src/config.js';
import { TtlCache, type DiskCache } from '../../src/http/cache.js';
import { GodprisClient } from '../../src/http/client.js';
import { createServer } from '../../src/server.js';
import { fixture } from '../parsers/helpers.js';

export interface Route {
  path: string | RegExp;
  file?: string;
  /** Raw response body (takes precedence over file/json). */
  body?: string;
  json?: unknown;
  status?: number;
  /** Required query params; null means the param must be absent. First matching route wins. */
  query?: Record<string, string | null>;
}

export async function connectTools(routes: Route[], opts: { now?: Date; env?: Record<string, string>; disk?: DiskCache } = {}) {
  const calls: URL[] = [];
  const unexpected: URL[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const route = routes.find(
      (r) =>
        (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)) &&
        Object.entries(r.query ?? {}).every(([k, v]) => (v === null ? !url.searchParams.has(k) : url.searchParams.get(k) === v)),
    );
    if (!route) {
      unexpected.push(url);
      return new Response('unexpected', { status: 418 });
    }
    const status = route.status ?? 200;
    if (status >= 400 && route.file === undefined && route.json === undefined && route.body === undefined) return new Response('error', { status });
    const body = route.body !== undefined ? route.body : route.file !== undefined ? fixture(route.file) : JSON.stringify(route.json);
    return new Response(body, { status });
  }) as typeof fetch;

  const config = createConfig({ GODPRIS_DATA_DIR: mkdtempSync(join(tmpdir(), 'godpris-')), ...opts.env });
  const client = new GodprisClient({
    baseUrl: 'https://godpris.no',
    rps: 1000,
    fetch: fakeFetch,
    cache: new TtlCache(),
    maxAttempts: 1,
    backoffBaseMs: 1,
  });
  const now = opts.now ?? new Date('2026-11-11T12:00:00Z');
  const server = createServer({ config, client, now: () => now, ...(opts.disk ? { disk: opts.disk } : {}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  await mcp.listTools(); // caches output validators so AJV validates every structuredContent

  return {
    client: mcp,
    calls,
    unexpected,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

export function text(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? []).map((c) => c.text ?? '').join('\n');
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request } from 'node:http';
import { createConfig } from '../../src/config.js';
import { getClient } from '../../src/http/client.js';
import { toolRegistrations } from '../../src/tools/index.js';
import { startHttpServer, type RunningHttpServer } from '../../src/transports/http.js';

let running: RunningHttpServer;

toolRegistrations.push((server) => {
  server.registerTool('ping', { description: 'test tool' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
});

toolRegistrations.push((server) => {
  server.registerTool('progress-ping', { description: 'test tool' }, async (extra) => {
    const progressToken = extra._meta?.progressToken;
    if (progressToken !== undefined) {
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 2 } });
    }
    return { content: [{ type: 'text', text: 'done' }] };
  });
});

/** node:http request so the Host header can be overridden (fetch cannot). */
function rawStatus(base: string, path: string, method: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject).end();
  });
}

beforeEach(async () => {
  const config = createConfig({ GODPRIS_DATA_DIR: '/tmp/godpris-mcp-test' });
  running = await startHttpServer({ host: '127.0.0.1', port: 0, ctx: { config, client: getClient(config) } });
});

afterEach(async () => {
  await running.close();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
  return client;
}

describe('http transport', () => {
  it('serves healthz', async () => {
    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('returns 404 for unknown paths', async () => {
    expect((await fetch(`${running.url}/nope`)).status).toBe(404);
  });

  it('returns 405 for GET and DELETE /mcp', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${running.url}/mcp`, { method });
      expect(res.status).toBe(405);
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    }
  });

  it('rejects invalid JSON', async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-local Host headers when bound to localhost', async () => {
    // fetch() cannot override Host, so use node:http directly.
    expect(await rawStatus(running.url, '/mcp', 'POST', { Host: 'evil.example.com' })).toBe(403);
  });

  it('serves healthz regardless of Host header', async () => {
    expect(await rawStatus(running.url, '/healthz', 'GET', { Host: 'evil.example.com' })).toBe(200);
  });

  it('rejects foreign Origin but accepts loopback Origin and no Origin', async () => {
    expect(await rawStatus(running.url, '/mcp', 'POST', { Origin: 'http://evil.example' })).toBe(403);
    expect(await rawStatus(running.url, '/mcp', 'POST', { Origin: 'null' })).toBe(403);
    expect(await rawStatus(running.url, '/mcp', 'GET', { Origin: 'http://localhost:6274' })).toBe(405);
    expect(await rawStatus(running.url, '/mcp', 'GET')).toBe(405);
  });

  it('keeps GODPRIS_ALLOWED_HOSTS when an explicit host is passed, and honours allowed origins', async () => {
    const config = createConfig({ GODPRIS_DATA_DIR: '/tmp/godpris-mcp-test', GODPRIS_ALLOWED_HOSTS: 'mcp.example.com', GODPRIS_ALLOWED_ORIGINS: 'http://inspector.test:6274' });
    const s = await startHttpServer({ host: '127.0.0.1', port: 0, ctx: { config, client: getClient(config) } });
    try {
      expect(await rawStatus(s.url, '/mcp', 'GET', { Host: 'evil.example' })).toBe(403);
      expect(await rawStatus(s.url, '/healthz', 'GET', { Host: '127.0.0.1:3333' })).toBe(200);
      expect(await rawStatus(s.url, '/mcp', 'GET', { Host: 'mcp.example.com' })).toBe(405);
      expect(await rawStatus(s.url, '/mcp', 'GET', { Host: 'mcp.example.com', Origin: 'http://evil.example' })).toBe(403);
      expect(await rawStatus(s.url, '/mcp', 'GET', { Host: 'mcp.example.com', Origin: 'https://mcp.example.com' })).toBe(405);
      expect(await rawStatus(s.url, '/mcp', 'GET', { Host: 'mcp.example.com', Origin: 'http://inspector.test:6274' })).toBe(405);
    } finally {
      await s.close();
    }
  });

  it('responds to POST with an SSE body when the client accepts it', async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'curl', version: '0' } } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(await res.text()).toContain('"serverInfo"');
  });

  it('delivers progress notifications to the client', async () => {
    const client = await connect();
    const seen: number[] = [];
    await client.callTool({ name: 'progress-ping', arguments: {} }, undefined, { onprogress: (p) => seen.push(p.progress) });
    expect(seen).toEqual([1]);
    await client.close();
  });

  it('handles two sequential stateless client connections', async () => {
    for (let i = 0; i < 2; i++) {
      const client = await connect();
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('ping');
      await client.close();
    }
  });
});

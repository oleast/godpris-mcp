import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConfig } from '../config.js';
import { getClient } from '../http/client.js';
import { createServer } from '../server.js';
import type { ToolContext } from '../tools/index.js';

const MAX_BODY_BYTES = 1024 * 1024;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export interface HttpServerOptions {
  host?: string;
  port?: number;
  ctx?: ToolContext;
  /** Overrides GODPRIS_ALLOWED_HOSTS (tests). */
  allowedHosts?: string[];
  /** Overrides GODPRIS_ALLOWED_ORIGINS (tests). */
  allowedOrigins?: string[];
}

export interface RunningHttpServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Parse error: invalid JSON', -32700);
  }
}

/** Hostname part of a Host header (port stripped, IPv6 brackets kept), lowercased. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? h;
}

/** Allowed hostnames for DNS-rebinding protection; undefined means no restriction. */
function resolveAllowedHosts(host: string, configured?: string[]): string[] | undefined {
  if (configured?.length) return configured.map((h) => hostnameOf(h));
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return LOCAL_HOSTS;
  return undefined;
}

/** Whether a browser Origin header may call /mcp: loopback origins, allowed hosts, or explicitly listed origins. */
function isOriginAllowed(origin: string, allowedHosts: string[] | undefined, allowedOrigins: string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (LOCAL_HOSTS.includes(url.hostname.toLowerCase())) return true;
  if (allowedHosts?.includes(url.hostname.toLowerCase())) return true;
  return allowedOrigins.some((o) => {
    try {
      return new URL(o).origin === url.origin;
    } catch {
      return o === origin;
    }
  });
}

function log(msg: string): void {
  console.error(`[godpris-mcp] ${msg}`);
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const config = opts.ctx?.config ?? getConfig();
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;
  const ctx: ToolContext = opts.ctx ?? { config, client: getClient(config) };
  const allowedHosts = resolveAllowedHosts(host, opts.allowedHosts ?? config.allowedHosts);
  const allowedOrigins = opts.allowedOrigins ?? config.allowedOrigins ?? [];

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      rpcError(res, 405, -32000, 'Method not allowed (stateless server: use POST)', { Allow: 'POST' });
      return;
    }
    const body = await readJsonBody(req);
    const mcp = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (path === '/healthz' && req.method === 'GET') {
          // Before the Host/Origin checks so container healthchecks work; reveals only status and version.
          sendJson(res, 200, { status: 'ok', version: config.version });
        } else if (allowedHosts && !allowedHosts.includes(hostnameOf(req.headers.host ?? ''))) {
          rpcError(res, 403, -32000, `Invalid Host header: ${req.headers.host ?? ''}`);
        } else if (path === '/mcp' && req.headers.origin !== undefined && !isOriginAllowed(req.headers.origin, allowedHosts, allowedOrigins)) {
          rpcError(res, 403, -32000, `Invalid Origin header: ${req.headers.origin}`);
        } else if (path === '/mcp') {
          await handleMcp(req, res);
        } else {
          sendJson(res, 404, { error: 'Not found' });
        }
      } catch (err) {
        if (err instanceof HttpError) {
          rpcError(res, err.status, err.code, err.message);
        } else {
          log(`request error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          rpcError(res, 500, -32603, 'Internal server error');
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const urlHost = addr.address.includes(':') ? `[${addr.address}]` : addr.address;
  return {
    server,
    url: `http://${urlHost}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export async function runHttp(opts: HttpServerOptions = {}): Promise<void> {
  const running = await startHttpServer(opts);
  log(`Streamable HTTP listening on ${running.url}/mcp`);
  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

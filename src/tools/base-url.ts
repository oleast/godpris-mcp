import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BASE_URL } from '../parsers/util.js';

function rewrite<T>(value: T, base: string): T {
  if (typeof value === 'string') return value.split(BASE_URL).join(base) as T;
  if (Array.isArray(value)) return value.map((v) => rewrite(v, base)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, base)])) as T;
  }
  return value;
}

/**
 * Output links are built against the default godpris.no origin (parsers, URL helpers); when
 * GODPRIS_BASE_URL points elsewhere, rewrite every tool result so links follow the configured origin.
 */
export function withBaseUrl(server: McpServer, baseUrl: string): McpServer {
  if (baseUrl === BASE_URL) return server;
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (name: string, config: any, cb: (...a: any[]) => Promise<CallToolResult>) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (target.registerTool as any)(name, config, async (...a: any[]) => {
            const res = await cb(...a);
            return res.isError ? res : rewrite(res, baseUrl);
          });
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

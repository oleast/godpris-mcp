import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConfig, type Config } from './config.js';
import { getClient } from './http/client.js';
import { promptRegistrations } from './prompts.js';
import { withBaseUrl } from './tools/base-url.js';
import { toolRegistrations, type ToolContext } from './tools/index.js';

export { toolResult, toolError } from './tools/result.js';

export const SERVER_INSTRUCTIONS = `Read-only access to godpris.no (Norwegian price comparison). Prices are whole NOK.

Where to start:
- Product name -> search_products (ids). Category name -> find_category.
- "Should I buy this now?" -> evaluate_purchase (recommendation buy_now / ok / wait / unknown).
- Specs and requirements -> find_products_by_requirements. Prefer the site's Norwegian labels (e.g. "Vaskekapasitet"); give min/max for numbers and values for options. If unmatched_requirements comes back, retry with labels from available_filters, or call browse_category with browse_filters as its filters.
- Deals -> hunt_deals, not get_deals: it checks price history for the top verify_history_top candidates and ranks them all_time_low > genuine > modest > unverified > inflated; the remaining rows are unverified.

Conventions:
- Site labels (God pris / OK / Kanskje, Ja / Nei, filter values, outlet and shop names) are Norwegian; pass them back unchanged.
- Offers marked "Kun til bedrift" are not for private customers.
- The watchlist is local and has no notifications; a target hit only shows when watchlist_check is called.

The server is rate-limited (by default 1 request/second) for personal use. Prefer the composite tools and keep max_pages, verify_history_top and top_n low.`;

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const target = withBaseUrl(server, ctx.config.baseUrl);
  for (const register of toolRegistrations) register(target, ctx);
}

export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  for (const register of promptRegistrations) register(server, ctx);
}

/** Create a fresh McpServer (one per HTTP request in stateless mode). Client/cache are process-wide. */
export function createServer(ctx?: ToolContext): McpServer {
  const config: Config = ctx?.config ?? getConfig();
  const context: ToolContext = ctx ?? { config, client: getClient(config) };
  const server = new McpServer({ name: 'godpris', version: config.version }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, context);
  registerPrompts(server, context);
  return server;
}

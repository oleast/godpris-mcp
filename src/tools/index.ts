import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { DiskCache } from '../http/cache.js';
import type { GodprisClient } from '../http/client.js';
import { registerCategoryTools } from './categories.js';
import { registerCompareTools } from './compare.js';
import { registerCompositeTools } from './composite/index.js';
import { registerDiscoverTools } from './discover.js';
import { registerHistoryTools } from './history.js';
import { registerProductTools } from './product.js';
import { registerSearchTools } from './search.js';
import { registerSitemapTools } from './sitemap.js';
import { registerStoreTools } from './stores.js';
import { registerTestTools } from './tests.js';
import { registerWatchlistTools } from './watchlist.js';

/** Shared dependencies handed to every tool/prompt registration function. */
export interface ToolContext {
  client: GodprisClient;
  config: Config;
  /** Disk cache override (default: memoized cache under config.dataDir). */
  disk?: DiskCache;
  /** Clock override for tests (default: new Date()). */
  now?: () => Date;
}

export type Registration = (server: McpServer, ctx: ToolContext) => void;

/** Tool registration functions; later steps append one per tool group. */
export const toolRegistrations: Registration[] = [
  registerSearchTools,
  registerCategoryTools,
  registerProductTools,
  registerHistoryTools,
  registerWatchlistTools,
  registerSitemapTools,
  registerCompareTools,
  registerDiscoverTools,
  registerTestTools,
  registerStoreTools,
  registerCompositeTools,
];

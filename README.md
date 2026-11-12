# godpris-mcp

An unofficial, read-only [MCP](https://modelcontextprotocol.io) server for **[godpris.no](https://godpris.no)**, the Norwegian price-comparison site. It lets any MCP-capable LLM client do the following:
- search products;
- browse categories with spec filters;
- compare shop offers;
- read price history and the site's own "good time to buy?" verdict;
- hunt deals;
- keep a local price watchlist.

> Personal, single-user tool. godpris.no's terms allow personal, non-commercial use and forbid systematic extraction. The server rate-limits to 1 request/second, caches responses, caps bulk tools at a fixed number of pages, and never calls the click-tracking, analytics or account endpoints. See [docs/FEATURES.md](docs/FEATURES.md).

## Tools

All prices are integer NOK. Site labels (filters, specs, availability, verdict zones) are kept in Norwegian. Every tool returns markdown text, and also `structuredContent` for clients that use it.

| Tool | Use it to… |
|---|---|
| `search_products` | Turn a product name into ids and see matching categories (autocomplete) |
| `search_listing` | Get full free-text search results with sort, brand, price and record-low filters |
| `list_categories` / `find_category` | Browse the category tree / find a category id by name |
| `get_category_filters` | See which spec filters a category has (keys, ranges, options) |
| `browse_category` | List a category's products, filtered by specs, brand, price, discount or record low |
| `get_product` | See every shop offer, specs, expert tests, variants, alternatives and click-and-collect for one product |
| `get_price_history` | See today's price compared with the 90-day and all-time lows, plus the site's God pris / OK / Kanskje verdict |
| `compare_products` | Compare the specs of 2–6 products side by side |
| `get_deals` | Browse current discounts and campaign pages (Black Friday, Singles Day, …) |
| `get_expert_tests` | Read expert reviews (Tek.no, Lyd & Bilde, …) linked to products |
| `get_gift_ideas` | Get gift ideas by recipient |
| `get_trending` | See today's deals and the most-watched products |
| `list_stores` / `get_store` | Browse the shop directory and view one shop's details |
| `evaluate_purchase` | Get a single answer to "should I buy this now?" (offers + history + verdict) |
| `find_products_by_requirements` | Name a product type and requirements; the server maps them to filters and returns ranked matches |
| `hunt_deals` | Scan deals or categories and keep only genuine discounts, checked against price history |
| `scan_category` | Walk several pages of a filtered category into one list |
| `compare_best_options` | Compare the top options for a query or category, specs and price history together |
| `watchlist_add` / `watchlist_remove` / `watchlist_list` / `watchlist_check` | Keep a local price watchlist; no godpris account needed |
| `list_sitemap` | Enumerate category, shop and product ids |

Prompts: `deal-hunt`, `should-i-buy`, `find-by-requirements`.

## Run it

### Homelab (recommended): Docker, Streamable HTTP
GitHub Actions publishes a multi-arch image (amd64 and arm64) to GHCR on every release. On the homelab:

1. Log in to GHCR, using a PAT with `read:packages`:
   ```bash
   docker login ghcr.io
   ```
2. Edit `compose.yaml` and replace `OWNER` with your GitHub user.
3. Start the server:
   ```bash
   docker compose up -d
   ```
4. Check that it is up:
   ```bash
   curl http://<homelab>:3333/healthz
   ```

The MCP endpoint is `http://<homelab>:3333/mcp`. It runs stateless, has no auth, and is meant to be reached over your VPN only. The watchlist and disk cache live in the `godpris-data` volume (`/data`).

### Local
Build and run over stdio:

```bash
npm ci && npm run build
```

```bash
node dist/index.js
```

Or run it as a Streamable HTTP server on 127.0.0.1:3333:

```bash
node dist/index.js --http
```

Docker stdio (each client session starts a container):

```bash
docker run -i --rm -v godpris-data:/data ghcr.io/OWNER/godpris-mcp:latest node dist/index.js
```

### Configuration (env)
| Variable | Default | Meaning |
|---|---|---|
| `GODPRIS_TRANSPORT` | `stdio` (`http` in Docker) | `stdio` or `http` (`--http` flag also works) |
| `GODPRIS_HOST` / `GODPRIS_PORT` | `127.0.0.1` / `3333` (`0.0.0.0` in Docker) | HTTP bind address (`--host`, `--port`) |
| `GODPRIS_ALLOWED_HOSTS` | unset | Comma list of allowed `Host` headers. When unset, a localhost bind accepts only localhost, and other binds are open. `/healthz` is always served |
| `GODPRIS_ALLOWED_ORIGINS` | unset | Comma list of browser origins allowed to call `/mcp`, e.g. `http://localhost:6274`. Requests with an `Origin` header are rejected (403) unless it is loopback, its host is in `GODPRIS_ALLOWED_HOSTS`, or it is listed here. Requests without `Origin` (CLI/desktop clients, curl) always pass |
| `GODPRIS_TIMEOUT_MS` | `15000` | Per-request timeout towards godpris.no |
| `GODPRIS_RPS` | `1` | Max requests per second to godpris.no |
| `GODPRIS_MAX_PAGES` | `10` | Page cap for the bulk tools |
| `GODPRIS_DATA_DIR` | `~/.godpris-mcp` (`/data` in Docker) | Watchlist and disk cache |
| `GODPRIS_BASE_URL` | `https://godpris.no` | Site base URL |

Browser-based clients such as MCP Inspector send an `Origin` header; when the server is not on localhost, list their origin in `GODPRIS_ALLOWED_ORIGINS`.

## Connect a client
Replace `http://homelab:3333/mcp` with your server's URL.

**Claude Code**
```bash
claude mcp add --transport http godpris http://homelab:3333/mcp
```

**Claude Desktop.** Its built-in custom connectors are reached from Anthropic's cloud and can't see a VPN-only host. Bridge the server locally with `mcp-remote` in `claude_desktop_config.json`:
```json
{ "mcpServers": { "godpris": { "command": "npx", "args": ["-y", "mcp-remote", "http://homelab:3333/mcp", "--allow-http"] } } }
```

**VS Code / GitHub Copilot** (`.vscode/mcp.json` or user settings)
```json
{ "servers": { "godpris": { "type": "http", "url": "http://homelab:3333/mcp" } } }
```

**Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "godpris": { "httpUrl": "http://homelab:3333/mcp" } } }
```

**LM Studio and other local LLM hosts** (`mcp.json`)
```json
{ "mcpServers": { "godpris": { "url": "http://homelab:3333/mcp" } } }
```

**Any stdio-only client:** use the Docker stdio command above as `command` + `args`.

## Development
| Command | What it does |
|---|---|
| `npm test` | Offline tests: parsers on saved fixtures, tools through an in-memory MCP client, HTTP transport |
| `npm run smoke` | Live end-to-end check against godpris.no (about 20 requests) |
| `npm run refresh-fixtures -- --dry-run` | Re-download the test fixtures after a site change (drop `--dry-run` to write) |
| `npm run inspect` | MCP Inspector over stdio |

Fixtures in `test/fixtures` are saved site responses (see its README). Design specs for the larger steps are in `docs/specs/`.

### Releases
Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `feat!:`). The workflows:
- `ci.yml` runs typecheck, tests, build and a docker build on every push and PR.
- `release.yml` runs semantic-release on `main`. It creates the tag and GitHub release, then pushes `ghcr.io/<owner>/godpris-mcp:{X.Y.Z,X.Y,X,latest}`.
- `smoke.yml` runs the live smoke test weekly to catch site drift.

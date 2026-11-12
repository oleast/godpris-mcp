## Step spec: Step 5. Atomic tools 1–7 (search, categories, filters, browse, product, history)

### Goal
Register 8 read-only MCP tools: `search_products`, `search_listing`, `list_categories`, `find_category`, `get_category_filters`, `browse_category`, `get_product` and `get_price_history`. `find_category` is its own tool, which matches the plan's "one tool per feature".
- Every tool returns full markdown text, plus `structuredContent` that validates against an `outputSchema`.
- Input schemas stay flat and portable.
- The step adds two new parsers (`product.ts`, `history.ts`), a small autocomplete parser, a disk-backed category index and the shared tool helpers.

### Verified SDK facts (installed @modelcontextprotocol/sdk 1.32.2, zod 4.6.7)
I checked these with throwaway scripts.
- `registerTool(name, {title, description, inputSchema, outputSchema, annotations}, cb)`. `inputSchema` accepts either a raw zod shape or a `z.object`.
  - Conversion uses `z4mini.toJSONSchema(..., {target:'draft-7', io:'input'|'output'})`.
  - Output is clean: no `$ref` and no `anyOf`.
  - `.describe()` becomes `description`; `.default(x)` becomes `default` and the field drops out of `required`; `z.enum` becomes `{type:string, enum}`; arrays of objects come out clean.
  - `z.coerce.string()` becomes `{type:string}` and `z.coerce.number().int().min(a).max(b)` becomes `{type:integer, minimum, maximum}`. Both accept `794250` as well as `"794250"` at runtime.
- **Pitfall:** `.int()` without explicit `.min()/.max()` emits `minimum:-9007199254740991`/`maximum:9007199254740991`. Every integer input must have explicit min and max.
- **Pitfall:** `.nullable()` emits `type:["number","null"]`. Never use it in inputs.
- **The outputSchema must match exactly:**
  - Server-side, the SDK runs zod `safeParse`, which silently strips unknown keys.
  - Client-side, the SDK `Client.callTool` validates `structuredContent` with AJV. It only does this after `listTools()` has cached the validators.
  - In `io:'output'` mode every `z.object` gets `additionalProperties:false`, so any extra key fails on the client ("must NOT have additional properties").
  - So always build structuredContent as `outputSchema.parse(obj)`, which strips extras, and include `warnings: z.array(z.string()).optional()` in every output schema, because `toolResult` merges `warnings` in.
  - isError results skip validation on both sides.
- `$schema: draft-07` is always emitted. That is fine for Claude and Copilot. Gemini portability is a later concern; no action here.
- Cheerio finds elements inside `<template>` (verified: `[data-ntb-zone]` inside `template[data-history-slot]` is matched).

---

### Changes

#### 1. `/Users/oleast/git/test/godpirs-mcp/src/http/client.ts`
- Export the existing `type QueryValue`, and add `export type Query = Record<string, QueryValue>;`. No behaviour change.

#### 2. `/Users/oleast/git/test/godpirs-mcp/src/tools/index.ts`
- Extend `ToolContext` with:
  - `disk?: DiskCache`: when absent, tools use a memoized `createDiskCache(config.dataDir)`.
  - `now?: () => Date`: a test hook; the default is `new Date()`.
- Replace the empty array with `export const toolRegistrations: Registration[] = [registerSearchTools, registerCategoryTools, registerProductTools, registerHistoryTools];`. The tool modules must import `ToolContext`/`Registration` with `import type`, to avoid a runtime cycle. `test/transports/http.test.ts` still pushes its `ping` tool and keeps working, and its `listTools` now also exercises the real schemas.

#### 3. NEW `/Users/oleast/git/test/godpirs-mcp/src/tools/shared.ts`
- `export const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true, destructiveHint: false } as const;`
- Input fragments, reused across tools:
  - `productIdInput = z.coerce.string().regex(/^\d{1,12}$/).describe('godpris.no product id, e.g. "794250" (from search results).')`
  - `categoryIdInput = z.coerce.string().regex(/^\d{1,9}$/).describe(...)`
  - `pageInput = z.coerce.number().int().min(1).max(100).default(1)`
  - `brandsInput = z.array(z.string().min(1)).max(20).optional()`
  - `priceMinInput` / `priceMaxInput` = `z.coerce.number().int().min(0).max(10_000_000).optional()`
  - `recordLowInput = z.boolean().optional()`. Do not coerce booleans: `"false"` would become true.
- `SEARCH_SORTS = ['relevance','popularity','discount_desc','price_asc','price_desc']` and `CATEGORY_SORTS = ['popularity','discount_desc','price_asc','price_desc','rating_avg_desc']`. Both are verified from the `[data-select-menu]` options in `search_vask.html` and `kat_1220.html`.
- `warningsField = { warnings: z.array(z.string()).optional() }`.
- `compactRowSchema = z.object({ id, title, brand?, price?, shop_count?, discount_pct?, rating?: z.object({value,max,source}), record_low?: boolean, url })`. Use plain `z.number()` in outputs. `toCompactRow(item: ListingItem)` maps from `src/parsers/tiles.ts` and drops `image`, `properties` and `offer_shop`, per the "compact" decision.
- `listingTable(rows)` builds on `markdownTable` from `src/format.ts`:
  - Headers: `| ID | Product | Price | Shops | Discount | Rating | Record low |`.
  - The Product cell is `[Brand Title](url)`, Price is `formatKr`, Discount is `7 %`, Rating is `5/6 (Lyd & bilde)` and Record low is `yes` or empty.
- `pagingSchema` fields, spread into listing outputs: `page`, `has_next`, `total?`, `next_page?`.
- `pagingFooter(meta)`: "Page 2 · 1 581 products · more: call again with page=3". When `total >= 10000`, append "(site caps counts at 10 000+)".
- URL and query builders:
  - `productUrl(id)`, `categoryUrl(id, query?)` and `siteUrl(path, query)` use `BASE_URL` from `src/parsers/util.ts`, and `URLSearchParams.append` for arrays.
  - `buildListingQuery(input, warnings): Query`. Its deterministic order is `s`, `b` (repeated), `p_min`, `p_max`, `d_min`, `rekordbillig=lowest_price`, then filters in the given order, then `page` (omitted when 1).
  - Filter mapping (`input.filters[]`):
    - Normalize `key`: trim and lowercase. A trailing `_min`/`_max` is stripped, except that `d_min` (or `d`) is treated as discount, giving `d_min = min ?? Number(values[0])`.
    - `rekordbillig` maps to `rekordbillig=lowest_price`.
    - If `min` or `max` is present, emit `{key}_min` / `{key}_max`.
    - If `values` is non-empty, emit a **repeated key** `{key}=v`. This is verified in the filters JS chunk: `params.append(key, value)` for multi-select, and `setRange` writes `${key}_min/_max`. Bool filters use `values:["1"]` (Ja) or `["0"]` (Nei). Brands are key `b`, price is key `p`.
    - A filter with none of min, max or values throws `InputError("filter <key> needs min, max or values")`.
    - When a dedicated param (`price_min`, `brands` and so on) conflicts with a filter on the same key, the dedicated param wins and a warning is added.
- Errors:
  - `class InputError extends Error`.
  - `class CoreDataMissingError extends Error { constructor(what: string, detail?: string) }`.
  - `export function handle<A>(toolName, fn: (args: A) => Promise<CallToolResult>, notFound?: (args: A) => string)` wraps fn in try/catch:
    - `NotFoundError` → `toolError(notFound?.(args) ?? 'Not found on godpris.no')`
    - `CoreDataMissingError` → `toolError("godpris.no returned no <what>; the site layout may have changed. <detail>")`
    - `UpstreamError` → `toolError("godpris.no request failed (HTTP <status>); try again shortly.")`
    - `InputError` / `BlockedPathError` → `toolError(message)`
    - anything else → `toolError("Unexpected error in <tool>: <message>")`
- `finish(text, schema, value, warnings)` returns `toolResult(text, schema.parse({...value}), capWarnings(warnings))`. `capWarnings` de-duplicates and keeps the first 10 plus "…and N more".
- `getDisk(ctx)`: `ctx.disk ??` a memoized `createDiskCache(ctx.config.dataDir)`, using a `Map` keyed by dataDir. `nowOf(ctx)`: `ctx.now?.() ?? new Date()`.

#### 4. NEW `/Users/oleast/git/test/godpirs-mcp/src/match/normalize.ts`
Step 7 will reuse and extend this.
- `normalizeText(s)`: lowercase; æ→ae, ø→o, å→a; NFKD with diacritics stripped; non-alphanumerics → space; whitespace collapsed and trimmed.
- `tokens(s): string[]`
- `matchScore(query, label): number` in 0..1:
  - 1 when the normalized strings are equal;
  - 0.9 when either string starts with the other;
  - otherwise the share of query tokens that prefix-match some label token (and the reverse), taking the higher of the two.

#### 5. NEW `/Users/oleast/git/test/godpirs-mcp/src/store/category-index.ts`
This is the disk-backed index of categories the server has seen, used by `find_category`.
- `interface IndexedCategory { id: string; name: string; parent_id?: string; path?: string[] /* names root→self */; seen: number }`
- `class CategoryIndex { constructor(disk: DiskCache, now = Date.now); record(entries: Array<Omit<IndexedCategory,'seen'>>): Promise<void>; search(query: string, limit: number): Promise<Array<IndexedCategory & { score: number }>>; }`
  - Everything is stored under one key, `category-index:v1`, holding a `Record<id, IndexedCategory>`. Reads use `disk.get(key, 365*24*3600*1000)`.
  - `record` serializes read-modify-write through a promise-chain mutex, and only overwrites fields with non-empty values.
  - `search` scores with `matchScore(query, name)`, keeps scores of 0.6 and above, sorts descending, then takes `limit`.
- `getCategoryIndex(ctx)` is memoized per dataDir.
- Callers wrap `record` in try/catch and ignore failures, because the index is best effort.
- Helper `recordCategoryPage(ctx, page: CategoryPage)`: each breadcrumb gets `parent_id` = the previous crumb's id and `path` = the names up to itself. Each subcategory gets `parent_id = page.id` and `path = [...pagePath, name]`.

#### 6. NEW `/Users/oleast/git/test/godpirs-mcp/src/parsers/autocomplete.ts`
- `parseAutocomplete(json: unknown): { query?: string; total: number; products: AutocompleteProduct[]; categories: AutocompleteCategory[]; warnings: string[] }`
- If `json` is not an object or `results` is not an array, throw `CoreDataMissingError`. Alternatively the tool can throw it; the parser returns a `warnings` entry and an `ok:false` flag. Choose one and keep it consistent; the simplest is that the parser throws.
- Product mapping, from `ac_*.json`:
  - `id` (string), `title`, `brand`, `price` → integer, `price_count` → `shop_count`, `discount` (number|null) → `discount_pct`.
  - `rating` is built from `featured_rating_value/max/critic_site_title` only when the value is non-null.
  - `url = productUrl(id)`.
  - `category_id` = the last element of `category_ids`, which is the most specific (best effort).
  - `variant_count = group_item_count` when it is above 0.
- Category mapping: `{id: String(id), name: label, product_count?: count, total?: total, match?: match, brand?: brand, url}`. The url is `categoryUrl(id)`, plus `?b=<brand>` when `match === 'brand'`.
- An empty response, `{"results":[],"categories":[],"query":null,"totalResults":0}`, is a valid empty result.

#### 7. NEW `/Users/oleast/git/test/godpirs-mcp/src/parsers/product.ts`
These selectors were verified against `prod_794250.html` (Product), `prod_4758589.html` (ProductGroup with 8 HTML rows and 7 JSON-LD offers) and `prod_20855452.html` (ProductGroup with BackOrder rows and 9 tests).

```ts
export interface ProductOffer { shop: string; price: number; availability?: string; in_stock?: boolean; business_only: boolean; item_title?: string; merchant_url?: string; shop_item_id?: string }
export interface ProductVariantOption { dimension: string; label: string; id: string; selected: boolean }
export interface ProductSpec { group: string; name: string; value: string }
export interface ProductTest { outlet: string; title?: string; quote?: string; rating_value?: number; rating_max?: number; url?: string }
export interface ProductAlternative { id: string; title: string; brand?: string; price?: number; discount_pct?: number; record_low: boolean; url: string }
export interface ProductPage { id?: string; title: string; brand?: string; url?: string; category_id?: string; group_id?: string; gtin?: string; mpn?: string; image?: string;
  breadcrumbs: CategoryRef[]; price_low?: number; price_high?: number; offer_count?: number; discount_pct?: number; record_low: boolean; highlights: string[];
  offers: ProductOffer[]; variants: ProductVariantOption[]; specs: ProductSpec[]; tests: ProductTest[]; alternatives: ProductAlternative[];
  lowest_price?: number; lowest_shop?: string; warnings: string[] }
export function parseProductPage(html: string): ProductPage
export function merchantUrlFromClickUrl(href: string | undefined): string | undefined   // decodes ONLY the u= param via new URL(href).searchParams.get('u'); never fetched
export function parseCollectAtStoreCounts(json: unknown): Array<{ shop_id: string; stores: number }> // {counts:[{shop_id,total}]}; total may be string → Number
```

Hooks:
- **id / category / group:** `[data-product-id]` attribute (on `<main>`), falling back to `link[rel=canonical]` with `productIdFromHref`; `[data-category-id]`; `[data-group-id]`. The last exists only on group pages: 3516 and 6700.
- **JSON-LD** (`extractJsonLd` + `findByType`):
  - Use `findByType(blocks,'Product')[0]`.
  - Otherwise take the `ProductGroup.hasVariant` entry that has `offers`. Prefer the one whose `offers.url` ends in `/produkt/{id}`.
  - Other `hasVariant` entries are only `{url, color}`; they are the fallback variant source.
  - Fields: `name` → title; `brand.name`; `gtin`; `mpn`; `image[0]`; `offers.lowPrice/highPrice/offerCount`.
  - Each `offers.offers[]` entry has `url` = `/api/services/click?u=<encoded merchant>&si=<id>&i=<pid>`, plus `availability` (`InStock` | `BackOrder`) and `seller.name`.
- **Title fallback:** clone `h1.title`, remove `.brand`, then clean. Brand fallback: `h1.title .brand`.
- **Breadcrumbs:** `parseBreadcrumbs(blocks)`, keeping crumbs with an id. For 794250 the result is 449 › 619 › 679.
- **Discount / record low:** `.badge-area .app-offer-badge .sr-only` gives "Markering av prisnedgang: 19% rabatt" → match `/(\d+)\s*%/`. `record_low` = `/rekordbillig/i` on `.badge-area` text.
- **Highlights:** `.featured-props-list li .prop`, cleaned, e.g. `["Poseløs","Støvbeholder: 0.7L",…]`.
- **Offers:** iterate over `[data-price-panel="prices"] [data-price-row]`, falling back to `[data-price-row]`.
  - `shop = attr data-shop`, `price = parseNok(attr data-price)`.
  - Click href = first `a[data-click-url]` href. `shop_item_id = new URL(href).searchParams.get('si')`. **The HTML href has no `u=`**, so join to the JSON-LD offer by `si`.
  - `merchant_url = merchantUrlFromClickUrl(ldOffer.url)`.
  - `item_title` = `.item-title` attribute `title`.
  - `availability` = clean text of `.price-extra--default .availability`, e.g. "På lager", "Forventet 14. des" or "Forventet". Each row renders it twice, so take only the first.
  - `in_stock`: JSON-LD `InStock` → true; `BackOrder`, `OutOfStock` or `PreOrder` → false; otherwise `/på lager/i`.
  - `business_only` = `/kun til bedrift/i` on `.price-extra--default` text. This is Dustin, which has no JSON-LD offer and therefore no `merchant_url`.
  - If there are no HTML rows but JSON-LD offers exist, build the offers from JSON-LD and add a warning.
- **Variants:**
  - Take `$('#varianter').nextAll('.app-property-box').first().find('.key-value-wrapper')`.
  - `dimension = dt.key` text. Each `.values a[href*="/produkt/"]` gives `label` = text, `id` = `productIdFromHref`, and `selected = id === pageId`.
  - Fallback: the JSON-LD `hasVariant` entries with `url`, where `dimension` = the non-`@type`/`url` key (e.g. `color`).
  - 794250 has no `#varianter`.
- **Specs:**
  - Take `$('#egenskaper').nextAll('.app-property-box').first().find('.prop-group')`. Use `nextAll`, because the variants box also has class `.app-property-box`.
  - `group` = `.prop-group-name` text. Each `.key-value-wrapper` gives `name = dt.key`.
  - `value`: if `.values svg.bool` exists, use its `aria-label` ("Ja"/"Nei"); otherwise clean the `.values` text, e.g. "0.7 L" or "128 GB".
- **Tests:**
  - Iterate over `.test-section a.review-card`. This excludes the header `.review-card--featured` duplicate.
  - `outlet = .review-card__site`, `title = .review-card__title`, `quote = .review-card__quote` with «» stripped, `url = href`.
  - Rating comes from `.review-card__badge img[alt]` ("Karakter 8.5 av 10 hos Tek.no") or `.review-card__badge .sr-only` ("Pulssonen: 90 av 100"), with regex `/([\d.,]+)\s*av\s*([\d.,]+)/` and comma → dot.
- **Alternatives:**
  - Iterate over `[data-similar-products] li.item-wrapper`. There are 12 per page; include the 7 `data-similar-extra` items too.
  - `a.title-wrapper` href → id; `.brand`; `span.title`; price from `.price a span` ("kr 3 399") via `parseNok`.
  - `.app-offer-badge` with text Rekordbillig → `record_low`. The `.sr-only` "37% rabatt" → `discount_pct`.
- **History config:** `[data-history-graph]` holds JSON (`lowestPrice`, `lowestShop`, `sectionUrl`, `allUrl`) → `lowest_price` / `lowest_shop`.
- **Not available:** there is no shop id on the page (no `data-shop-id`, and the click URL's `si` is a shop-item id). The site JS only sums `counts[].total`, so `shop_id` → name cannot be derived from the page.

#### 8. NEW `/Users/oleast/git/test/godpirs-mcp/src/parsers/history.ts`
These shapes were verified in `hist_all.json` (794250, 1035 contiguous daily points from 2024-01-12 to 2026-11-11), `hist_other.json` (428 points), `hist_section.html` (with zones) and `hist_section_other.html` (product 20855452, empty templates, `price_percentiles:null`).
- Prices are **strings** ("2799.00"), but the section's last point can be a **number** (`28990`). The third element is a shop **name**.
- `history_meta` fields: `price_min`, `price_max`, `created_min`, `created_max`, `price_min_last_90_days` (nullable), `feature_nice_time_to_buy`, `price_percentiles` (`{start:[a,b], end:[c,d]}` | null).

```ts
export interface PricePoint { date: string; price: number; shop: string }
export interface HistoryMeta { price_min?: number; price_max?: number; first_date?: string; last_date?: string; low_90d?: number; nice_time_to_buy?: boolean }
export interface HistoryData { points: PricePoint[]; meta: HistoryMeta; warnings: string[] }
export function parseHistoryJson(json: unknown): HistoryData            // accepts {history, history_meta} and the section's {history, meta}; Number(String(p)) + Math.round; bad rows → one aggregated warning; throws CoreDataMissingError if `history` not an array
export interface PriceZone { label: string; min: number; max: number }
export interface HistorySection { zones: PriceZone[]; today_price?: number; message?: string; summary: string[]; data?: HistoryData; warnings: string[] }
export function parseHistorySection(html: string): HistorySection
export type Verdict = 'good' | 'ok' | 'maybe' | 'expensive' | 'unknown'
export interface HistoryStats { today?: PricePoint; data_points: number; first_date?: string; low_90d?: number; high_90d?: number; low_all_time?: number; low_all_time_date?: string; high_all_time?: number; days_since_all_time_low?: number; percentile_90d?: number; percentile_all?: number; anchor_date: string }
export function osloDate(now: Date): string                     // Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Oslo'}) → YYYY-MM-DD
export function computeHistoryStats(points: PricePoint[], now: Date): HistoryStats
export function zoneVerdict(zones: PriceZone[], price: number): { verdict: Verdict; label?: string }
export function computedVerdict(points: PricePoint[], stats: HistoryStats): { verdict: Verdict; zones: PriceZone[]; reason?: string }
export function filterRange(points: PricePoint[], range: '30d'|'90d'|'all', anchor: string): PricePoint[]
export function downsample(points: PricePoint[], n: number): PricePoint[]
```

Section hooks:
- `[data-ntb-zone]` attributes such as "God pris: 2 799 – 2 990" → regex `/^(.+?):\s*([\d\s  ]+)\s*[–-]\s*([\d\s  ]+)$/` with `parseNok`. The dash is an EN DASH, U+2013.
- Fallback: the `.sr-only` text starting "Prisindikator:", with a global regex over the same pattern after "Dagens pris".
- `today_price`: `[data-ntb-bar]` attribute `data-tooltip-current` ("Dagens pris: 2 799").
- `message`: `.app-ntb-box .w-full > span.text-base` ("Nå er det god pris 🥳"), kept verbatim.
- `summary`: each `<p>` in `template[data-history-slot="summary"]`, cleaned, e.g. "Best pris i dag er kr 2 799".
- `data`: `parseHistoryJson(JSON.parse($('[data-history-data]').text()))`.

Rules:
- **Anchor.** `anchor = osloDate(now)`. If the window has no point at or after `anchor − 30d`, fall back to anchor = the last point's date and warn "history is stale; last point <date>".
- **Windows.** Window N contains the points with `daysBetween(date, anchor) < N`, which gives 90 points for 90d. Use UTC date math on `YYYY-MM-DD`.
- **today.** `today` = the last point.
- **Percentiles.** `percentile_X` = `round1(100 × count(price < today.price) / len)` over the window. 90d uses the 90d window and "all" uses all points.
- **Days since low.** `days_since_all_time_low` = anchor minus the latest date whose price equals `low_all_time`.
- **Zone verdict.** Labels map as: /god pris/i → good, /^ok/i → ok, /kanskje/i → maybe, /dyr/i → expensive. Pick the first zone with min ≤ price ≤ max (boundaries overlap, so first match wins). A price below the first zone counts as that first zone; a price above the last zone counts as expensive.
- **Computed verdict** (this is the decision's `source:"computed"`):
  - If the 90d window has fewer than 30 points, or high equals low, the verdict is `unknown` with reason "not enough price variation".
  - Otherwise use percentile_90d: ≤ 33 → good, ≤ 66 → ok, else maybe.
  - Zones use English labels good / ok / maybe, built from the 33rd and 66th quantiles of the window: `[low,q33]`, `[q33,q66]`, `[q66,high]`.
- **downsample.** If `len ≤ n`, return all points. Otherwise split `points[0..len-2]` into `n-1` index buckets, pick the minimum-price point of each bucket (ties go to the latest), then append the final point. The result has exactly `n` points.

#### 9. NEW `/Users/oleast/git/test/godpirs-mcp/src/tools/search.ts` — `registerSearchTools: Registration`

**search_products**
- Title: "Search products".
- Description: "Quick product lookup on godpris.no by name (autocomplete). Use this first to turn a product name into product ids and to discover matching categories; returns up to 20 products with lowest price and shop count."
- Input:
  - `query`: `z.string().trim().min(1).max(200)`
  - `limit`: `z.coerce.number().int().min(1).max(20).default(10)`. 20 is verified (`l=20` returned 20 results).
- Request: `client.getJson('/api/product/search', { query: { q, t: '', l: limit } })`. The site sends `q` and `t=""` (from `blade.js`). `l` is the limit.
- Output: `{ query, total_results, products: CompactRow + { category_id?, variant_count? }[], categories: [{id,name,product_count?,total?,match?,brand?,url}], warnings? }`.
- Markdown:
  - "## Products for "iphone" (10 000 matches)", then the listing table.
  - "## Categories", with bullets: "- Mobiltelefon (id 525), 773 products: url". For brand matches, add "(brand Wilfa)".
  - The last line is a hint to use `get_product` or `browse_category`.
- Side effect: record the categories into the category index as `{id, name}`.

**search_listing**
- Title: "Search listing".
- Description: "Full search results for a free-text query with sorting, brand, price and record-low filters, 32 products per page. Use when search_products is too narrow or you need sorting or more results; for spec filters use browse_category."
- Input: `query`; `sort: z.enum(SEARCH_SORTS).optional()`; `brands`; `price_min`; `price_max`; `record_low_only`; `page`.
- Request:
  - Page 1: `getHtml('/sok', {query: {q, ...buildListingQuery}})`.
  - Page N > 1: the same query plus `o=(N-1)*32, l=32, fragment=1`. This is verified: `sok_fragment.html` = `/sok?q=iphone&o=32&l=32&fragment=1`, and the next `data-append-url` has `o=64`.
  - `/sok` has no `page` param, so never send `page`.
- Parse: `parseProductTiles` + `parseListingMeta`. On page N, override `page = N` and `has_next = !!meta.next_url`. On fragments, `total` is absent.
- Errors:
  - No items and `total > 0` → `CoreDataMissingError('listing rows')`.
  - No items and `total` 0 or undefined → an empty result with the text "No products match". When `total` is undefined, also add a warning.
- Output: `{ query, url, ...paging, items: CompactRow[], warnings? }`. Here `url` is the user-facing `/sok?...` without `fragment`, `o` or `l`.

#### 10. NEW `/Users/oleast/git/test/godpirs-mcp/src/tools/categories.ts` — `registerCategoryTools`

**list_categories**
- Description: "Browse the godpris.no category tree. Without parent_id it returns the 17 top-level categories; with parent_id it returns that category's subcategories and breadcrumb path."
- Input: `parent_id: categoryIdInput.optional()`.
- No parent:
  - Disk key `top-categories:v1` (24h). On a miss, `getHtml('/')` → `parseTopCategories`.
  - 0 categories → `CoreDataMissingError`.
  - Record the categories into the index.
- With a parent:
  - `getHtml('/kategori/{id}', {notFoundOn500: true})` → `parseCategoryPage`.
  - If `name` is empty and there are no breadcrumbs or subcategories → `CoreDataMissingError`.
  - Record the page into the index.
- Output: `{ parent?: {id,name,url}, breadcrumbs: [{id,name}], categories: [{id,name,url}], is_leaf: boolean, total_products?: number, warnings? }`.
- Markdown: the path line, then a bullet list "- Vaskemaskin (id 1220)". For a leaf, say "Leaf category: use get_category_filters / browse_category".
- notFound message: `Category <id> not found`.

**find_category**
- Description: "Find category ids by name, e.g. 'vaskemaskin' or 'kaffetrakter'. Use before get_category_filters or browse_category when you do not know the category id."
- Input: `name` (string, 1–100 characters); `limit` (int, 1–20, default 10).
- Steps:
  1. Run the autocomplete `getJson('/api/product/search', {query: {q: name, t: ''}})` and take `categories`; source = `autocomplete`, in site order.
  2. Then `CategoryIndex.search(name, limit)`; source = `visited`, with `path`.
  3. De-duplicate by id. Autocomplete entries come first and are enriched with `path` from the index when it is known.
- Output: `{ query, categories: [{id, name, path?: string, product_count?, brand?, source: z.enum(['autocomplete','visited']), url}], warnings? }`. `path` is joined with " > ".
- If nothing is found, return the text "No category found; try search_products or list_categories". This is not an error.

**get_category_filters**
- Description: "List the filters available in a category: keys, labels, ranges with units, and options with counts. Call this before browse_category to build its filters argument."
- Input: `category_id`.
- Disk key `filters:v1:{id}` (24h, `DEFAULT_DISK_TTL_MS`) caches `{category_id, category_name, filters, sort_options}`.
- On a miss: `getHtml('/kategori/{id}', {notFoundOn500: true})` → `parseFilters`, plus `parseCategoryPage` for the name. Record the page into the index.
- `filters.length === 0` → `CoreDataMissingError('filters')`.
- Output: `{ category_id, category_name, url, filters: [{key,label,type: z.enum(['range','enum','bool']),min?,max?,unit?,options?: [{value,label,count?}]}], sort_options: [{value,label}], warnings? }`.
- Markdown, one bullet per filter:
  - range: "- **Vaskekapasitet**: key `f226`, range 3–20 kg"
  - enum: "- **Energiklasse**: key `f189`, options: A (524), B (51), …". Show at most 60 options, then "+N more".
  - bool: values "1" = Ja (395), "0" = Nei (41).
  - Annotate key `p` with "(use price_min/price_max)", `b` with "(use brands)", and `rekordbillig` with "(use record_low_only)".
  - Close with a usage line, e.g. `filters: [{"key":"f226","min":9},{"key":"f189","values":["A"]}]`, and the sort options.

**browse_category**
- Description: "List products in a category with sorting, brand, price, discount, record-low and spec filters (keys from get_category_filters), 36 per page. Use to find products that meet concrete requirements."
- Input:
  - `category_id`; `sort: z.enum(CATEGORY_SORTS).optional()`; `brands`; `price_min`; `price_max`;
  - `discount_min: z.coerce.number().int().min(1).max(99).optional()`;
  - `filters: z.array(z.object({ key: z.string().trim().min(1).max(40).describe('Filter key from get_category_filters, e.g. "f226"'), min: z.coerce.number().optional(), max: z.coerce.number().optional(), values: z.array(z.string().min(1)).max(30).optional() })).max(20).optional()`;
  - `record_low_only`; `page`.
- Request: `getHtml('/kategori/{id}', {query: buildListingQuery(...), notFoundOn500: true})`. `page=N` is verified (`kat1220_p2.html`, which has `rel=next`).
- Parse: `parseProductTiles`, `parseListingMeta`, and `parseCategoryPage` for name and subcategories, recorded into the index.
- Validation warnings: parse `parseFilters` on the **same** HTML. For each requested key that is not among the page's filter keys (special keys `p`, `b`, `d_min`, `rekordbillig` count as known), warn "Unknown filter key <k> for category <id>; call get_category_filters". For enum values not among the options, warn the same way.
- Empty or error rules are the same as for `search_listing`.
- Output: `{ category_id, category_name?, url, ...paging, subcategories?: [{id,name}], items: CompactRow[], warnings? }`.
- Markdown: header, the URL with applied params, the table and the footer.

#### 11. NEW `/Users/oleast/git/test/godpirs-mcp/src/tools/product.ts` — `registerProductTools`

**get_product**
- Description: "Full details for one product: every shop offer with price, availability and shop link, specs, expert tests, variants and popular alternatives. Use after you have a product id."
- Input:
  - `product_id`
  - `include: z.array(z.enum(['offers','specs','tests','variants','alternatives','collect_at_store'])).default([...all six])`. The default includes all six, per the plan; `collect_at_store` costs one extra request.
- Requests:
  - `getHtml('/produkt/{id}', {notFoundOn500: true})`.
  - If `collect_at_store` is included: `getJson('/api/product/collectAtStoreCount', {query: {id, market_id: 1}})`. If this fails, add a warning instead of an error.
- Core-data rules: no title → `CoreDataMissingError('product title')`. No offers in either the HTML or JSON-LD → `CoreDataMissingError('prices')`, per the decision.
- Record the breadcrumbs into the index.
- Output: `{ id, title, brand?, url, category_id?, group_id?, gtin?, mpn?, image?, breadcrumbs, price_low?, price_high?, shop_count?, discount_pct?, record_low, highlights, offers?, variants?, specs?, tests?, alternatives?, collect_at_store?: { total_stores, shops: [{shop_id, stores, shop_url}] }, warnings? }`. Only included sections are present. `shop_url` is `/butikk/{shop_id}`, best effort; the name is not derivable.
- Markdown:
  - `# Brand Title`, then "id · url", the category path, GTIN/MPN, "kr low – kr high across N shops", and the discount.
  - `## Offers (n)`: a table with columns Shop, Price, Availability, Note ("Kun til bedrift"), Link. Link is `[butikk](merchant_url)`, or the product url when there is no merchant URL.
  - `## Variants`: one line per dimension, with the selected option in **bold** and the ids in parentheses.
  - `## Tests (n)`: "- Tek.no 8.5/10: *title*: «quote» (url)".
  - `## Egenskaper og detaljer`: one line per group, "**Energi**: Batteriteknologi: Lithium-Ion (Li-Ion); Batteritid: 60 min".
  - `## Popular alternatives`: the listing table.
  - `## Click & collect`.
- notFound message: `Product <id> not found`.

#### 12. NEW `/Users/oleast/git/test/godpirs-mcp/src/tools/history.ts` — `registerHistoryTools`

**get_price_history**
- Description: "Price history for one product: today's price, 90-day and all-time lows, percentile, and godpris.no's 'Er det riktig tidspunkt å kjøpe?' verdict (God pris / OK / Kanskje). Use to judge whether now is a good time to buy."
- Input: `product_id`; `range: z.enum(['30d','90d','all']).default('90d')`; `points: z.coerce.number().int().min(5).max(365).default(60)`.
- Request 1: `getJson('/api/product/history', {query: {id: 'i_'+id, market_id: 1, all: 1}, notFoundOn500: true})`. An unknown id gives HTTP 500, which becomes `NotFoundError`.
- Empty history: return verdict `unknown` with the text "No price history yet". This is not an error.
- Request 2: `getHtml('/api/product/history-section', {query: {id: 'i_'+id, price: today.price, shop: today.shop}, notFoundOn500: true})`. This mirrors `sectionUrl` from the product page's `data-history-graph`; `price` and `shop` come from the last history point.
  - On any error: add the warning "site verdict unavailable" and use the computed verdict.
  - If `zones.length > 0`: `{source:'site', ...zoneVerdict(zones, section.today_price ?? today.price), zones, message}`.
  - Otherwise: `{source:'computed', ...computedVerdict}`.
- Stats use `computeHistoryStats(points, nowOf(ctx))`. They are always computed over the full history; `range` only affects `series`.
- Output: `{ product_id, url, range, currency: 'NOK', today?: {date, price, shop}, low_90d?, high_90d?, low_all_time?, low_all_time_date?, high_all_time?, days_since_all_time_low?, percentile_90d?, percentile_all?, data_points, first_date?, site_nice_time_to_buy?, verdict: { verdict: z.enum([...5]), label?, message?, reason?, source: z.enum(['site','computed']), zones: [{label,min,max}] }, site_summary?: string[], series: [{date, price, shop}], warnings? }`.
- Markdown:
  - "# Price history for product 794250", then the url.
  - "Today (2026-11-11): kr 2 799 at Skousen".
  - The lows and highs line.
  - "Cheaper than today on 0 % of the last 90 days".
  - "## Verdict: good (God pris, source: site)" with the message and zones.
  - The site summary lines.
  - "## Series (90d, 60 points, lowest price per interval)", followed by a table with columns Date, Price, Shop.

---

### Patterns to follow
- Existing parsers return `{…, warnings: string[]}`, use cheerio, and use the `clean`/`parseNok`/`parseCount`/`productIdFromHref` helpers. See `/Users/oleast/git/test/godpirs-mcp/src/parsers/tiles.ts:42-108` and `/Users/oleast/git/test/godpirs-mcp/src/parsers/category.ts:20-70`.
- JSON-LD helpers: `/Users/oleast/git/test/godpirs-mcp/src/parsers/jsonld.ts` (`extractJsonLd`, `findByType`, `parseBreadcrumbs`).
- Result helpers: `/Users/oleast/git/test/godpirs-mcp/src/tools/result.ts` (`toolResult(text, structured, warnings)`, `toolError`). Markdown helpers: `/Users/oleast/git/test/godpirs-mcp/src/format.ts` (`formatKr`, `markdownTable`, `truncate`).
- The client query handles arrays as repeated keys and skips undefined values; `notFoundOn500` maps 500 to `NotFoundError`. See `/Users/oleast/git/test/godpirs-mcp/src/http/client.ts:150-160`. `DiskCache` is at `/Users/oleast/git/test/godpirs-mcp/src/http/cache.ts:73-108`.
- Parser test style and the `fixture()` helper: `/Users/oleast/git/test/godpirs-mcp/test/parsers/category.test.ts` and `/Users/oleast/git/test/godpirs-mcp/test/parsers/helpers.ts`.

### Tests
**Shared helper.** NEW `/Users/oleast/git/test/godpirs-mcp/test/tools/harness.ts`:
- `connectTools(routes: Array<{ path: string | RegExp; file?: string; json?: unknown; status?: number }>, opts?: { now?: Date })` returns `{ client, calls: URL[], unexpected: URL[], close }`.
- It builds a fake `fetch`. Requests are matched on `URL.pathname`, exactly or by regex; `/api/product/history` and `/api/product/history-section` must be distinct.
  - A matching route serves `fixture(file)` or `JSON.stringify(json)` with the given status.
  - An unmatched route records the URL in `unexpected` and returns `new Response('unexpected', {status: 418})`. 418 is not retried, so the test stays fast.
- The context is `{ config: createConfig({ GODPRIS_DATA_DIR: mkdtempSync(join(tmpdir(), 'godpris-')) }), client: new GodprisClient({ baseUrl: 'https://godpris.no', rps: 1000, fetch, cache: new TtlCache() }), now: () => opts.now ?? new Date('2026-11-11T12:00:00Z') }`.
- It calls `createServer(ctx)`, connects through `InMemoryTransport.createLinkedPair()` and a `Client`, then **awaits `client.listTools()`** so AJV output validation is active on every `callTool`.

**Parser tests:**
- `test/parsers/autocomplete.test.ts`
  - `ac_iphone.json`: 6 products; the first is `13229670`, `price 10990`, `shop_count 9`, rating `{5, 6, 'Lyd & bilde'}`, `category_id '525'`. Categories are 525 and 531.
  - `ac_wilfa.json`: categories have `match 'brand'`, and the url contains `?b=Wilfa`.
  - The empty object gives total 0 and no products.
  - A non-object input throws.
- `test/parsers/product.test.ts`
  - 794250:
    - title "Innovac Aqua Plus HS1-SWB", brand Wilfa, `category_id '679'`, breadcrumbs ending 679, `discount_pct 19`;
    - 4 offers; the first is Skousen 2799, `in_stock` true, and `merchant_url` starts with `https://www.skousen.no/p/WILFA-602789`;
    - the specs contain `{group:'Egenskaper',name:'Støvbeholder',value:'0.7 L'}` and `{name:'Poseløs',value:'Ja'}`, 12 entries in total;
    - one test: Tek.no 8.5/10;
    - 12 alternatives; the first is `{id:'18381735', brand:'Shark', price:3399, record_low:true, discount_pct:37}`;
    - `lowest_price 2799`, `lowest_shop 'Skousen'`;
    - no variants.
  - 4758589:
    - title "iPhone 16 128GB Black", `group_id '3516'`;
    - 8 offers; Dustin has `business_only` true and no `merchant_url`;
    - variants: Lagringsplass has 3 options and Produsentfarge 5; the selected ones are "128 GB" and "Svart";
    - 2 tests; Pulssonen is 90/100.
  - 20855452: Elkjøp has availability "Forventet 14. des" and `in_stock` false; 9 tests.
  - `merchantUrlFromClickUrl` decodes `u=`.
  - `parseCollectAtStoreCounts({counts:[{shop_id:25,total:"3"}]})` returns `[{shop_id:'25',stores:3}]`.
- `test/parsers/history.test.ts`
  - `parseHistoryJson(hist_all.json)`: 1035 points, last `{2026-11-11, 2799, Skousen}`, `meta.low_90d 2799`.
  - Stats for hist_all at now 2026-11-11: `low_all_time 2290`, `low_all_time_date '2024-05-12'`, `days_since_all_time_low 913`, `low_90d 2799`, `percentile_90d 0`.
  - Stats for hist_other: today 10990 at Elkjøp, `low_all_time 9490`, `days_since_all_time_low 87`, `percentile_90d` about 55, computed verdict `ok`.
  - `parseHistorySection(hist_section.html)`: zones `[{God pris,2799,2990},{OK,2990,3490},{Kanskje,3490,3519}]`, `today_price 2799`, `message 'Nå er det god pris 🥳'`, summary has 2 lines, data present. `zoneVerdict` returns good / "God pris".
  - `hist_section_other.html`: 0 zones, `data.points.length === 62`, and the last price is numeric 28990. Computed verdict on that data gives `unknown` (flat price).
  - `downsample`: length is exactly n, the last point is preserved, and the minimum is preserved.
  - `filterRange`: 90d gives 90 points for hist_all.
- `test/match/normalize.test.ts`: "Vaskemaskin" equals "vaskemaskin" (1), "Kjøkken" matches "kjokken", and prefix scoring works.
- `test/store/category-index.test.ts`: record, then search, using a temporary directory; concurrent records do not lose entries.

**Tool tests** (`test/tools/*.test.ts`):
- `schemas.test.ts` lists the tools. Assert:
  - the names are exactly the 8 above, each matching `/^[a-z][a-z0-9_]{0,39}$/`;
  - every description has 1–3 sentences;
  - `annotations.readOnlyHint === true`;
  - every `outputSchema` is present;
  - walking each `inputSchema`, there is no `anyOf`/`oneOf`/`allOf`/`$ref`;
  - no object schema sits deeper than array-of-objects directly under a top-level property;
  - property names match `/^[a-z][a-z0-9_]*$/`;
  - no integer has `|minimum|` or `|maximum|` of 1e15 or more.
- `search.test.ts`
  - `search_products {query:'iphone'}` → route `/api/product/search` → `ac_iphone.json`. Assert the requested URL has `q=iphone`, `t=` and `l=10`; `structuredContent.products[0].id === '13229670'`; and the text contains "13229670".
  - `search_listing` page 1 → `search_iphone.html` (total 10000).
  - `search_listing` page 2 → assert the params `o=32`, `l=32`, `fragment=1`, with no `page`; serve `sok_fragment.html`; expect 32 items and `has_next` true.
- `categories.test.ts`
  - `list_categories {}` → `home.html` gives 17 categories.
  - `list_categories {parent_id:'449'}` → `kat_449.html` gives 14 subcategories.
  - `get_category_filters {category_id:'1220'}` contains f226 Vaskekapasitet as a range with unit kg. Call it a second time: there are 0 new fetch calls (disk cache).
  - `browse_category` with `{category_id:'1220', sort:'price_asc', brands:['Bosch','AEG'], price_max:8000, record_low_only:true, filters:[{key:'f226',min:9},{key:'f189',values:['A','B']},{key:'f999',values:['x']}], page:2}` → `kat1220_p2.html`. Assert with `searchParams.getAll`: `b = [Bosch, AEG]`, `f189 = [A, B]`, `f226_min = 9`, `p_max = 8000`, `rekordbillig = lowest_price`, `s = price_asc`, `page = 2`. Expect 36 items and a warning mentioning f999.
  - A filter without min, max or values returns isError.
  - `find_category {name:'vask'}` → `ac_items.json` gives 2126 and 1220 with source autocomplete. After `list_categories {parent_id:'449'}`, `find_category {name:'kjøkken'}` returns 592 with source visited.
- `product.test.ts`
  - `get_product {product_id:'4758589'}` → `prod_4758589.html` plus collectAtStoreCount json `{counts:[{shop_id:25,total:"2"}]}`. Assert the offers count is 8, `collect_at_store.total_stores === 2`, and no call path starts with `/api/services/`.
  - `include:['offers']` makes exactly 1 request.
  - The `/produkt/1` route with status 404 gives isError "Product 1 not found".
  - `product_id: 794250` passed as a number is accepted (coerce).
- `history.test.ts`
  - 794250 → `hist_all.json` + `hist_section.html`. Assert the section request has `id=i_794250`, `price=2799`, `shop=Skousen`; `verdict.source === 'site'`, `verdict.verdict === 'good'`; and `series.length === 60`.
  - The section route returning `hist_section_other.html` gives `source 'computed'`.
  - The section route returning status 503 gives a computed verdict plus a warning. That path has retries, so pass a `maxAttempts`/`backoffBaseMs` override to keep it fast, or use status 418.
  - The history route returning status 500 gives isError "not found".
  - `range:'all', points:10` gives 10 points.

### Verification
- `cd /Users/oleast/git/test/godpirs-mcp && npm run typecheck && npm test`. All existing tests must stay green, including `test/transports/http.test.ts`, which now lists the real tools too.
- `npm run build`
- Optional manual check: `npm run inspect` (MCP Inspector over stdio). Run `search_products` "iphone 16", `get_product` 4758589 and `get_price_history` 4758589 against the live site. That is about 5 requests at 1 req/s.

### Edge cases & risks
- **`/sok` page > 1 fragment.** The fixture only shows plain `q` with `o`/`l`. It is unverified that `s`, `b`, `p_*` and `rekordbillig` carry through on the fragment. Step 9 smoke should cover a sorted page 2.
- **`/sok` total "10 000+".** It parses as 10000; the footer notes the cap.
- **Overlapping zone boundaries** (2 990 is in both God pris and OK): the first match wins.
- **Products with no offers.** These raise a hard error, per the decision, which may hit discontinued products. Revisit if smoke shows this is common.
- **Merchant URLs can be affiliate redirectors** (kelkoo, adt231). Return the decoded `u=` as is and never fetch it; the client's block-list also prevents `/api/services/*`.
- **Click & collect.** It only gives `shop_id` → count. Shop names are not on the page (`/api/product/collect-at-store-rows?id=` exists, unexplored), so output a `/butikk/{shop_id}` link instead.
- **Disk-cached filters can be up to 24h stale.** That is acceptable.
- **The category index** is a single JSON file of at most about 2.8k entries. Writes are best effort and serialized in-process.
- **History anchoring** uses the Oslo date, so tests must inject `ctx.now`.
- **Do not use `.nullable()` or unbounded `.int()`** in inputs; the schema test enforces this. Always `outputSchema.parse()` structured output, or the client's AJV rejects extra keys even though the server passes them.
- **`include` default.** It includes `collect_at_store`, so a default `get_product` costs 2 requests (about 1s more at 1 rps).

### Blockers
None.

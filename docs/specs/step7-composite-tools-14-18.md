## Step spec: Step 7. Composite tools 14–18 (evaluate_purchase, find_products_by_requirements, hunt_deals, scan_category, compare_best_options)

### Goal
Register five multi-request tools: `evaluate_purchase`, `find_products_by_requirements`, `hunt_deals`, `scan_category` and `compare_best_options`.
- They reuse the atomic tools' fetch and parse logic through **exported internal functions**, never through MCP tool calls.
- Each one caps its pages and reports `requests_used`.
- The step adds a pure requirement matcher (`src/match/requirements.ts`) and pure verdict and deal logic (`src/analysis/verdicts.ts`), both unit-tested against fixtures.

### Facts verified for this step (fixtures and code read 2026-11-11)
- **Request counter (`src/http/client.ts:115-125, 152-176`).** `ctx.client.withCounter()` returns a `ScopedClient` (`HttpClient` + `requests`) that shares the singleton's cache, rate limiter and concurrency.
  - A memory-cache hit returns before counting, so it is **not** counted. Every attempt, retries included, **is** counted.
  - Disk-cached data such as `loadFilters` (`filters:v1:{id}`, 24h) never reaches the client, so it is free too.
  - Watchlist already uses this pattern (`src/tools/watchlist.ts:208,298`: `const client = ctx.client.withCounter(); … requests_used: client.requests`).
  - In tests, the harness `calls` array records network fetches only. So for one tool call on a fresh harness, `requests_used === h.calls.length`.
- **Category listing `/kategori/{id}`.**
  - 36 per page, `?page=N`, `rel=next` present (`kat_1220.html` → `?page=2`, `kat1220_p2.html` → `?page=3`).
  - The sort options include `discount_desc` and `rating_avg_desc`.
  - The sidebar has **no `d_min` filter** (`kat_1220.html` has no `d_min`), so `d_min` on `/kategori` is unverified. Always re-filter discounts client-side.
- **Search `/sok`.** 32 per page; page N>1 uses `o=(N-1)*32&l=32&fragment=1` (already in `search_listing`). `d_min` is unverified on `/sok`, so don't send it.
- **Deals `/tilbud`.**
  - 48 per page, fragment paging `o=(N-1)*48&l=48&fragment=1` (`data-append-url` in `tilbud.html`).
  - Sidebar keys: `d_min` (verified), `p`, `c` (top-level ids only), `shop`, `rekordbillig=lowest_price`.
  - Sorts: relevance, popularity, offer_created_desc, discount_desc, price_asc, price_desc.
  - Tiles carry `offer_shop` and `discount_pct`. 34 of 48 tiles have a discount ≥ 20; the top discounts are 715911 (81 %, kr 159), 10182936 (56 %) and 10974679 (56 %). The fixture is NOT sorted by discount, and its minimum discount is 10.
- **`kat_1220.html` filters** (labels used in the matcher tests):
  - b Produsent (enum, 50 opts); p Pris (range kr); f237 Mating (enum); f226 Vaskekapasitet (range 3–20 kg); f232 Trommelvolum (range l); f231 Sentrifugeringshastighet (range rpm); f235 Børsteløs motor (bool 1/0); f233 Plassering;
  - f236 Innvendig belysning (bool); f189 Energiklasse (enum A,B,D,C,E,F); f223 Energibruk per 100 sykluser (range kWh); f224 Vannforbruk (range l); f225 Sentrifugeklasse (enum); f230 Lydnivåklasse (enum A–D);
  - f228 Lydnivå (sentrifugering) (range 53–80 dB); f472 Farge (enum Hvit, Svart, Grå, Rustfritt stål, Sølv, Blå); f155 Høyde (cm); f157 Bredde (cm); f175 Dybde (cm); f68 Vekt (kg).
- **Discounts in the other listing fixtures.**
  - `kat_1220.html`, discount ≥ 30: 4243778:50, 8622219:54, 10645415:37, 5097087:52, 10844153:45, 5099569:50 (6 tiles). Some tiles have no discount.
  - `search_vask.html`, discount ≥ 40: 4243778, 8622219, 5097087, 10844153 (4 tiles).
- **Overlaps and prices.** `kat1220_price_asc.html` and `kat1220_p2.html` share 2 ids. All 36 price_asc tiles are ≤ 8000 (the last is 4987). 13 new p2 tiles are ≤ 8000. `kat_1220.html` and `kat1220_p2.html` share 1 id.
- **Autocomplete categories.**
  - `ac_items.json` (q=vask): 2126 "Kombinert vask/tørk" (match products), 1220 "Vaskemaskin" (count 1292), 662 "Sengetøy".
  - `ac_iphone.json`: 525 Mobiltelefon, then 531.
  - `ac_wilfa.json`: all three have `match:'brand'`.
- **Compare.** `src/parsers/compare.ts` already exists (compare agent) and exports `parseComparePage(html): { products: {id,title,brand?,price?,url}[]; rows: {group?, name, values: string[]}[]; warnings }`.
  - `sammenlign.html` = ids 794250, 1588920, with 20 rows. The first row is `{group:'Egenskaper', name:'Støvbeholder', values:['0.7 L','']}`.
- **History stats** at now=2026-11-11:
  - `hist_all.json`: today 2799 Skousen, low_90d 2799, high_90d 3519, median_90d 2990, low_all_time 2290, percentile_90d 0.
  - `hist_other.json`: today 10990, low_90d 9490, high_90d 11499, median_90d 10957.5, low_all_time 9490, percentile_90d 54.4.
  - `hist_section.html` zones: God pris 2799–2990, OK 2990–3490, Kanskje 3490–3519.
- **`prod_794250.html` offers:** Skousen 2799, Jernia 3490, Netonnet 3519 and Whiteaway 4495, all in stock, with `discount_pct 19`.
- **SDK.**
  - The tool callback receives `(args, extra)`. `extra._meta?.progressToken` and `extra.sendNotification` exist (`RequestHandlerExtra`).
  - The client default request timeout is 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC`). At 1 req/s, a 30-request composite gets close to it.

---

### Changes

#### A. Internal helper extraction (refactor; behaviour of existing tools unchanged)

Every helper takes an explicit `http: HttpClient` (type from `src/http/client.ts`), so composites can pass their counting view. Atomic handlers pass `ctx.client`.

1. `/Users/oleast/git/test/godpirs-mcp/src/tools/shared.ts`
   - **Move** the inline `filters` zod array from `browse_category` (`src/tools/categories.ts`, the `filters:` entry of `inputSchema`) to `export const filtersInput = z.array(z.object({ key, min, max, values })).max(20).optional().describe(...)`. Keep the same inner schema and descriptions, and import it back into categories.ts.
   - Extend `handle` so it forwards the SDK `extra`. This is additive and does not break other callers:
     ```ts
     import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
     import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
     export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
     export function handle<A>(toolName, fn: (args: A, extra?: ToolExtra) => Promise<CallToolResult>, notFound?) : (args: A, extra?: ToolExtra) => Promise<CallToolResult>
     ```
     Pass `extra` through in the returned wrapper; nothing else changes.

2. `/Users/oleast/git/test/godpirs-mcp/src/tools/categories.ts`
   - `export async function loadFilters(ctx, id, warnings, http: HttpClient = ctx.client)`: the existing function with a 4th param, using `http.getHtml` instead of `ctx.client.getHtml`. Export `CachedFilters` and `SPECIAL_KEYS`.
   - `export function validateFilterInputs(defs: FilterDef[], filters: FilterInput[] | undefined, categoryId: string, warnings: string[]): void`. This moves the "Validate requested filter keys/values" loop out of browse_category verbatim.
   - NEW `export interface CategoryListing { category_id: string; category_name?: string; url: string; query: Query; items: ListingItem[]; meta: ListingMeta; page: CategoryPage; filter_defs: FilterDef[] }`
   - NEW `export async function fetchCategoryListing(ctx: ToolContext, http: HttpClient, args: ListingInput & { category_id: string; page: number }, warnings: string[], opts: { validate?: boolean } = {}): Promise<CategoryListing>` does:
     1. `query = buildListingQuery(args, warnings)`.
     2. `html = await http.getHtml('/kategori/{id}', { query, notFoundOn500: true })`.
     3. Parse with `parseProductTiles`, `parseListingMeta` and `parseCategoryPage`, then push the tile warnings and `await recordCategoryPage(ctx, page)`.
     4. Set `filter_defs = parseFilters(html).filters`. If `opts.validate !== false`, call `validateFilterInputs`.
     5. If there are no items and `meta.total > 0`, throw `CoreDataMissingError('listing rows')`.
     6. `url = categoryUrl(id, {...query})`.
   - Rewrite the `browse_category` handler to call `fetchCategoryListing(ctx, ctx.client, args, warnings)`, then build exactly the same output and text as today. The existing tests in `test/tools/categories.test.ts` must pass unchanged.

3. `/Users/oleast/git/test/godpirs-mcp/src/tools/search.ts`
   - Export `SEARCH_PAGE_SIZE`.
   - NEW `export async function fetchSearchListing(http: HttpClient, args: ListingInput & { query: string; page: number }, warnings: string[]): Promise<{ items: ListingItem[]; meta: ListingMeta; url: string }>`. Move the body of `search_listing` into it: the `buildListingQuery({...args, page: undefined})`, the user url, `o/l/fragment` for page > 1, the parse step, and the `CoreDataMissingError('listing rows')` rule.
   - `search_listing` then calls it with `ctx.client`, and its output is unchanged.

4. `/Users/oleast/git/test/godpirs-mcp/src/tools/product.ts`
   - NEW `export async function fetchProductPage(ctx: ToolContext, http: HttpClient, productId: string): Promise<ProductPage>` does:
     1. `http.getHtml('/produkt/{id}', {notFoundOn500:true})`, then `parseProductPage`.
     2. Throw `CoreDataMissingError('product title')` or `CoreDataMissingError('prices')` exactly as today.
     3. Record the breadcrumbs in the category index on a best-effort basis; move the current try/catch block here.
   - NEW `export interface CollectAtStore { total_stores: number; shops: Array<{ shop_id: string; stores: number; shop_url: string }> }` and `export async function fetchCollectAtStore(http: HttpClient, productId: string): Promise<CollectAtStore>`. It throws on failure, and the caller decides whether to warn.
   - NEW `export function cheapestOffer(offers: ProductOffer[], opts: { inStockOnly: boolean }): ProductOffer | undefined`:
     - Exclude `business_only` offers unless all offers are business-only.
     - With `inStockOnly`, keep only `in_stock === true`.
     - Return the minimum price; on a tie, the first offer wins.
     - (`watchlist.ts` has a private `currentPrice` with the same idea. Do **not** edit watchlist.ts in this step.)
   - The `get_product` handler uses these three; its output is unchanged.

5. `/Users/oleast/git/test/godpirs-mcp/src/tools/history.ts`
   - NEW exported types and function. They hold the logic that is currently inline in the handler (request 1, empty-history branch, stats, stale warning, section call, site/computed verdict):
     ```ts
     export interface VerdictInfo { verdict: Verdict; label?: string; message?: string; reason?: string; source: 'site' | 'computed'; zones: PriceZone[] }
     export interface HistoryAnalysis {
       product_id: string;
       points: PricePoint[];          // full history, may be []
       stats: HistoryStats;           // computeHistoryStats(points, nowOf(ctx)); data_points 0 when empty
       verdict: VerdictInfo;          // empty history → { verdict:'unknown', reason:'no price history', source:'computed', zones:[] }
       site_summary?: string[];
       site_nice_time_to_buy?: boolean;
       warnings: string[];            // parser warnings, 'history is stale; last point …', 'site verdict unavailable'
     }
     export async function fetchHistoryAnalysis(ctx: ToolContext, http: HttpClient, productId: string, opts: { section?: boolean } = {}): Promise<HistoryAnalysis>
     ```
     - It makes 1 request (`/api/product/history`, `notFoundOn500`), plus 1 section request when `opts.section !== false` and the history is non-empty.
     - `NotFoundError` from the history JSON propagates.
     - A section failure is caught and becomes `warnings.push('site verdict unavailable')` with the computed verdict, as today.
   - `get_price_history` then calls `fetchHistoryAnalysis(ctx, ctx.client, id)` and keeps its series, text and output code. `test/tools/history.test.ts` must stay green.
   - Also export `VERDICTS` and `verdictSchema` (the existing `verdict: z.object({...})` in `historyOutput`), so the composites reuse the same output shape.

6. `/Users/oleast/git/test/godpirs-mcp/src/tools/index.ts`
   - Append `registerCompositeTools` (from `./composite/index.js`) to `toolRegistrations`. Other agents append too (deals, compare, tests, gifts, stores, trending, watchlist, sitemap), so merge and keep all of them.

#### B. NEW `/Users/oleast/git/test/godpirs-mcp/src/match/normalize.ts` additions
Leave `matchScore` unchanged; `find_category` and the category index depend on it. Add the following:
```ts
/** Compound-word aware score in 0..1: max(matchScore, 0.95 when equal ignoring spaces, 0.8 × share of ≥4-char tokens contained in a token of the other side). */
export function fuzzyScore(query: string, label: string): number
```
- `q = normalizeText(query)`, `l = normalizeText(label)`. If either is empty, return 0.
- `joined = q.replace(/ /g,'') === l.replace(/ /g,'') ? (q === l ? 1 : 0.95) : 0`
- `share(from, to) = from.filter(t => t.length >= 4 && to.some(u => u.includes(t))).length / from.length` (0 when `from` is empty)
- `compound = 0.8 * Math.max(share(qt, lt), share(lt, qt))`
- Return `Math.max(matchScore(query, label), joined, compound)`.
- Expected values:
  - "kapasitet" vs "Vaskekapasitet" = 0.8
  - "energi klasse" vs "Energiklasse" = 0.95
  - "lydniva" vs "Lydnivå (sentrifugering)" = 0.9
  - "wifi" vs "Vaskekapasitet" = 0

#### C. NEW `/Users/oleast/git/test/godpirs-mcp/src/match/requirements.ts` (pure, no I/O)
```ts
import type { FilterDef } from '../parsers/filters.js';
import type { FilterInput } from '../tools/shared.js';   // type-only import
export interface Requirement { label: string; min?: number | undefined; max?: number | undefined; values?: string[] | undefined }
export type UnmatchedReason = 'no_matching_filter' | 'ambiguous' | 'unknown_key' | 'needs_value' | 'value_not_found' | 'invalid_range';
export interface AppliedFilter { requirement: string; key: string; filter_label: string; type: 'range'|'enum'|'bool'; min?: number; max?: number; unit?: string; values?: string[]; value_labels?: string[]; score: number; note?: string }
export interface UnmatchedRequirement { requirement: string; reason: UnmatchedReason; detail: string; suggestions: string[] }
export interface MatchResult { applied: AppliedFilter[]; filters: FilterInput[]; unmatched: UnmatchedRequirement[]; warnings: string[] }
export interface AvailableFilter { key: string; label: string; type: 'range'|'enum'|'bool'; unit?: string; min?: number; max?: number; options?: string[] }
export const ACCEPT_SCORE = 0.8, MARGIN = 0.05, SUGGEST_SCORE = 0.4, VALUE_ACCEPT = 0.8;
export function parseNumeric(text: string): { min?: number; max?: number; value?: number; unit?: string; bound?: 'min'|'max' } | undefined
export function matchRequirements(reqs: Requirement[], defs: FilterDef[]): MatchResult
export function availableFilters(defs: FilterDef[], maxOptions = 12): AvailableFilter[]
```

**Constants (normalized tokens, so æøå are already folded):**
- `LABEL_SYNONYMS: Record<string,string>`. This is the minimal set, applied **per token** after `normalizeText`:
  - `capacity→kapasitet, energy→energi, class→klasse, noise→lydniva, sound→lyd, stoy→lyd, stoyniva→lydniva, loudness→lydniva`
  - `color→farge, colour→farge, width→bredde, height→hoyde, depth→dybde, weight→vekt`
  - `brand→produsent, merke→produsent, manufacturer→produsent, price→pris, spin→sentrifugering, speed→hastighet, rpm→sentrifugeringshastighet`
  - `drum→trommel, volume→volum, water→vann, screen→skjerm, storage→lagringsplass, memory→minne, battery→batteri, size→storrelse, motor→motor`
- `VALUE_SYNONYMS`: `black→svart, sort→svart, white→hvit, grey→gra, gray→gra, silver→solv, red→rod, blue→bla, green→gronn, stainless→rustfritt stal, 'stainless steel'→rustfritt stal`. Apply this on the whole normalized value first, then per token.
- `TRUE_WORDS = ['1','ja','yes','true','y','med','with']` and `FALSE_WORDS = ['0','nei','no','false','n','uten','without']`.
- `UNIT_TOKENS = ['kg','g','l','liter','cm','mm','m','db','rpm','kwh','w','watt','gb','tb','mb','hz','tommer','inch','v','mah']`.
- `UNIT_FACTORS` covers mm/cm/m and g/kg: `{ mm:{cm:0.1,m:0.001}, cm:{mm:10,m:0.01}, m:{cm:100,mm:1000}, g:{kg:0.001}, kg:{g:1000} }`.
- Max markers: `/\b(max|maks|under|hoyst|inntil|opptil|below|at most)\b|<|≤/` and min markers: `/\b(min|minst|over|fra|above|at least)\b|>|≥|\+$/`. Test these on the raw lowercased text, before normalization strips `<`.

**`parseNumeric(text)`**
1. Lowercase the text and turn nbsp into a space.
2. Find all numbers with `/\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g`: strip the inner spaces and turn the comma into a dot.
3. The unit is the first `UNIT_TOKENS` token in the text after the last number (or `%`).
4. Results:
   - Two or more numbers (e.g. "8-10 kg", "8 til 10") give `{min: lowest, max: highest, unit}`.
   - One number gives `{value, unit, bound}`, where `bound` comes from the markers ('max' wins if both match).
   - No number gives `undefined`.
- Examples: "9 kg" → value 9, unit kg; "1 400 rpm" → 1400; "8,5" → 8.5; "maks 60 cm" → value 60, bound max; "under 600 mm" → value 600, unit mm, bound max.

**`matchRequirements(reqs, defs)`.** Process each requirement `r` (with `display = r.label.trim()`):

1. **Kind.**
   - `range` when `r.min`/`r.max` is given, or every value parses numeric.
   - `bool` when there are no min/max/values, or every value is in TRUE_WORDS/FALSE_WORDS.
   - Otherwise `enum`.
2. **Exact key.**
   - Let `k = r.label.trim().toLowerCase().replace(/_(min|max)$/,'')`. If `k` matches `/^(f\d+|b|p|d_min|rekordbillig|c|shop)$/`:
     - When `defs` has that key, use it with score 1 and skip step 3.
     - When it doesn't, record unmatched `unknown_key`, detail `Filter key <k> does not exist in this category`, suggestions [].
3. **Fuzzy label.**
   - Build `label' = normalizeText(r.label)`. Drop `UNIT_TOKENS` tokens, but only while other tokens remain; remember the first dropped unit as `unitHint`. Then map each token through `LABEL_SYNONYMS`.
   - For each def, `score = fuzzyScore(label', def.label)`:
     - +0.05 when the def type is compatible with the kind (range→range; enum→enum or bool; bool→bool);
     - +0.05 when `unitHint` equals `normalizeText(def.unit)`.
     - Do not cap the score here; cap the reported `score` at 1 and round it to 2 decimals.
   - Sort descending. Let `best`, `second` be the top two.
     - `best < ACCEPT_SCORE` → unmatched `no_matching_filter`, detail `No filter label matches "<label>"`.
     - `best ≥ ACCEPT_SCORE` and `best − second < MARGIN − 1e-9` → unmatched `ambiguous`, detail `"<label>" matches several filters equally well`.
     - In both cases, `suggestions` = up to 3 defs with score ≥ `SUGGEST_SCORE`, formatted `"<Label> (<key>)"`.
4. **Value mapping**, by `def.type`:
   - **range:**
     - If `r.min`/`r.max` are given, use them; when values were also given, add the note "values ignored; min/max used".
     - Otherwise parse every value with `parseNumeric`:
       - two or more numbers in total: `min` = lowest, `max` = highest;
       - one number with `bound` 'max': `max = value`;
       - one number otherwise: `min = value`, note `interpreted "<v>" as minimum; pass min/max for exact control`.
     - **Unit conversion.** If the parsed unit and `def.unit` differ and `UNIT_FACTORS[parsed][defUnit]` exists, multiply and add the note `converted 600 mm to 60 cm`. If they differ and there is no factor, keep the number and add the note `unit <u> ignored (filter unit <defUnit>)`.
     - No numbers at all gives `needs_value`, detail `<Label> is a range filter; pass min/max, e.g. {"label":"<label>","min":9}`.
     - `min > max` gives `invalid_range`.
     - If `def.max` is defined and `min > def.max`, or `def.min` is defined and `max < def.min`, push the warning `No product in this category has <Label> in that range (<def.min>–<def.max> <unit>)`, but still apply the filter.
   - **bool:**
     - No values gives `values ['1']` with the note "no value given; requiring Ja".
     - Otherwise map each value: TRUE_WORDS → '1', FALSE_WORDS → '0', anything else → unmatched `value_not_found`.
     - When the bool def's options use other values (e.g. `rekordbillig` = `lowest_price`), map true to the first option value.
   - **enum:** for each value `v`, take the first rule that succeeds:
     - (a) case-insensitive equality with `option.value`;
     - (b) `normalizeText(VALUE_SYNONYMS(v)) === normalizeText(option.label)`;
     - (c) when the normalized `v` has ≤ 2 chars, stop: no fuzzy match (protects "A" against "A+++");
     - (d) numeric equality when both parse;
     - (e) best `fuzzyScore(v', option.label)` ≥ `VALUE_ACCEPT` with margin ≥ `MARGIN`; ties are broken by higher `count`.
     - Collect `values` (option.value) and `value_labels`.
     - Unmatched values become **one** unmatched entry `value_not_found`, detail `"lilla" is not an option of Farge`, with suggestions = the top 5 option labels by fuzzy score (any score > 0), otherwise the first 5 options.
     - If `r.min`/`r.max` are given with no values, select the options whose label parses numeric within [min,max]. If none parse, return `needs_value`, detail `<Label> is a list filter; pass values, e.g. ["<first option label>"]`.
     - If no value matched at all, the requirement is not applied: only the unmatched entry is recorded.
5. **Merge.** When two applied requirements resolve to the same key, merge them into one `FilterInput`: `min = max(mins)`, `max = min(maxes)`, and union the values. Push the warning `Requirements "<a>" and "<b>" both map to <Label> (<key>); merged`. Keep both `AppliedFilter` entries.
6. **Output.**
   - `filters` holds one `FilterInput` per key, in first-seen order: `{key, min?, max?, values?}`.
   - `applied` holds the per-requirement `AppliedFilter` entries; `unit = def.unit`.

**`availableFilters(defs, maxOptions)`** maps each def to `{key,label,type,unit?,min?,max?,options?: first maxOptions option labels}`. It drops `options` for range types, including the `d_min` buckets.

#### D. NEW `/Users/oleast/git/test/godpirs-mcp/src/analysis/verdicts.ts` (pure)
```ts
import { filterRange, type HistoryStats, type PricePoint, type Verdict } from '../parsers/history.js';
export type Recommendation = 'buy_now' | 'ok' | 'wait' | 'unknown';
export function purchaseRecommendation(input: { verdict: Verdict; source: 'site'|'computed'; label?: string; stats: HistoryStats; in_stock_offers: number; cheapest_in_stock?: number; cheapest_any?: number }): { recommendation: Recommendation; reasons: string[] }
export type DealAssessment = 'all_time_low' | 'genuine' | 'modest' | 'inflated' | 'unverified';
export interface DealCheck { assessment: DealAssessment; inflated_discount: boolean; implied_before_price?: number; real_discount_pct?: number; median_90d?: number; reasons: string[] }
export function assessDeal(input: { price?: number; discount_pct?: number; points: PricePoint[]; stats: HistoryStats; verdict: Verdict }): DealCheck
export function median(nums: number[]): number | undefined
export const DEAL = { MIN_POINTS_90D: 14, LOW_TOLERANCE: 0.01, MIN_REAL_PCT: 3, GENUINE_PERCENTILE: 10, INFLATED_REAL_MAX: 5, INFLATED_CLAIM_MIN: 10, BEFORE_TOLERANCE: 1.05 } as const;
export const ASSESSMENT_RANK: Record<DealAssessment, number> = { all_time_low: 0, genuine: 1, modest: 2, unverified: 3, inflated: 4 };
```

**purchaseRecommendation.** This follows the "Buy verdict" decision: the site zone is primary.
- Mapping: `good → buy_now`, `ok → ok`, `maybe → wait`, `expensive → wait`.
- `unknown`: when `stats.today && stats.low_90d !== undefined && stats.today.price <= stats.low_90d` → `buy_now` with the reason "at the 90-day low (no zone available)". Otherwise `unknown`.
- `reasons`, in order. Format money with `formatKr` and percentages with 1 decimal:
  1. `Site zone: <label>` or `Computed from 90-day percentiles: <verdict>`.
  2. `Today's lowest kr X is the 90-day low` or `… is N % above the 90-day low (kr Y)`.
  3. `All-time low kr Z on <date> (<days> days ago); today is N % above it`. When `today ≤ low_all_time`, use `Today matches the all-time low` instead.
  4. `Cheaper than today on P % of the last 90 days`.
  5. If `in_stock_offers === 0`: `No shop lists it in stock`.
  6. If `cheapest_in_stock > cheapest_any`: `Cheapest in-stock offer costs N % more than the cheapest offer`.
- Items whose data is missing are skipped.

**assessDeal**, the hunt_deals "genuine deal" logic:
- `w90 = filterRange(points,'90d',stats.anchor_date)`. If `w90.length < MIN_POINTS_90D` or `stats.low_90d === undefined`, return `unverified`, reason `not enough price history (<n> days in the last 90)`, `inflated_discount false`.
- `current = Math.min(price ?? ∞, stats.today?.price ?? ∞)`. The tile price is the deal shop's price; history today is the lowest across shops.
- `median_90d = median(w90 prices)`; `real = round1(100 × (1 − current / median_90d))`. This can be negative.
- `implied_before = discount_pct in [1,95] && price ? Math.round(price / (1 − d/100)) : undefined`.
- `inflated_discount` is true when either holds:
  - `implied_before > stats.high_90d × BEFORE_TOLERANCE` (the claimed "before" price was never charged in the last 90 days);
  - `d ≥ INFLATED_CLAIM_MIN && real < d / 2` (the claimed discount is more than double the real one).
- Classification; the first rule that applies wins:
  1. `real ≥ MIN_REAL_PCT && current ≤ stats.low_all_time` → `all_time_low`.
  2. `real ≥ MIN_REAL_PCT && (current ≤ low_90d × (1 + LOW_TOLERANCE) || (stats.percentile_90d ?? 100) ≤ GENUINE_PERCENTILE || verdict === 'good')` → `genuine`.
  3. `real ≤ INFLATED_REAL_MAX && (d ?? 0) ≥ INFLATED_CLAIM_MIN` → `inflated`.
  4. Otherwise `modest`.
- The `MIN_REAL_PCT` guard stops a flat-priced product from counting as an "all-time low".
- `reasons` are short strings, e.g.:
  - `claimed 19 % off, real 6.4 % below the 90-day median kr 2 990`
  - `claimed before-price kr 15 284 is above the 90-day high kr 3 519`
  - `at the 90-day low`

#### E. NEW `/Users/oleast/git/test/godpirs-mcp/src/tools/composite/` (5 tool files + common + index)

`common.ts`:
- `export const requestsUsedField = { requests_used: z.number() }`.
- `export const maxPagesInput = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def).describe(...)`.
- `export function capPages(requested: number, ctx: ToolContext, warnings: string[]): number`. It returns `min(requested, ctx.config.maxPages)` and, when capped, warns `max_pages capped at <n> (GODPRIS_MAX_PAGES)`.
- `export function progress(extra: ToolExtra | undefined, done: number, total: number, message: string): void`. When `extra?._meta?.progressToken !== undefined`, it runs `void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: done, total, message } }).catch(() => {})`. Call it after each network step. This helps clients that use `resetTimeoutOnProgress`.
- `export const historyBriefSchema = z.object({ today_price: z.number().optional(), today_date: z.string().optional(), low_90d: z.number().optional(), high_90d: z.number().optional(), low_all_time: z.number().optional(), percentile_90d: z.number().optional(), verdict: z.enum(VERDICTS), verdict_label: z.string().optional(), verdict_source: z.enum(['site','computed']) })`, plus `toHistoryBrief(a: HistoryAnalysis)`.
- `export interface ResolvedCategory { id: string; name: string; source: 'input'|'autocomplete'|'visited'; candidates: Array<{ id: string; name: string; product_count?: number }> }`
- `export async function resolveCategory(ctx, http, query: string, warnings: string[]): Promise<ResolvedCategory>`:
  1. `ac = parseAutocomplete(await http.getJson('/api/product/search', { query: { q: query, t: '' } }))`. Use exactly the query object of `find_category`, so the cache entry is shared. Then record `ac.categories` in the category index on a best-effort basis.
  2. `cands = ac.categories.filter(c => c.match !== 'brand')`. If that is empty, use all `ac.categories` and warn `category guessed from a brand match`.
  3. Pick the first candidate with the maximum `fuzzyScore(query, c.name)` when that is ≥ 0.75. Otherwise pick `cands[0]` (site order, e.g. iphone → 525) and warn `Picked category "<name>" (id <id>) for "<query>"; pass category_id to choose another (candidates: …)`.
  4. With no autocomplete categories, try `getCategoryIndex(ctx).search(query, 3)[0]` (source `visited`).
  5. With nothing found, throw `InputError('No category found for "<query>"; call find_category and pass category_id.')`.
  - `candidates` = up to 5 cands as `{id, name, product_count: c.product_count ?? c.total}`.
- `export function dedupeById<T extends { id: string }>(rows: T[]): T[]` keeps the first occurrence.
- `export function walkError(err: unknown, page: number, warnings: string[]): void`. Page 1 errors rethrow. For page > 1: `NotFoundError` warns `listing ended at page <n> (not found)`; `CoreDataMissingError`/`UpstreamError` warn `stopped at page <n>: <message>`. Any other error rethrows.

`index.ts`:
- `export const registerCompositeTools: Registration = (server, ctx) => { registerEvaluatePurchase(server, ctx); registerFindByRequirements(server, ctx); registerHuntDeals(server, ctx); registerScanCategory(server, ctx); registerCompareBestOptions(server, ctx); }`

Every composite handler starts with `const http = ctx.client.withCounter(); const warnings: string[] = [];`. It passes `http` to every helper, sets `requests_used: http.requests` in the structured output, and ends the markdown with `Requests used: N` (cached responses are free). All use `handle(...)`, `finish(text, schema, value, warnings)` and `annotations: READ_ONLY`. Every output schema includes `...warningsField` and `requests_used`. Use `.optional()`, never `.nullable()`, and give every integer input explicit min and max.

---

##### 14. `evaluate_purchase` (`composite/evaluate.ts`)
- **Description:** "Should I buy this now? Combines the product's offers, price history and godpris.no's price zone into a buy_now / ok / wait recommendation with the reasons, the cheapest in-stock offer and click-and-collect availability. Use after you have a product id."
- **Input:** `{ product_id: productIdInput }`.
- **Requests (≤ 4):**
  1. `fetchProductPage(ctx, http, id)`. `NotFoundError` propagates, giving `Product <id> not found`.
  2. `fetchCollectAtStore(http, id)` in try/catch; a failure warns `Click & collect data unavailable`.
  3. `fetchHistoryAnalysis(ctx, http, id)` in try/catch. `NotFoundError` or any error warns `price history unavailable` and the tool continues: there is no history block, the zone is `{verdict:'unknown', reason:'no price history', source:'computed', zones:[]}` and the recommendation is `unknown`. This is soft per the site-drift decision; the product's title and prices are the core data.
  4. The section request is part of step 3.
- **Derivations:**
  - `cheapest_any = cheapestOffer(p.offers,{inStockOnly:false})` and `cheapest_in_stock = cheapestOffer(p.offers,{inStockOnly:true})`.
  - `offers_in_stock = offers.filter(o => o.in_stock && !o.business_only).length`.
  - `history.vs_90d_low_pct = round1(100 × (today − low_90d) / low_90d)`, and the same for all-time.
  - Then `purchaseRecommendation(...)`.
- **Output** `evaluateOutput`:
  ```
  { product_id, title, brand?, url, category?: {id,name}, shop_count, price_low, price_high?, discount_pct?, record_low: boolean,
    cheapest_offer?: offerBrief, cheapest_in_stock?: offerBrief, offers_in_stock: number,
    history?: { today?: {date,price,shop}, low_90d?, high_90d?, low_all_time?, low_all_time_date?, days_since_all_time_low?, percentile_90d?, percentile_all?, vs_90d_low_pct?, vs_all_time_low_pct?, data_points, site_nice_time_to_buy? },
    zone: verdictSchema,
    collect_at_store?: { total_stores, shops: [{shop_id, stores, shop_url}] },
    recommendation: z.enum(['buy_now','ok','wait','unknown']), reasons: string[], requests_used, warnings? }
  offerBrief = { shop, price, availability?, in_stock?, merchant_url? }
  ```
  `category` is the last breadcrumb.
- **Markdown:**
  ```
  # Should I buy? Wilfa Innovac Aqua Plus HS1-SWB
  id 794250 · https://godpris.no/produkt/794250
  ## Recommendation: BUY NOW (site zone: God pris)
  Nå er det god pris 🥳                         ← zone.message when present
  - <each reason>
  Zones: God pris kr 2 799 – kr 2 990 · OK … · Kanskje …
  ## Offers
  Cheapest in stock: kr 2 799 at Skousen (På lager) [butikk](merchant_url|url)
  Cheapest overall: …                            ← only when it differs from cheapest in stock
  4 shops · 4 in stock · kr 2 799 – kr 4 495 · 19 % discount badge · record low   ← parts only when present
  Click & collect: 3 stores (shop 25: 2, shop 7: 1)   ← or "none" / omitted when unavailable
  Requests used: 4
  Next: get_price_history for the full series, get_product for every offer and spec.
  ```
  The recommendation label maps as BUY NOW / OK / WAIT / UNKNOWN. The parenthesis says `site zone: <label>` or `computed`.
- **notFound:** `({product_id}) => 'Product <id> not found'`.

##### 15. `find_products_by_requirements` (`composite/requirements.ts`)
- **Description:** "Find products in a category that meet spec requirements given in plain words, e.g. capacity ≥ 9 kg and energy class A. Maps each requirement to the category's filters (fuzzy, Norwegian or English labels), browses with them and reports which requirements could not be mapped plus the available filters so you can retry."
- **Input:**
  ```
  query: z.string().trim().min(1).max(200).describe('What you look for, e.g. "vaskemaskin"; used to pick the category when category_id is not given.'),
  category_id: categoryIdInput.optional(),
  requirements: z.array(z.object({
     label: z.string().trim().min(1).max(80).describe('Spec name (Norwegian or English) or filter key, e.g. "Vaskekapasitet", "energy class", "f226".'),
     min: z.coerce.number().optional().describe('Minimum for numeric specs.'),
     max: z.coerce.number().optional().describe('Maximum for numeric specs.'),
     values: z.array(z.string().min(1).max(60)).max(20).optional().describe('Wanted options, e.g. ["A"], ["Ja"], or a number with unit like ["9 kg"].'),
  })).min(1).max(15),
  max_price: priceMaxInput,
  sort: z.enum(CATEGORY_SORTS).default('price_asc'),
  max_pages: maxPagesInput(3, 10),
  limit: z.coerce.number().int().min(1).max(100).default(30).describe('Max products returned (1-100).'),
  ```
- **Flow:**
  1. Category:
     - With `category_id`, use `{id, name: '', source:'input', candidates: []}` and fill the name from the listing or filters later.
     - Otherwise call `resolveCategory(ctx, http, query, warnings)`.
  2. `defs = (await loadFilters(ctx, id, warnings, http)).filters`. This is disk-cached, so the second call is free. `category_name ||= data.category_name`.
  3. `m = matchRequirements(requirements, defs)` and push `m.warnings`.
  4. If `m.filters.length === 0`, do **not** browse. Return items [], `pages_scanned 0`, the text "No requirement could be mapped to a filter; retry with labels from available_filters." and the available filters. `requests_used` is 1–2.
  5. Otherwise set `pages = capPages(max_pages)`. For `p = 1..pages`, call `fetchCategoryListing(ctx, http, { category_id, sort, price_max: max_price, filters: m.filters, page: p }, warnings, { validate: p === 1 })`, with `walkError` for p > 1. Collect `items.map(toCompactRow)`, then call `progress(extra, p, pages, 'page p')`. Stop when any of these holds:
     - `!meta.has_next`;
     - the page had 0 items;
     - the deduped, filtered collection reaches `limit`;
     - `sort === 'price_asc' && max_price !== undefined` and the page's last priced item is above `max_price`.
  6. Post-process:
     - `dedupeById`;
     - drop rows with `price > max_price` (safety net; the site also gets `p_max`);
     - stable re-sort by the sort key:
       - `price_asc`/`price_desc` by price, with unpriced rows last;
       - `discount_desc` by discount (missing = 0);
       - `rating_avg_desc` by `value/max` (missing last);
       - `popularity` keeps site order;
     - `slice(0, limit)`.
  7. If the first listing's `page.subcategories.length > 0`, warn `Category <name> has subcategories (<first 5 "Name (id)">); requirements may map better in one of them`.
- **Output** `findOutput`:
  ```
  { query, category_id, category_name?, category_source: z.enum(['input','autocomplete','visited']),
    category_candidates?: [{id,name,product_count?}],
    applied_filters: [{requirement,key,filter_label,type,min?,max?,unit?,values?,value_labels?,score,note?}],
    unmatched_requirements: [{requirement, reason: z.enum([...6]), detail, suggestions: string[]}],
    available_filters: [{key,label,type,unit?,min?,max?,options?: string[]}],
    browse_filters: [{key,min?,max?,values?}],   // = m.filters, ready for browse_category/scan_category
    url?, sort, pages_scanned, total?: number, has_more: boolean, items: compactRow[], requests_used, warnings? }
  ```
  - `url` is the page-1 listing url, and `total` is the page-1 `meta.total`.
  - `has_more` is true when the last fetched page had a next page, or the collection was cut at `limit`.
- **Markdown:**
  ```
  # Products for "vaskemaskin" matching 3 requirements
  Category: Vaskemaskin (id 1220), from autocomplete     ← source wording: given / from autocomplete / from visited categories
  ## Applied filters
  - vaskekapasitet → **Vaskekapasitet** (`f226`): ≥ 9 kg
  - energy class → **Energiklasse** (`f189`): A, B
  - børsteløs motor → **Børsteløs motor** (`f235`): Ja  _(no value given; requiring Ja)_
  ## Unmatched requirements                             ← section only when any
  - wifi: no matching filter. Closest: …               ← suggestions or "none"
  - farge "lilla": not an option of Farge. Options: Hvit, Svart, …
  Available filters: Produsent (`b`), Pris (`p`, use max_price), Mating (`f237`: Frontmatet, Toppmatet), Vaskekapasitet (`f226`, 3–20 kg), …   ← only when unmatched exist
  ## Results (30 of 312, sorted price_asc)
  <url>
  <listingTable(items)>
  Pages scanned: 1 · more: browse_category with filters [{"key":"f226","min":9},{"key":"f189","values":["A","B"]}] page=2 · Requests used: 3
  ```
  - Range formatting: `≥ 9 kg`, `≤ 75 dB`, `9–12 kg`.
  - Always print the `filters [...]` JSON (browse_filters), so the LLM can chain.
- **notFound** (when the category is missing): `({category_id}) => category_id ? 'Category <id> not found' : 'Category not found'`.

##### 16. `hunt_deals` (`composite/hunt.ts`)
- **Description:** "Find the best current discounts across godpris.no, in one or more categories, or for a search query, then check the price history of the top candidates to separate genuine lows from inflated 'before' prices. Give either query or category_ids (or neither for all deals)."
- **Input:** a flat schema with no unions, validated at runtime.
  ```
  query: z.string().trim().min(1).max(200).optional().describe('Search words; omit to scan all deals or categories.'),
  category_ids: z.array(categoryIdInput).min(1).max(5).optional().describe('Category ids to scan instead of all deals.'),
  discount_min: z.coerce.number().int().min(1).max(95).default(20).describe('Minimum discount in percent.'),
  max_price: priceMaxInput,
  record_low_only: recordLowInput,
  sort: z.enum(['discount_desc','popularity']).default('discount_desc').describe('How the site orders candidates before verification.'),
  max_pages: maxPagesInput(5, 20),      // total listing pages across all sources
  verify_history_top: z.coerce.number().int().min(0).max(10).default(5).describe('How many top candidates to check against price history (2 requests each).'),
  limit: z.coerce.number().int().min(1).max(100).default(30).describe('Max deals returned.'),
  ```
- **Runtime validation:** when both `query` and `category_ids` are given, throw `InputError('Pass either query or category_ids, not both (or neither for all deals).')`. `mode` is `'search'` when query is given, `'category'` when category_ids is given, otherwise `'deals'`.
- **Sources and paging** (`pages = capPages(max_pages)`):
  - **deals:**
    - Private `fetchDealsPage(http, { sort, price_max, discount_min, record_low_only }, page, warnings)`.
    - `q = buildListingQuery({ sort, price_max, discount_min, record_low_only }, warnings)`, which gives `s`, `p_max`, `d_min` and `rekordbillig`, all verified on /tilbud.
    - Page 1 is `http.getHtml('/tilbud', { query: q })`. Page N is `{ ...q, o: (N-1)*48, l: 48, fragment: 1 }`.
    - Parse with `parseProductTiles` and `parseListingMeta`. No items on page 1 with `meta.total > 0` → `CoreDataMissingError('listing rows')`.
    - The user url is `siteUrl('/tilbud', q)`.
    - Implement this privately in hunt.ts. Do not import from the deals agent's `src/tools/deals.ts`, so this step has no dependency on its internals.
  - **search:** `fetchSearchListing(http, { query, sort, price_max, record_low_only, page }, warnings)`. Do **not** pass `discount_min`, because `d_min` is unverified on /sok.
  - **category:** `fetchCategoryListing(ctx, http, { category_id, sort, price_max, discount_min, record_low_only, page }, warnings, { validate: false })` for each id.
    - The page budget is shared **round-robin**: page 1 of every category, then page 2 of every category that still has a next page, until `pages` requests have been used.
    - A `NotFoundError` on a category's page 1 warns `Category <id> not found` and drops that category. When every category fails, rethrow the first error.
- **Early stop per source.** After each page, stop that source when any of these holds:
  - `!meta.has_next`;
  - there are 0 items;
  - `sort === 'discount_desc'` and some tile on the page has `(discount_pct ?? 0) < discount_min`. The list is sorted, so later pages are worse. `has_more` stays false for that reason.
- Call `progress(...)` after each page.
- **Candidates:**
  1. Map rows with `toCompactRow` plus `shop: item.offer_shop`.
  2. `dedupeById`, keeping the occurrence with the higher `discount_pct` (tie: lower price), and OR the `record_low` flags.
  3. Keep rows with `price !== undefined && (discount_pct ?? 0) >= discount_min && (max_price === undefined || price <= max_price)`.
  4. Do NOT filter on the record_low flag client-side; trust the site's `rekordbillig` param, because the tiles on /tilbud may not show the badge.
  5. Pre-rank:
     - `discount_desc` → discount desc, then `record_low` first, then `shop_count` desc (missing 0), then original order;
     - `popularity` → site order.
- **Verification** for the first `min(verify_history_top, candidates.length)` candidates, run **sequentially** (deterministic order; the limiter serializes anyway):
  - `a = await fetchHistoryAnalysis(ctx, http, id)` gives 2 requests.
  - `check = assessDeal({ price, discount_pct, points: a.points, stats: a.stats, verdict: a.verdict.verdict })`.
  - On `NotFoundError` or other errors, set `assessment 'unverified'` and `note 'no price history'` or `'history unavailable'`. This is never a tool error.
  - Push the `a.warnings` prefixed with `<id>: `.
- **Final order:**
  - Verified rows first, by `ASSESSMENT_RANK`, then `real_discount_pct` desc, then `discount_pct` desc.
  - Then the unverified remainder in pre-rank order.
  - `slice(0, limit)`.
- **Output** `huntOutput`:
  ```
  { mode: z.enum(['deals','search','category']), query?, category_ids?, discount_min, sort, sources: [{url, pages}],
    pages_scanned, candidates_found, verified, has_more,
    items: [compactRow.extend({ shop: z.string().optional(), assessment: z.enum([...5]).optional(), inflated_discount: z.boolean().optional(),
             implied_before_price: z.number().optional(), real_discount_pct: z.number().optional(), median_90d: z.number().optional(),
             history: historyBriefSchema.optional(), reasons: z.array(z.string()).optional(), note: z.string().optional() })],
    requests_used, warnings? }
  ```
  `candidates_found` counts the rows after dedupe and filters, before `limit`.
- **Markdown:**
  ```
  # Deal hunt: all deals (discount ≥ 20 %)              ← or: "vaskemaskin" / categories 1220, 1221
  Scanned 1 page · 34 candidates · verified the top 2 against price history · Requests used: 5
  ## Verified
  | ID | Product | Price | Shop | Claimed | Real vs 90d median | 90d low | All-time low | Verdict | Assessment |
  … assessment cell: "genuine ⚠ inflated before-price" when inflated_discount
  ## More candidates (not verified)
  <listingTable(rest)>                                  ← compact table
  Legend: all_time_low = at or below the lowest price ever seen; genuine = at the 90-day low, in the cheapest 10 % of the last 90 days, or in the site's God pris zone; modest = below the usual price but not at the low; inflated = little or no real saving despite the claimed discount.
  Next: evaluate_purchase <id> for a full buy check.
  ```

##### 17. `scan_category` (`composite/scan.ts`)
- **Description:** "Walk several pages of a category listing with the same filters as browse_category and return one flat list for analysis, e.g. cheapest per energy class. Page count is capped by the server (GODPRIS_MAX_PAGES)."
- **Input:** `category_id`, `sort: z.enum(CATEGORY_SORTS).optional()`, `brands`, `price_min`, `price_max`, `discount_min` (same as browse), `filters: filtersInput`, `record_low_only`, plus:
  - `start_page: z.coerce.number().int().min(1).max(100).default(1)`
  - `max_pages: maxPagesInput(5, 50)`
  - `include_properties: z.boolean().default(false).describe('Add the short spec summary shown on each tile (longer output).')`
- **Flow:**
  - `pages = capPages(max_pages)`. For `p = start_page .. start_page+pages-1`, call `fetchCategoryListing(ctx, http, {...args, page: p}, warnings, {validate: p === start_page})`, with `walkError` for p > start_page.
  - Stop on `!has_next` or 0 items.
  - `dedupeById`, keeping site order. Rows are `toCompactRow(item)` plus `properties: item.properties` only when `include_properties`.
- **Output** `scanOutput`:
  ```
  { category_id, category_name?, url, first_page, last_page, pages_scanned, total?, has_more, next_page?, items: compactRow.extend({ properties: z.string().optional() })[], requests_used, warnings? }
  ```
  - `url` is the page-1 url built with the filters, without `page`.
  - `next_page` is `last_page+1` when `has_more`.
- **Markdown:**
  - Header `## <name> (scan)`, then the url.
  - `Pages 1–5 of ~44 · 1 581 products · 179 rows · Requests used: 5` (the page count is `ceil(total/36)` when total is known).
  - Then `listingTable(items)`. When `include_properties`, use a table with an extra `Specs` column, built with `markdownTable` and the same columns plus `truncate(properties, 120)`.
  - Footer `More: call again with start_page=<next>` when `has_more`.
- **notFound:** `Category <id> not found`.

##### 18. `compare_best_options` (`composite/best-options.ts`)
- **Description:** "Pick the top products in a category (by popularity or expert rating), compare their specs side by side and summarise each one's price history. Give a category_id, or a query to find the category."
- **Input:**
  ```
  query: z.string().trim().min(1).max(200).optional(),
  category_id: categoryIdInput.optional(),
  top_n: z.coerce.number().int().min(2).max(6).default(4),
  sort: z.enum(['popularity','rating_avg_desc']).default('popularity'),
  max_price: priceMaxInput,
  include_history: z.boolean().default(true).describe('Add a price-history summary per product (2 requests each).'),
  ```
- **Runtime validation:**
  - With neither field, throw `InputError('Give category_id or query.')`.
  - With both, use `category_id` and warn `query ignored because category_id was given`.
- **Flow:**
  1. Resolve the category the same way as tool 15.
  2. `fetchCategoryListing(ctx, http, { category_id, sort, price_max: max_price, page: 1 }, warnings, { validate: false })`.
  3. `picks` = the first `top_n` deduped rows with a price and `price ≤ max_price`.
  4. If there are fewer than 2 picks, skip the compare, warn `Not enough products to compare`, and still return the list.
  5. Compare:
     - `html = await http.getHtml('/sammenlign', { query: { ids: picks.map(p => p.id).join(',') } })`, then `parseComparePage(html)`.
     - If the compare agent's `src/tools/compare.ts` exports an equivalent fetcher that takes an `HttpClient` (e.g. `fetchCompare(http, ids)`), use it instead. Otherwise keep these two lines; `parseComparePage` is the stable dependency.
     - Wrap this in try/catch; a failure warns `spec comparison unavailable`.
  6. `diff = specDifferences(page, picks.map(p => p.id))`, defined below.
  7. If `include_history`, run `fetchHistoryAnalysis(ctx, http, id)` sequentially for each pick and attach `toHistoryBrief`. A failure warns `<id>: price history unavailable`.
- **NEW exported pure helper** in best-options.ts: `export function specDifferences(page: ComparePage, ids: string[]): { rows: Array<{ group?: string; name: string; values: string[] }>; total_rows: number; missing_ids: string[] }`.
  - Build the column index by `page.products[i].id`, and re-order each row's values to match `ids`. A missing column gives "".
  - Keep a row when `new Set(values.map(v => v.trim())).size > 1`, which counts a blank against a value as a difference.
  - `missing_ids` = the ids that are not on the page. When **all** ids are missing, return rows [], and the caller warns `compare page returned other products (<ids>); spec differences skipped`.
- **Output** `bestOutput`:
  ```
  { category_id, category_name?, sort, url, compare_url?, products: compactRow.extend({ rank: z.number(), history: historyBriefSchema.optional() })[],
    spec_differences: [{ group?, name, values: string[] }], spec_rows_total: number, requests_used, warnings? }
  ```
  `compare_url` = `` `${BASE_URL}/sammenlign?ids=${ids.join(',')}` `` (a literal comma, for display).
- **Markdown:**
  ```
  # Best Vaskemaskin by popularity (top 4)
  <listing url>
  | # | Product | Price | Rating | Verdict | 90d low | All-time low |
  ## Spec differences (12 of 40 rows)
  | Spec | AEG 6000-serien… | Bosch … | … |     ← headers truncate(brand+title, 30); first column "Group: Name"; max 40 rows, then "+N more rows"
  Compare on godpris.no: <compare_url>
  Requests used: 7
  Next: evaluate_purchase <id> for the one you like.
  ```
- **notFound:** `Category <id> not found`.

---

### Patterns to follow
- **Tool registration, schemas and output.** Follow `/Users/oleast/git/test/godpirs-mcp/src/tools/categories.ts`:
  - `registerTool` + `handle` + `finish` for browse_category, around lines 330-433;
  - the `outputSchema` z.object with `...warningsField`, lines 33-91.
- **Counting view and `requests_used`.** See `/Users/oleast/git/test/godpirs-mcp/src/tools/watchlist.ts:208` and `:281-298`.
- **Disk-cached filters.** `loadFilters` in `/Users/oleast/git/test/godpirs-mcp/src/tools/categories.ts:101-126`.
- **Paging params.**
  - `/sok` fragment logic: `/Users/oleast/git/test/godpirs-mcp/src/tools/search.ts:140-156`.
  - Category `page`: `buildListingQuery` in `/Users/oleast/git/test/godpirs-mcp/src/tools/shared.ts:167-233`.
- **Verdict computation to move.** `/Users/oleast/git/test/godpirs-mcp/src/tools/history.ts:68-134`.
- **Product fetch, core-data checks and breadcrumb indexing to move.** `/Users/oleast/git/test/godpirs-mcp/src/tools/product.ts:97-120`.
- **Pure-module test style.** `/Users/oleast/git/test/godpirs-mcp/test/parsers/history.test.ts` and `test/match/normalize.test.ts`, with `fixture()` from `test/parsers/helpers.ts`.

### Tests

**Harness extension** (`/Users/oleast/git/test/godpirs-mcp/test/tools/harness.ts`). These changes are additive; other agents may edit the same file, so merge.
- `Route` gets `query?: Record<string, string | null>`.
  - A route matches when its path matches **and** every listed param matches: `v === null ? !url.searchParams.has(k) : url.searchParams.get(k) === v`.
  - The first matching route wins, so list specific routes first.
- `connectTools(routes, opts: { now?: Date; env?: Record<string, string> })`. `env` is merged into `createConfig({ GODPRIS_DATA_DIR: tmp, ...opts.env })`; for example `{ GODPRIS_MAX_PAGES: '2' }`.

**Pure tests:**
- `test/match/normalize.test.ts`: add the `fuzzyScore` expectations from section B. The existing `matchScore` expectations stay unchanged.
- NEW `test/match/requirements.test.ts`, with `defs = parseFilters(fixture('kat_1220.html')).filters`:
  1. `{label:'vaskekapasitet', min:9}` gives applied `{key:'f226', type:'range', min:9}` and `filters [{key:'f226', min:9}]`.
  2. `{label:'Kapasitet', values:['9 kg']}` gives f226 `min 9` with a note containing "minimum".
  3. `{label:'energy class', values:['a','B']}` gives f189 `values ['A','B']`.
  4. `{label:'F189', values:['C']}` gives f189 with score 1.
  5. `{label:'børsteløs motor'}` gives f235 `['1']`. `{label:'Innvendig belysning', values:['nei']}` gives f236 `['0']`.
  6. `{label:'farge', values:['sort','lilla']}`:
     - applied f472 `values ['Svart']`;
     - one unmatched `value_not_found` whose detail contains "lilla" and whose suggestions are non-empty.
  7. `{label:'merke', values:['bosch','aeg']}` gives b `['Bosch','AEG']`.
  8. `{label:'støynivå', max:75}` gives f228 (not f230) with `max 75`.
  9. `{label:'wifi'}` gives `no_matching_filter`, and `filters` is empty.
  10. `{label:'f9999', min:1}` gives `unknown_key`.
  11. `{label:'Energiklasse'}` gives `needs_value`, with a detail that mentions values.
  12. `{label:'vaskekapasitet', min:10, max:8}` gives `invalid_range`.
  13. `[{label:'vaskekapasitet', min:8}, {label:'kapasitet', min:9}]` gives one filter f226 with `min 9`, plus a merge warning.
  14. `{label:'bredde', values:['maks 60 cm']}` gives f157 `max 60`. `{label:'dybde', values:['under 600 mm']}` gives f175 `max 60` with a note containing "converted".
  15. `{label:'vaskekapasitet', min:25}` is applied, with a warning containing "No product".
  16. `parseNumeric`:
      - '9 kg' → `{value:9, unit:'kg'}`
      - '1 400 rpm' → `value 1400`
      - '8,5' → 8.5
      - '8-10 kg' → `{min:8, max:10}`
      - 'abc' → undefined
  17. `availableFilters(defs)`: f226 has no options and `unit 'kg'`; f472's options contain 'Hvit'; b's options have ≤ 12 entries.
- NEW `test/analysis/verdicts.test.ts`, with `pts = parseHistoryJson(JSON.parse(fixture('hist_all.json'))).points` and `stats = computeHistoryStats(pts, new Date('2026-11-11T12:00:00Z'))`:
  - `assessDeal({price:2799, discount_pct:19, points:pts, stats, verdict:'good'})` gives:
    - `assessment 'genuine'`, `median_90d 2990`, `real_discount_pct 6.4`, `implied_before_price 3456`;
    - `inflated_discount true` (the claim is more than double the real discount).
  - `assessDeal({price:2290, …})` gives `all_time_low`.
  - With hist_other (`stats2`), `assessDeal({price:10990, discount_pct:10, …, verdict:'ok'})` gives `inflated`.
  - A flat synthetic history (100 daily points at 1000 ending 2026-11-11), price 1000, discount 50, gives `inflated` with `inflated_discount true` and `implied_before_price 2000`.
  - Five points only gives `unverified`.
  - `purchaseRecommendation`:
    - `good/site` → `buy_now`, and the reasons include "Site zone: God pris";
    - `maybe` → `wait`;
    - `unknown` with today == low_90d → `buy_now`;
    - `unknown` otherwise → `unknown`;
    - `in_stock_offers 0` adds "No shop lists it in stock".
  - `median([3,1,2]) === 2`, `median([1,2,3,4]) === 2.5`, `median([]) === undefined`.
- `specDifferences(parseComparePage(fixture('sammenlign.html')), ['1588920','794250'])`:
  - the first row's values are `['', '0.7 L']`;
  - `missing_ids` is empty;
  - every returned row has differing values.
  - With ids `['1','2']`, `rows` is empty and `missing_ids` is `['1','2']`. Put this in `test/tools/best-options.test.ts` or a pure test file.

**Tool tests.** Use the `test/tools/*.test.ts` style with `afterEach(close)`. Each one asserts `structuredContent.requests_used === h.calls.length` and `h.unexpected` is empty, unless the test says otherwise.
- `test/tools/evaluate.test.ts`
  1. Routes: `/produkt/794250`→`prod_794250.html`, `/api/product/collectAtStoreCount` json `{counts:[{shop_id:25,total:"2"}]}`, `/api/product/history`→`hist_all.json`, `/api/product/history-section`→`hist_section.html`. Expect:
     - `recommendation 'buy_now'`, `zone.source 'site'`, `zone.label 'God pris'`;
     - `cheapest_in_stock {shop:'Skousen', price:2799}`;
     - `history.low_all_time 2290`, `history.vs_90d_low_pct 0`;
     - `collect_at_store.total_stores 2`, `requests_used 4`;
     - the text contains "BUY NOW" and "Requests used: 4".
     - **Call it again on the same harness:** `requests_used 0`, and `h.calls.length` is still 4 (cache hits are not counted).
  2. The history route returns status 500, which counts as not found. The result is not isError; `recommendation 'unknown'`, the warnings contain "price history unavailable", and `history` is undefined.
  3. `/produkt/1` returns status 404, giving isError "Product 1 not found".
- `test/tools/requirements.test.ts`
  1. Routes, in this order:
     - `/api/product/search`→`ac_items.json`
     - `{path:'/kategori/1220', query:{s:null}, file:'kat_1220.html'}` (the filters fetch)
     - `{path:'/kategori/1220', query:{page:'2'}, file:'kat1220_p2.html'}`
     - `{path:'/kategori/1220', file:'kat1220_price_asc.html'}`
     
     Call `{query:'vaskemaskin', requirements:[{label:'vaskekapasitet',min:9},{label:'energiklasse',values:['A']},{label:'wifi'}], max_price:8000, max_pages:2, limit:50}`. Expect:
     - `category_id '1220'`, `category_source 'autocomplete'`;
     - the applied keys are `['f226','f189']`, and the unmatched entry has `requirement 'wifi'`;
     - `available_filters.length > 10`;
     - the first listing call has `s=price_asc`, `f226_min=9`, `f189=A` and `p_max=8000`, and no `page`;
     - the second listing call has `page=2`;
     - `items.length === 49`, every price ≤ 8000;
     - `pages_scanned 2`, `requests_used 4`;
     - the text contains `"key":"f226"`.
  2. The same routes with `requirements:[{label:'wifi'}]` give items [], `pages_scanned 0`, `requests_used 2` and text containing "Available filters".
  3. `category_id:'1220'` given: there is no `/api/product/search` call (`requests_used 2` with `limit:10`), and `category_source 'input'`.
  4. Calling (1) twice on one harness: the second call has `requests_used` 0 (memory and disk cache).
- `test/tools/hunt.test.ts`
  1. Routes: `/tilbud`→`tilbud.html`, `/api/product/history`→`hist_all.json`, `/api/product/history-section`→`hist_section.html`. Call `{verify_history_top:2, max_pages:2}`. Expect:
     - one `/tilbud` call, with `d_min=20`, `s=discount_desc` and no `o` (early stop, because the fixture contains discounts < 20);
     - history calls with `id=i_715911` and `id=i_10182936`, in that order;
     - `requests_used 5`, `verified 2`, `candidates_found 34`, `items.length 30`;
     - `items[0].id '715911'` with `assessment 'all_time_low'`; `items[1].assessment 'genuine'` and `inflated_discount true`;
     - every item has `discount_pct ≥ 20`, `mode 'deals'`.
  2. `{category_ids:['1220'], discount_min:30, verify_history_top:0}` with route `/kategori/1220`→`kat_1220.html`. The call has `s=discount_desc` and `d_min=30`. Expect 6 items, `requests_used 1`, `mode 'category'`.
  3. `{query:'vaskemaskin', discount_min:40, verify_history_top:0}` with route `/sok`→`search_vask.html`. The call has `q=vaskemaskin` and `s=discount_desc`, and no `d_min`. Expect 4 items.
  4. Both `query` and `category_ids` give isError, with a message containing "either query or category_ids", and `h.calls` is empty.
  5. The history route returning 404 with `verify_history_top:1` gives `items[0].assessment 'unverified'` and `note 'no price history'`; it is not an error.
- `test/tools/scan.test.ts`
  1. Routes: `{path:'/kategori/1220', query:{page:null}, file:'kat_1220.html'}`, `{…, query:{page:'2'}, file:'kat1220_p2.html'}`. Call `{category_id:'1220', max_pages:2}`. Expect `items.length 71` (1 overlap), `pages_scanned 2`, `has_more true`, `next_page 3`, `requests_used 2`, and no `properties` key on the rows.
  2. `env {GODPRIS_MAX_PAGES:'2'}` with `max_pages:5` gives `pages_scanned 2` and a warning containing "capped at 2".
  3. Add a route `{query:{page:'3'}, status:404}` with `max_pages:3`. Expect `pages_scanned 2` and a warning containing "page 3". There is a third call, so `requests_used 3`.
  4. `include_properties:true` gives at least one row with `properties` containing "kg".
- `test/tools/best-options.test.ts`
  1. Routes: `/kategori/1220`→`kat_1220.html`, `/sammenlign`→`sammenlign.html`, history and section routes as above. Call `{category_id:'1220', top_n:2}`. Expect:
     - the sammenlign call has `ids === '5099462,8394093'`;
     - `products` has 2 entries, each with `history.verdict 'good'`;
     - `spec_differences` is empty, with a warning containing "other products" (the fixture compares different ids);
     - `requests_used 6`.
  2. `{query:'vaskemaskin', top_n:2, include_history:false}` with `/api/product/search`→`ac_items.json` gives `category_id '1220'` and `requests_used 3`.
  3. Neither query nor category_id gives isError "Give category_id or query."
- `test/tools/schemas.test.ts`: add `evaluate_purchase`, `find_products_by_requirements`, `hunt_deals`, `scan_category` and `compare_best_options` to `EXPECTED`. Merge with the names the other agents add. The flatness, name and integer-bound checks must pass for all five; `requirements` is an array of flat objects, which is allowed.

No new fixtures are needed; everything above uses the existing files in `test/fixtures`.

### Verification
- `cd /Users/oleast/git/test/godpirs-mcp && npm run typecheck && npm test && npm run build`. All existing tests stay green, especially `test/tools/categories.test.ts`, `search.test.ts`, `product.test.ts` and `history.test.ts`, which cover the refactored handlers.
- Optional live check (about 15 requests, 1 rps) through `npm run inspect`:
  - `find_products_by_requirements {query:"vaskemaskin", requirements:[{label:"vaskekapasitet",min:9},{label:"energiklasse",values:["A"]}], max_price:8000}` maps to f226/f189 and returns rows;
  - then `evaluate_purchase` on the first row;
  - `hunt_deals {verify_history_top:2, max_pages:1}`.

### Edge cases & risks
- **`d_min` on `/kategori` and `/sok` is unverified.** Discounts are always re-filtered client-side, and `/sok` never gets `d_min`. If the site ignores it on `/kategori`, the early stop by discount sort keeps the page count low.
- **`rekordbillig` on the hunt is not re-filtered client-side** (/tilbud tiles may lack the badge). It relies on the site param.
- **Request budget vs client timeouts.**
  - Worst case at the default config: hunt_deals 10 pages + 10×2 history = 30 requests, about 30–40 s at 1 rps, against a common 60 s client timeout.
  - The page caps (`GODPRIS_MAX_PAGES`) and `verify_history_top ≤ 10` bound it. Progress notifications help the clients that reset on progress.
  - Do not add parallelism beyond the limiter.
- **Cache semantics.** `requests_used` counts network requests in this call only, so repeated calls report fewer. State this in the markdown footer wording ("cached responses are free" in the descriptions is optional).
- **Category resolution can pick the wrong category.** Example: "vask" resolves to 2126 "Kombinert vask/tørk". The tool always shows the category and `category_candidates`, and warns when the pick did not come from a confident name match. The LLM can retry with `category_id`.
- **Non-leaf categories** (e.g. 449) expose only generic filters. The tool warns with subcategories.
- **Short enum values** ("A", "B") match exactly only, so "A" never fuzzy-matches "A+++". Value synonyms are deliberately minimal.
- **A range requirement given as a bare value** ("9 kg") is read as a minimum unless it carries a max marker; the note says so. Unit conversion covers only mm/cm/m and g/kg.
- **Merging two requirements on the same key** intersects their ranges, which can produce `min > max`. In that case the site returns 0 rows; warn but don't fail.
- **Page overlap between pages** (the site re-sorts): de-dupe by id. Variants of one product group (e.g. colours) stay separate rows.
- **Compare fixture mismatch.** The tool test only checks the "other products" path; `specDifferences` is covered by the pure test.
  - The `/sammenlign?ids=` comma is sent URL-encoded as `%2C` by the client's `URLSearchParams`. The compare agent has the same issue; verify it in the live smoke.
  - If `%2C` fails, pass the path as `/sammenlign?ids=a,b` with no `query`. `new URL` keeps the literal comma.
- **Concurrent edits.** `src/tools/index.ts`, `test/tools/schemas.test.ts` and `test/tools/harness.ts` are touched by other agents too, so merge rather than overwrite. Do not import from `src/tools/deals.ts` or `src/tools/compare.ts` internals, except the optional fetcher swap noted in tool 18.
- **Refactor safety.** Moving the logic into `fetchCategoryListing`, `fetchSearchListing`, `fetchProductPage` and `fetchHistoryAnalysis` must keep the warning strings and their order identical, because the existing tests assert on some of them.
- **Output size.** `scan_category` at 10 pages is about 360 rows (about 50 KB of markdown), which is acceptable for a bulk tool. `include_properties` defaults to false, per the compact-rows decision.

### Blockers
None. Two small optional additions keep the plan's decisions and only add bounded knobs:
- `limit` on tools 15 and 16, `start_page`/`include_properties` on tool 17, and `max_price`/`include_history` on tool 18.
- `sort` on tool 16.

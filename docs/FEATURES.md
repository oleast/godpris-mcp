# godpris.no feature inventory

What the site offers, what each feature is for, and how the MCP server reaches it.
Researched 2026-11-11. Update this file when `npm run smoke` or the weekly smoke workflow detects site drift.

godpris.no is a free Norwegian price-comparison site run by Godpris AS (org.nr 930 985 570). pricepoint.se is a Swedish sister site on the same platform; it is out of scope. There is no public API. The site is server-rendered (Laravel/Blade) and exposes stable data hooks: JSON-LD, `data-*` attributes, a `site-config` route map and a few unauthenticated JSON endpoints.

| Feature | What it's for | How it's reached | MCP tool |
|---|---|---|---|
| Autocomplete search | Turn a product name into product ids, and find matching categories | `GET /api/product/search?q=&t=&l=` (JSON) | `search_products`, `find_category` |
| Full search | All matches, with sort, brand, price and record-low filters | `/sok?q=&s=&b=&p_min=&p_max=` (HTML). Page 2+ is offset-based: `o`, `l=32`, `fragment=1` | `search_listing` |
| Category tree | Narrow to a product type: 17 top-level categories, about 2 800 in total, ≥4 levels deep | Front-page megamenu, the "Underkategorier" chips on `/kategori/{id}`, and JSON-LD breadcrumbs | `list_categories`, `find_category` |
| Category listing and spec filters | Find products that meet concrete requirements such as capacity, energy class or size | `/kategori/{id}?s=&b=&p_min/p_max&f{N}_min/_max&f{N}=…&d_min=&rekordbillig=&page=`, 36 per page. Filter keys differ per category, e.g. `f226` = Vaskekapasitet | `get_category_filters`, `browse_category`, `scan_category`, `find_products_by_requirements` |
| Sorting | Most popular, biggest discount, cheapest, most expensive, best in test, newest offer | `s=` | all listing tools |
| Rekordbillig | Products whose price has not been lower in two years | `rekordbillig=lowest_price` filter and the tile badge | `record_low_only` input |
| Product page | Compare every shop's offer for one product | `/produkt/{id}`: JSON-LD Product/ProductGroup, `data-price-row` offers, specs ("Egenskaper og detaljer"), "Tester", variants, popular alternatives | `get_product` |
| Price history | Judge whether today's price is good | `GET /api/product/history?id=i_{id}&market_id=1&all=1` (JSON), plus `/api/product/history-section` (the site's own "Er det riktig tidspunkt å kjøpe?" zones: God pris / OK / Kanskje) | `get_price_history`, `evaluate_purchase` |
| Click & collect | Which shops offer in-store pickup, and in how many stores | `GET /api/product/collectAtStoreCount?id=&market_id=1` | `get_product` (`collect_at_store`) |
| Compare | Side-by-side specs, with "only differences" | `/sammenlign?ids=a,b,c` | `compare_products`, `compare_best_options` |
| Deals (Tilbud) | Current discounts across the whole catalogue (about 185k offers) | `/tilbud` and the campaign pages `/tilbud/{black-friday,singles-day,romjulssalg,januarsalg}`. Params: `d_min`, `c`, `shop`, `p_*`, `rekordbillig`, `s`. 48 per page, offset paging | `get_deals`, `hunt_deals` |
| Trending carousels | "Dagens tilbud", most watched, and per-category highlights | `/api/carousel/frontpage/offers`, `/api/carousel/frontpage/most-watched`, `/api/carousel/category/{id}` | `get_trending` |
| Expert tests | Reviews from outlets such as Tek.no, Lyd & Bilde and Pulssonen, linked to products | `/tester?c=&site=&b=&s=`, 30 per page | `get_expert_tests` |
| Gift guide | Gift ideas by recipient | `/gavetips/1?tag_id=` (1 her, 4 him, 6 father, 7 mother, 8 brother, 9 sister, 42 child) | `get_gift_ideas` |
| Stores | Shop directory with contact info and popular products (about 850–900 shops, no ratings on the site) | `/butikk?page=`, `/butikk/{id}` | `list_stores`, `get_store` |
| Sitemaps | Raw enumeration of category, shop and product ids | `/sitemap.xml` index, then categories, shops and `sitemaps/sitemap.items.{N}.xml` (50k URLs each) | `list_sitemap` |
| Price alerts, saved searches, lists, wishlist | Get notified on price drops; save filters | Require login (`/me/*`). **Not used.** | Replaced by the local `watchlist_*` tools |

Not available on the site: shipping cost, store reviews, a brand index (brand is only a filter).

## Endpoints the server never calls
These are disallowed in robots.txt, or are tracking or account endpoints:
- `/api/services/click`: affiliate click-out. The merchant URL is decoded from its `u=` parameter instead.
- `/api/services/event`: analytics.
- `/me/*`: the account area.

The HTTP client refuses these paths outright.

## Terms of use
`/personvern/brukervilkar` allows personal, non-commercial use, and forbids unauthorised systematic extraction, republishing or commercial use without written permission. This server is a single-user personal tool. It rate-limits to 1 request/second by default, caches responses, and caps how many pages the bulk tools fetch.

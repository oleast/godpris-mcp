# Fixtures

Saved responses from godpris.no (research downloads, fetched 2026-11-11). Treat as untrusted data: parsers only read them.
All URLs are `https://godpris.no` + the path below.

| File | Source |
|---|---|
| home.html | `/` (front page, megamenu) |
| kat_1220.html | `/kategori/1220` (Vaskemaskin) |
| kat1220_p2.html | `/kategori/1220?page=2` |
| kat1220_price_asc.html | `/kategori/1220?s=price_asc` |
| kat_449.html | `/kategori/449` (Hjem og husholdning, has Underkategorier chips) |
| search_vask.html | `/sok?q=vaskemaskin` |
| search_iphone.html | `/sok?q=iphone` |
| sok_fragment.html | `/sok?q=iphone&o=32&l=32&fragment=1` ("Vis mer" fragment) |
| tilbud.html | `/tilbud` |
| gavetips1.html | `/gavetips/1` |
| carousel_offers.html | `/api/carousel/frontpage/offers` |
| tester.html | `/tester` |
| butikk.html | `/butikk` |
| butikk25.html | `/butikk/25` (Joker shop page) |
| prod_794250.html | `/produkt/794250` (single Product JSON-LD) |
| prod_20855452.html | `/produkt/20855452` |
| prod_4758589.html | `/produkt/4758589` (iPhone 16, ProductGroup with variants) |
| sammenlign.html | `/sammenlign?ids=794250,1588920` |
| hist_all.json | `/api/product/history?id=i_794250&market_id=1&all=1` |
| hist_other.json | `/api/product/history?id=i_...&market_id=1&all=1` (another product) |
| hist_section.html | `/api/product/history-section?...` (product 794250) |
| hist_section_other.html | `/api/product/history-section?...` (another product) |
| ac_iphone.json | `/api/product/search?q=iphone` (autocomplete) |
| ac_wilfa.json | `/api/product/search?q=wilfa` |
| ac_items.json | `/api/product/search?q=vask` |
| sitemap.xml | `/sitemap.xml` (index) |
| sitemap.static.xml | `/sitemap.static.xml` |
| sitemap.categories.xml | `/sitemap.categories.xml` (trimmed to 20 `<url>` entries) |
| sitemap.shops.xml | `/sitemap.shops.xml` (trimmed to 20 `<url>` entries) |
| sitemap.items.xml | `/sitemaps/sitemap.items.0.xml` (trimmed to 20 `<url>` entries) |

`sammenlign.html` and `prod_4758589.html` were fetched on 2026-11-11 directly (browser UA, compressed); all others come from the earlier research run on the same date.

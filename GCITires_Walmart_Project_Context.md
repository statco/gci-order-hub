# GCI Tires — Walmart Canada Integration
## Project Context Document
**Last updated:** May 29, 2026 (Session 11)
**Prepared by:** Claude (Anthropic) for Patrick B. Pierre, GCI Inc.

---

## 1. Business Context

**Company:** Groupe de Commerce Intercontinental Inc. (GCI Inc.)
**Division:** GCI Tires — gcitires.com
**Walmart Seller ID:** 10002930522
**Walmart Store Name:** GC Tires
**Walmart Support Contact:** Amar (Amarjeet Singh, Walmart MP Support)

**Key deal terms (Amar, May 2026):**
- 75% discount on referral fees until Jan 31, 2027 → **effective fee: 2.5%**
- Full catalogue upload approved — all brands
- Do NOT reduce prices — submit promotions instead
- Enroll items for Flash deals (Seller Center action)

**Status:** 2,755 items on Walmart Canada. Latest feed submitted 2,474 items. 2,093 SKUs matched for daily price+inventory sync.

**Focus:** Tires only. Nuproz/CJ Dropshipping discontinued. Wheels may be added eventually.

---

## 2. Technology Stack

### Repositories
| Repo | Purpose | Deployed at |
|---|---|---|
| `statco/gci-order-hub` | Walmart sync, item feed, order routing | gci-order-hub.vercel.app |
| `statco/gci-brain` | Shopify sync, internal tools dashboard | gci-brain.vercel.app |

### Core Stack
- **Runtime:** Node.js / TypeScript
- **Deployment:** Vercel Pro (300s max timeout)
- **Shopify:** gcitires.myshopify.com (REST API 2024-01)
- **Walmart API:** Global Marketplace API v3.1

---

## 3. Vercel Environment Variables (gci-order-hub)

| Variable | Value / Notes |
|---|---|
| `WALMART_CLIENT_ID` | Canada marketplace client ID |
| `WALMART_CLIENT_SECRET` | Canada marketplace secret |
| `WALMART_BASE_URL` | `https://marketplace.walmartapis.com` |
| `WALMART_MARKET` | `ca` (lowercase — required) |
| `SHOPIFY_STORE_DOMAIN` | `gcitires.myshopify.com` |
| `SHOPIFY_ADMIN_API_TOKEN` | Shopify admin token (`shpat_...`) |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook verification secret |
| `ORDER_ROUTER_SECRET` | HMAC auth for order routing |
| `TELEGRAM_BOT_TOKEN` | Notification bot |
| `TELEGRAM_CHAT_ID` | Notification target |
| `GMAIL_USER` | Gmail for CT tracking notifications |
| `GMAIL_APP_PASSWORD` | Gmail app password |
| `GOOGLE_SHEETS_*` | Sheets credentials for order logging |

---

## 4. API Endpoints (gci-order-hub.vercel.app)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/walmart-sync` | GET | Push price+inventory for published SKUs |
| `/api/walmart-item-feed` | GET/POST | Submit bulk MP_ITEM_INTL feed |
| `/api/walmart-feed-status` | GET | Poll feed status by feedId (includeDetails=true hardcoded) |
| `/api/walmart-feed-diag` | GET | Diagnostic: dump raw Walmart feed response to inspect structure |
| `/api/walmart-price-audit` | GET | Audit + auto-correct Walmart prices vs Shopify (5% threshold) |
| `/api/walmart-order-sync` | GET/cron | Poll Walmart orders, acknowledge, route to CT |
| `/api/getPendingOrders` | GET | Fetch pending Walmart orders |
| `/api/ct-tracking-parser` | GET/cron | Parse CT tracking PDFs from Gmail |
| `/api/walmart-listed-count` | GET | Diagnostic: count published SKUs by status |
| `/api/order-router` | POST | Shopify webhook — routes paid orders |
| `/api/authorize-order` | GET | HMAC-signed payment link generator |

**Crons (vercel.json):**
- `walmart-sync` offset=0..2400, limit=300: 9 staggered jobs, 4:00–4:40 AM EST daily
- `walmart-order-sync`: every 15 min
- `walmart-price-audit`: daily at 10:00 AM EST (auto-corrects all flagged SKUs in cron mode)
- `ct-tracking-parser`: periodic (check vercel.json for schedule)

---

## 5. Walmart Sync Flow (api/walmart-sync.ts)

```
GET /api/walmart-sync?mode=listed[&offset=N&limit=M]
  1. Fetch all Shopify ct-sync variants (no SKU prefix filter)
  2. fetchListedSkus() — offset-based pagination, 200/page:
     GET /v3/items?limit=200&offset=N&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE
     Returns totalItems + ItemResponse[] per page
  3. Filter Shopify variants to matched published Walmart SKUs
  4. Safety-zero inventory for qty < 4
  5. PUT /v3/price (array format) + PUT /v3/inventory?sku=xxx
```

**Current state:** 2,093 Shopify variants matched to Walmart listings (up from 235 before May 29 session).

**Cron coverage:** 9 staggered calls cover up to 2,700 listed SKUs:
```
offset=0,300,600,...,2400 limit=300, every 5min from 4:00 AM EST
```

### Correct Payload Formats

**Price** (PUT /v3/price):
```json
{
  "sku": "TIRE-xxx",
  "pricing": [{
    "currentPriceType": "BASE",
    "currentPrice": { "currency": "CAD", "amount": 189.99 }
  }]
}
```

**Inventory** (PUT /v3/inventory?sku=TIRE-xxx):
```json
{ "sku": "TIRE-xxx", "quantity": { "unit": "EACH", "amount": 12 } }
```

---

## 6. Walmart API Configuration (api/lib/walmart-client.ts)

### Token
- `POST /v3/token` with Basic auth, cached 900s via `getWalmartToken()`

### Required Headers
```
WM_SEC.ACCESS_TOKEN, WM_GLOBAL_VERSION: 3.1, WM_MARKET: ca
WM_SVC.NAME: Walmart Marketplace, WM_QOS.CORRELATION_ID: <crypto.randomUUID()>
Accept: application/json, Content-Type: application/json
```

### Key Functions
- `getWalmartToken()` — cached token
- `fetchListedSkus()` — offset pagination, returns `Set<string>` of all PUBLISHED+ACTIVE SKUs
- `bulkPriceFeed(items)` → `{ success, failed }`
- `bulkInventoryFeed(items)` → `{ success, failed }`

### Walmart Items API Notes
- `GET /v3/items` — NO cursor pagination; uses offset+limit
- `totalItems` field = total count; `ItemResponse[]` = items on page
- Max 200 items per page
- Item shape: `{ mart, sku, wpid, upc, gtin, productName, price: { currency, amount }, publishedStatus, lifecycleStatus }`
- `includeDetails=true` on feed status returns `itemDetails.itemIngestionStatus[]`
- Feed status may stay `INPROGRESS` indefinitely if 1 item gets stuck — normal Walmart behavior
- Vercel cron invocations send `x-vercel-cron: 1` header

---

## 7. Shopify Data Structure

### Products
- Tag filter: `ct-sync` (auto-applied by shopifySync.ts)
- All 2,070 active tire products have `ct-sync`
- Fields fetched: `id, title, vendor, tags, images, variants`
- No SKU prefix filter — all variants eligible
- Total variants: ~3,618 (as of May 29)

### Known SKU Issues
- **Null SKU products archived (May 27):** 38 archived, 79 already archived = 117 total handled.
  Affected series: Cooper Procontrol, Zeon RS3-G1, Cobra Instinct, Nexen OE series,
  Discoverer Snow Claw, Discoverer Rugged Trek, Installation & Service, Michelin X-Ice Snow,
  Nokian Hakkapeliitta 10, Pirelli Ice Zero variants
- **Flotation sizes** (~25 SKUs) — compact format `3513/R` etc. still unparseable
- **Persistent duplicate TIRE- SKUs** (20 groups) — feed dedup handles correctly
- **Some Vredestein variants** have both bare and TIRE- prefixed SKUs in Shopify — minor cleanup needed

### Pricing Model (gci-brain/api/shopifySync.ts)
```typescript
// Tiered formula — read directly by Walmart feed (no separate calculation)
if (cost < 100)       raw = Math.max(cost * 2.10, 150);
else if (cost <= 250) raw = cost * 1.72;
else                  raw = cost * 1.58;
// Rounded to .99
```

---

## 8. Item Feed (api/walmart-item-feed.ts)

### Feed Spec — MP_ITEM_INTL v3.16
```
feedType: MP_ITEM_INTL, version 3.16, processMode REPLACE
productIdentifiers: { productIdType: "GTIN", productId: "CUSTOM" }
Structure: Orderable + Visible.Tires
```

### Last Feed Run (May 27, 2026 — Session 10)
- **feedId:** `18B38EBDDBE555E1BB37C616058C8F43@Ae0BBwA`
- **Submitted:** 2,474 | **Skipped:** 612
- Skip reasons: null SKUs (~80), bare SKUs with TIRE- twin (~350), duplicates (~150), parse errors (~3)

### SKU Filter Logic (as of d53d480)
```typescript
// Pre-pass: collect base SKUs that have a TIRE- prefixed counterpart
const tirePrefixedBaseSkus = new Set<string>();
for (const p of allProducts) {
  for (const v of p.variants) {
    if (v.sku?.startsWith('TIRE-')) tirePrefixedBaseSkus.add(v.sku.slice(5));
  }
}
// In variant loop: skip bare SKU only if TIRE- version exists
if (!variant.sku.startsWith('TIRE-') && tirePrefixedBaseSkus.has(variant.sku)) {
  skipped.push({ ..., reason: 'Non-TIRE- SKU (TIRE- version exists)' });
  continue;
}
```

---

## 9. Price Audit (api/walmart-price-audit.ts)

### Purpose
Compares Walmart listed prices against Shopify prices. Flags and auto-corrects SKUs where Walmart price is >5% below Shopify price.

### How it works
1. Fetches all 2,755 Walmart listed items with prices via `GET /v3/items`
2. Fetches all Shopify variant prices via GraphQL cursor pagination
3. Builds full flagged list, sorts by worst discrepancy
4. Slices by `offset`/`limit` for paginated corrections
5. In cron mode (`x-vercel-cron: 1` header), sets limit=99999 to correct all at once

### Usage
```
GET /api/walmart-price-audit?dryRun=true          — report only
GET /api/walmart-price-audit?offset=0&limit=300   — correct first 300 flagged
GET /api/walmart-price-audit                      — correct all (cron mode auto-detects)
```

### May 29 Incident
- A real customer order was placed for 4× Cooper Discoverer AT3 XLT 295/70R18 at $285 each
- Correct price was $537.99 — would have resulted in ~$720 loss
- Order was cancelled by Patrick
- Root cause: 456 SKUs had stale $285 price on Walmart from early feed submissions
- All 456 corrected on May 29 via price audit
- Daily cron added to prevent recurrence

### Shopify GraphQL pagination note
- REST `/variants.json` Link header pagination is unreliable — stops at ~2,527 variants
- GraphQL `productVariants` with `pageInfo.hasNextPage` / `endCursor` is reliable
- 2,527 appears to be actual API-visible variant count (some variants may be excluded by Shopify)

---

## 10. Order Routing (api/walmart-order-sync.ts)

### Status: Built and running (PR #13, #14)
Polls every 15 min. When Walmart orders arrive:
1. Acknowledge on Walmart (within 4hr requirement)
2. Match SKU → Canada Tire part number
3. Generate CT PO
4. Log to Google Sheets
5. Send Telegram + Gmail notification to Patrick

### First Real Order — May 29, 2026
- Customer: Jason Harrisson
- Order: 4× Cooper Discoverer AT3 XLT 295/70R18 (TIRE-170034002) at $285 (incorrect price)
- Order ID: 600000103212221
- Action: Cancelled by Patrick due to pricing error
- Customer contacted via Walmart messaging asking why order was cancelled
- Response drafted and sent explaining pricing error

### CT Tracking Parser (api/ct-tracking-parser.ts)
- Parses CT tracking PDFs from Gmail
- Extracts tracking numbers
- Marks orders shipped on Walmart via `POST /v3/orders/{id}/shipping`

---

## 11. Current Status

### ✅ Working
- 2,755 items on Walmart Canada
- Latest feed: 2,474 items submitted
- **2,093 SKUs matched for daily price+inventory sync** (up from 235)
- Smart bare-SKU filter: only skips bare SKUs when TIRE- twin exists
- 117 null-SKU products archived
- `walmart-feed-status` endpoint: correct field path (`itemIngestionStatus`), `includeDetails=true` hardcoded
- `walmart-feed-diag` endpoint: deployed for raw response inspection
- **`walmart-price-audit` endpoint: deployed, tested, 456 prices corrected May 29**
- **Daily price audit cron: 10 AM EST — prevents below-cost orders**
- Daily sync cron: 9 staggered chunks covering full listed SKU range
- Order routing cron: running every 15 min

### 🔴 Active Issues
1. **662 Walmart listings unmatched** — archived/null-SKU products submitted to Walmart but no Shopify match. Needs CT re-sync to restore SKUs.
2. **~25 flotation size SKUs** still skipped (parser not updated): `3513/R`, `31X10.50R15` etc.
3. **Cooper Procontrol/Zeon/Cobra/Nexen OE null-SKU products** — archived but SKUs not recovered. Need CT re-sync.
4. **20 persistent TIRE- duplicate groups** — feed dedup handles, Shopify smart collection still includes archived products.
5. **Amar ticket open** — `ERR_PDI_0001` errors on feedId `18B38EBDDBE555E1BB37C616058C8F43@Ae0BBwA`

### ⏳ Next Actions
1. **Run CT shopifySync** — restore SKUs on null-SKU products (Cooper Procontrol, Zeon, Nexen OE)
2. **Re-submit item feed** after SKU recovery
3. **Verify Seller Center inventory** — confirm matched items show correct inventory
4. **Enroll items in Flash deals** — Seller Center manual action
5. **Fix flotation size parser** — `3513/R`, `31X10.50R15` formats
6. **Follow up with Amar** on `ERR_PDI_0001` errors

---

## 12. Key Technical Decisions

| Decision | Rationale |
|---|---|
| Offset-based pagination for fetchListedSkus | Walmart /v3/items uses totalItems+offset, no cursor |
| 9 staggered crons × 300 SKUs | Covers 2,700 listed SKUs within 300s timeout per chunk |
| `pricing` as array + `currentPriceType: BASE` | Global API v3.1 requirement |
| `?sku=` query param on inventory PUT | Global API lookup key requirement |
| `feedType=MP_ITEM_INTL` | Walmart Canada requirement |
| `productId: CUSTOM` | GTIN exemption requirement |
| No brand filter | Full GTIN exemption for all brands |
| Smart bare-SKU filter (not blanket TIRE- filter) | Brands like Minerva/Ovation/Maxtrek have bare SKUs only |
| Only skip bare SKU when TIRE- twin exists | Pre-pass builds `tirePrefixedBaseSkus` set; O(n) overhead |
| `crypto.randomUUID()` not uuid package | uuid v14 ESM-only crashes Vercel CJS |
| Lowest productId wins on dedup | Oldest = canonical listing |
| Tiered pricing ×2.10/×1.72/×1.58 | Replaces old WALMART_FEE formula |
| `noUnusedParameters: true` in tsconfig | Unused params must be prefixed `_` |
| `itemIngestionStatus` field path in feed-status | Walmart returns `itemDetails.itemIngestionStatus[]` |
| `walmart-feed-diag` endpoint | Dedicated diagnostic to inspect raw Walmart feed response |
| New functions block required in vercel.json | All API files must be explicitly listed; unlisted = 404 |
| GraphQL for Shopify variant price map | REST Link header pagination stops at ~2,527; GraphQL reliable |
| Price audit paginate flagged array not walmartItems | Slicing walmartItems caused 0 flagged per batch |
| 5% threshold for price correction | Tight enough to catch errors, loose enough to avoid rounding noise |
| Cron mode = unlimited limit | `x-vercel-cron: 1` header detected; corrects all flagged in one shot |
| Price audit cron at 10 AM EST | After walmart-sync (4–4:40 AM) completes; catches daily price drift |

---

## 13. PR / Commit History (gci-order-hub)

| PR / Commit | Description |
|---|---|
| PR #4–10 | Initial feed, schema fixes, ESM fix, MP_ITEM_INTL |
| PR #13 | Fix root 404, maxDuration, vercel.json |
| PR #14 | CT tracking parser bugs, Gmail env vars, cron |
| PR #15 | Flotation tire sizes + null-SKU logging |
| PR #16 | Context doc update |
| direct | Remove TIRE- prefix filter + brand allowlist |
| direct | Chunked pagination + 9 staggered crons |
| direct | fetchListedSkus offset-based pagination fix |
| direct | walmart-listed-count diagnostic endpoint |
| direct | mode=audit for SKU matching analysis |
| `9871566` | diag: dump raw Walmart feed response to inspect itemDetails shape |
| PR #17 | Merge diagnostic endpoints to main |
| `1cb0a75` | fix: add walmart-feed-diag to vercel.json functions block |
| `5beb442` | fix: skip bare (non-TIRE-) SKUs in item feed to avoid Walmart compliance hold |
| `d53d480` | fix: only skip bare SKUs when TIRE- prefixed version exists in feed |
| PR #18 | feat: walmart-price-audit endpoint |
| direct | fix: use /v3/items not /v3/ca/items in walmart-price-audit |
| direct | fix: add explicit type annotations to satisfy TS noImplicitAny |
| direct | fix: correct Shopify variant pagination — extract page_info cursor |
| direct | fix: use GraphQL for Shopify variant price map |
| direct | fix: paginate corrections on flagged array not walmartItems |
| direct | chore: remove debug lines from walmart-price-audit |
| direct | feat: add walmart-price-audit daily cron at 10am EST, auto-correct all in cron mode |

## 14. PR / Commit History (gci-brain)

| PR | Description |
|---|---|
| PR #107 | Add Duplicate SKU Audit tool |
| PR #108 | Legacy TIRE- comment in shopifySync.ts |
| PR #110 | CT-Sync Tag Backfill tool (confirmed 0 missing) |
| `509c372` | feat: add action=archive-null-sku to duplicateSkuAudit |

---

## 15. gci-brain Internal Tools (/brain)

| Tool | Route | Purpose |
|---|---|---|
| Shopify Sync | /sync | Daily product sync from Canada Tire |
| Update SEO | /update-seo | SEO updates |
| Fix Redirects | /fix-redirects | URL redirects |
| Collection SEO | /collection-seo | Collection meta |
| Shopify Fix | /fix | General fixes |
| Fix Titles | /fix-titles | Bulk title fixes |
| Fix Descriptions | /fix-descriptions | Bulk descriptions |
| Fix Alt Tags | /fix-alt-tags | Image alt tags |
| Fix French Content | /fix-french | French localisation |
| Fix Theme Content | /fix-theme | Theme content |
| Translate Content | /translate | Translation |
| Reviews Moderation | /reviews | Review management |
| Duplicate SKU Audit | /duplicate-sku-audit | Find + clear duplicate SKUs |
| CT-Sync Tag Backfill | /tag-backfill-ct-sync | Add ct-sync to products missing it |

### Duplicate SKU Audit Actions
- `action=scan` — find duplicates (supports `ctSyncOnly=true`)
- `action=fix` — clear SKU on higher-productId variants
- `action=archive-duplicate` — archive higher-productId products
- `action=archive-null-sku` — archive products where all variants have null/empty SKU

---

## 16. Known Issues / Tech Debt

| Issue | Detail | Priority |
|---|---|---|
| 662 unmatched Walmart listings | Archived/null-SKU products with no Shopify match; needs CT re-sync | HIGH |
| Cooper/Nexen null-SKU recovery | 38 archived products need CT re-sync to restore SKUs | HIGH |
| Amar ticket — ERR_PDI_0001 | feedId `18B38EBDDBE555E1BB37C616058C8F43@Ae0BBwA`; Walmart system error | MEDIUM |
| Flotation size parser | `3513/R`, `31X10.50R15` not parsed (~25 SKUs) | MEDIUM |
| 20 persistent TIRE- dupes | Smart collection includes archived products | LOW |
| Bridgestone WS90 wrong vendor | TIRE-BBK90 vendor = "GCI Tires"; also fails tire size parse | LOW |
| Vredestein dual-prefix SKUs | Some Vredestein variants have both bare + TIRE- SKUs in Shopify | LOW |
| Legacy TIRE- secondary-index | shopifySync.ts ~line 301 | LOW |

---

## 17. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar (Amarjeet Singh) | Walmart MP Support | Via Walmart Seller Center ticket |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |
| Jason Harrisson | Customer (cancelled order May 29) | Via Walmart messaging |

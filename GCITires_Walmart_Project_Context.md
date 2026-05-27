# GCI Tires — Walmart Canada Integration
## Project Context Document
**Last updated:** May 27, 2026 (Session 10)
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

**Status:** 2,724 items Published on Walmart Canada. Latest feed submitted 2,474 items.

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
| `/api/walmart-order-sync` | GET/cron | Poll Walmart orders, acknowledge, route to CT |
| `/api/getPendingOrders` | GET | Fetch pending Walmart orders |
| `/api/ct-tracking-parser` | GET/cron | Parse CT tracking PDFs from Gmail |
| `/api/walmart-listed-count` | GET | Diagnostic: count published SKUs by status |
| `/api/order-router` | POST | Shopify webhook — routes paid orders |
| `/api/authorize-order` | GET | HMAC-signed payment link generator |

**Crons (vercel.json):**
- `walmart-sync` offset=0..2400, limit=300: 9 staggered jobs, 4:00–4:40 AM EST daily
- `walmart-order-sync`: every 15 min
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

**Current state:** ~235 Shopify variants matched 2,724 Walmart listings before May 27 session.
Gap explained: Most 2,724 listings came from feed submissions; many corresponding
Shopify products had null/cleared SKUs from duplicate audit tool.

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
- `PUBLISHED+ACTIVE` filter confirms 2,724 items available
- `includeDetails=true` on feed status returns `itemDetails.itemIngestionStatus[]` (not `ItemDetails`)
- Feed status may stay `INPROGRESS` indefinitely if 1 item gets stuck — normal Walmart behavior

---

## 7. Shopify Data Structure

### Products
- Tag filter: `ct-sync` (auto-applied by shopifySync.ts)
- All 2,070 active tire products have `ct-sync`
- Fields fetched: `id, title, vendor, tags, images, variants`
- No SKU prefix filter — all variants eligible

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
- **Status at doc update:** INPROGRESS (just submitted, awaiting Walmart ingestion)
- Skip reasons: null SKUs (~80), bare SKUs with TIRE- twin (~350), duplicates (~150), parse errors (~3)

### Previous Feed Run (May 27, 2026 — earlier in session)
- **feedId:** `18B38E35BCA75096B327A138E3E7355B@Ae0BBwA`
- Submitted: 876 (TIRE- filter too aggressive — fixed)

### Feed Run Before Session (May 27, 2026 — start of session)
- **feedId:** `18B388DAA74859C2B5C032F890894F20@Ae0BBwA`
- Submitted: 2,858 | Failed: 2,108 | Succeeded: 750
- Failure cause: bare SKUs in Walmart compliance review hold (48hr) — resolved by smart TIRE- filter

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

### No Brand Filter
- No brand filter (all brands GTIN-exempt)
- Dedup: lowest productId wins

---

## 9. Order Routing (api/walmart-order-sync.ts)

### Status: Built and running (PR #13, #14)
Polls every 15 min. When Walmart orders arrive:
1. Acknowledge on Walmart (within 4hr requirement)
2. Match SKU → Canada Tire part number
3. Generate CT PO
4. Log to Google Sheets
5. Send Telegram + Gmail notification to Patrick

### CT Tracking Parser (api/ct-tracking-parser.ts)
- Parses CT tracking PDFs from Gmail
- Extracts tracking numbers
- Marks orders shipped on Walmart via `POST /v3/orders/{id}/shipping`
- Runs on cron schedule

### No Orders Yet
`walmart-order-sync` is live and returning 200 but no actual Walmart orders
have been received yet to test end-to-end flow.

---

## 10. Current Status

### ✅ Working
- 2,724 items Published on Walmart Canada
- Latest feed: 2,474 items submitted (feedId `18B38EBDDBE555E1BB37C616058C8F43@Ae0BBwA`)
- Smart bare-SKU filter: only skips bare SKUs when TIRE- twin exists
- 117 null-SKU products archived (38 newly archived May 27, 79 already done)
- `walmart-feed-status` endpoint: correct field path (`itemIngestionStatus`), `includeDetails=true` hardcoded
- `walmart-feed-diag` endpoint: deployed for raw response inspection
- Daily cron: 9 staggered chunks covering full listed SKU range
- Order routing cron: running every 15 min
- CT tracking parser: deployed

### 🔴 Active Issues
1. **SKU match gap** — 2,724 Walmart listings but only ~235 matched Shopify SKUs for price/inventory sync.
   Root cause: null-SKU products now archived; next full CT sync should restore SKUs and close gap.
2. **~25 flotation size SKUs** still skipped (parser not updated): `3513/R`, `31X10.50R15` etc.
3. **Cooper Procontrol/Zeon/Cobra/Nexen OE null-SKU products** — archived but SKUs not yet recovered.
   Need CT re-sync to restore proper SKUs so they can be re-submitted to Walmart.
4. **20 persistent TIRE- duplicate groups** — feed dedup handles, Shopify smart collection still includes archived products

### ⏳ Next Actions
1. **Poll feed status** for `18B38EBDDBE555E1BB37C616058C8F43@Ae0BBwA` — check success/failure counts
2. **Verify Seller Center inventory** — confirm matched items show correct inventory
3. **Run CT shopifySync** — restore SKUs on null-SKU products (Cooper Procontrol, Zeon, Nexen OE)
4. **Re-submit item feed** after SKU recovery to pick up restored products
5. **Enroll items in Flash deals** — Seller Center manual action
6. **Test order routing** — wait for first Walmart order or use test order
7. **Fix flotation size parser** — `3513/R`, `31X10.50R15` formats

---

## 11. Key Technical Decisions

| Decision | Rationale |
|---|---|
| Offset-based pagination for fetchListedSkus | Walmart /v3/items uses totalItems+offset, no cursor |
| 9 staggered crons × 300 SKUs | Covers 2,700 listed SKUs within 300s timeout per chunk |
| `pricing` as array + `currentPriceType: BASE` | Global API v3.1 requirement |
| `?sku=` query param on inventory PUT | Global API lookup key requirement |
| `feedType=MP_ITEM_INTL` | Walmart Canada requirement |
| `productId: CUSTOM` | GTIN exemption requirement |
| No brand filter | Full GTIN exemption for all brands |
| Smart bare-SKU filter (not blanket TIRE- filter) | Brands like Minerva/Ovation/Maxtrek have bare SKUs only; blanket TIRE- filter dropped 1,598 valid items |
| Only skip bare SKU when TIRE- twin exists | Pre-pass builds `tirePrefixedBaseSkus` set; O(n) overhead, runs once per feed call |
| `crypto.randomUUID()` not uuid package | uuid v14 ESM-only crashes Vercel CJS |
| Lowest productId wins on dedup | Oldest = canonical listing |
| Tiered pricing ×2.10/×1.72/×1.58 | Replaces old WALMART_FEE formula |
| `noUnusedParameters: true` in tsconfig | Unused params must be prefixed `_` |
| `itemIngestionStatus` field path in feed-status | Walmart returns `itemDetails.itemIngestionStatus[]`, not `itemDetails.ItemDetails[]` |
| `walmart-feed-diag` endpoint | Dedicated diagnostic to inspect raw Walmart feed response structure without touching production flow |
| New functions block required in vercel.json | All API files must be explicitly listed; unlisted files return 404 even if deployed |

---

## 12. PR / Commit History (gci-order-hub)

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
| `6449772` | fix: cast feedId as string to satisfy TS2322 in FeedStatusResponse |
| `3e711cc` | diag: return raw Walmart feed response to inspect itemDetails shape |
| PR #17 | Merge diagnostic endpoints to main |
| `1cb0a75` | fix: add walmart-feed-diag to vercel.json functions block |
| `5beb442` | fix: skip bare (non-TIRE-) SKUs in item feed to avoid Walmart compliance hold |
| `d53d480` | fix: only skip bare SKUs when a TIRE- prefixed version exists in feed |
| `90999df` | fix: use itemIngestionStatus key for per-item errors, remove diag early return |

## 13. PR / Commit History (gci-brain)

| PR | Description |
|---|---|
| PR #107 | Add Duplicate SKU Audit tool |
| PR #108 | Legacy TIRE- comment in shopifySync.ts |
| PR #110 | CT-Sync Tag Backfill tool (confirmed 0 missing) |
| `509c372` | feat: add action=archive-null-sku to duplicateSkuAudit |

---

## 14. gci-brain Internal Tools (/brain)

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
  - Supports `dry=true`, `offset`, `chunkSize`
  - Returns `{ dryRun, totalNullSkuProducts, fixed, skipped, errors, changes, offset, chunkSize, nextOffset }`

---

## 15. Known Issues / Tech Debt

| Issue | Detail | Priority |
|---|---|---|
| SKU match gap for walmart-sync | ~2,489 Walmart listings still have no Shopify SKU match; requires CT re-sync to restore SKUs | HIGH |
| Cooper/Nexen null-SKU recovery | 38 archived products need CT re-sync to restore SKUs before re-submission | HIGH |
| Flotation size parser | `3513/R`, `31X10.50R15` not parsed (~25 SKUs) | MEDIUM |
| 20 persistent TIRE- dupes | Smart collection includes archived products | LOW |
| Bridgestone WS90 wrong vendor | TIRE-BBK90 vendor = "GCI Tires"; also fails tire size parse | LOW |
| Vredestein dual-prefix SKUs | Some Vredestein variants have both bare + TIRE- SKUs in Shopify | LOW |
| Legacy TIRE- secondary-index | shopifySync.ts ~line 301 | LOW |

---

## 16. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar (Amarjeet Singh) | Walmart MP Support | Via Walmart Seller Center ticket |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |

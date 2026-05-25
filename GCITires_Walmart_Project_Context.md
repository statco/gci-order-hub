# GCI Tires — Walmart Canada Integration
## Project Context Document
**Last updated:** May 25, 2026
**Prepared by:** Claude (Anthropic) for Patrick B. Pierre, GCI Inc.

---

## 1. Business Context

**Company:** Groupe de Commerce Intercontinental Inc. (GCI Inc.)
**Division:** GCI Tires — gcitires.com
**Walmart Seller ID:** 10002930522
**Walmart Store Name:** GC Tires
**Walmart Support Contact:** Amar (Walmart MP Support Team)

**Goal:** Full catalogue of ~2,800 tires live on Walmart Canada with automated daily price/inventory sync and automated order routing to Canada Tire.

**Key deal terms (Amar, May 2026):**
- 75% discount on referral fees until Jan 31, 2027 → **effective fee: 2.5%** (standard: 10%)
- Full catalogue upload approved — all brands
- Do NOT reduce prices — improved margin only
- Enroll items for Flash deals (Seller Center action)

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
| `APP_BASE_URL` | Base URL for authorize links (auto-detected from `VERCEL_URL` in prod) |
| `TELEGRAM_BOT_TOKEN` | Notification bot |
| `TELEGRAM_CHAT_ID` | Notification target |
| `RESEND_API_KEY` | Email fallback via Resend |
| `NOTIFY_EMAIL_TO` | Email alert recipient |
| `NOTIFY_EMAIL_FROM` | Verified Resend sender identity |
| `WALMART_ORDER_LOG_SHEET_ID` | Google Sheets ID for Walmart order log |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Stringified service account JSON for Sheets API |
| `CJ_API_KEY` | CJ Dropshipping (inactive — Nuproz discontinued) |

---

## 4. API Endpoints (gci-order-hub.vercel.app)

| Endpoint | Method | Purpose | maxDuration |
|---|---|---|---|
| `/api/walmart-sync` | GET/POST | Push price+inventory for published SKUs | 300s |
| `/api/walmart-order-sync` | GET/POST | Poll Walmart for new orders, acknowledge, log to Sheet, Telegram alert | 300s |
| `/api/walmart-item-feed` | GET/POST | Submit bulk MP_ITEM_INTL feed | 300s |
| `/api/walmart-feed-status` | GET | Poll feed status by feedId | 10s |
| `/api/walmart-ship` | POST | Mark order shipped on Walmart, update Sheet, send Telegram | 60s |
| `/api/order-router` | POST | Shopify webhook — routes paid orders | 30s |
| `/api/authorize-order` | GET | HMAC-signed payment link generator | 30s |
| `/api/getPendingOrders` | GET | Fetch PENDING_CT orders from Google Sheet | 30s |
| `/api/ct-tracking-parser` | POST | Parse Canada Tire shipping PDF for tracking info | 60s |

**Crons:**
- `walmart-sync`: daily 4 AM EST (`0 9 * * *` UTC) in `mode=listed`
- `walmart-order-sync`: every 15 min (`*/15 * * * *`)

---

## 5. Walmart Sync Flow (api/walmart-sync.ts)

```
GET /api/walmart-sync?mode=listed
  1. Fetch all Shopify ct-sync variants (no SKU prefix filter)
  2. Fetch PUBLISHED+ACTIVE Walmart SKUs via GET /v3/items
  3. Filter to matched SKUs only
  4. Safety-zero inventory for qty < 4
  5. PUT /v3/price + PUT /v3/inventory?sku=xxx per item
```

**Status:** ✅ Fully working — 23/23 success on last run (35s).

### Correct API Payload Formats

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
{
  "sku": "TIRE-xxx",
  "quantity": { "unit": "EACH", "amount": 12 }
}
```

---

## 6. Walmart API Configuration (api/lib/walmart-client.ts)

### Token Request
- `POST /v3/token` with `Authorization: Basic Base64(clientId:clientSecret)`
- Cached 900s via `getWalmartToken()`

### Required Headers
```
WM_SEC.ACCESS_TOKEN: <token>
WM_GLOBAL_VERSION: 3.1
WM_MARKET: ca
WM_SVC.NAME: Walmart Marketplace
WM_QOS.CORRELATION_ID: <crypto.randomUUID()>
Accept: application/json
Content-Type: application/json
```

### Key Functions
- `getWalmartToken()` — cached token
- `bulkPriceFeed(items)` → `{ success, failed }`
- `bulkInventoryFeed(items)` → `{ success, failed }`
- `fetchListedSkus()` — paginates `GET /v3/items?publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`

---

## 7. Shopify Data Structure

### Products
- Tag filter: `ct-sync` (applied automatically by `shopifySync.ts` to all new products)
- All 2,070 active tire products already have `ct-sync` tag
- Fields fetched: `id, title, vendor, tags, images, variants`
- No SKU prefix filter — all variants eligible regardless of prefix

### SKU Formats
- Legacy: `TIRE-XXXXXX` (prefixed by historical `fixSkus.ts` run)
- New: bare part number e.g. `160110025`, `AP24555019HHTRA00`, `18733NXK`
- Daily sync never re-writes SKUs

### Title Format
- Pattern: `{Brand} {Model} {Size}` e.g. `Vredestein Quatrac 215/55R17`
- `vendor` field = brand

### Pricing Model
**Tiered formula** (in `gci-brain/api/shopifySync.ts`):
```typescript
function calculatePrice(cost: number): number {
  let raw: number;
  if (cost < 100)       raw = Math.max(cost * 2.10, 150);
  else if (cost <= 250) raw = cost * 1.72;
  else                  raw = cost * 1.58;
  const rounded = Math.round(raw);
  return (rounded - 0.01) >= raw * 0.98
    ? parseFloat((rounded - 0.01).toFixed(2))
    : parseFloat(raw.toFixed(2));
}
```
Shopify prices are read directly by the Walmart feed — no separate Walmart pricing calculation.

**Old formula** (bulkPriceUpdate.ts — no longer used for new products):
- `WALMART_FEE = 0.025` (2.5%), `TARGET_MARGIN = 0.14`, `MARKUP = 1.08`

### Season/Vehicle Type (from Shopify tags)
| Tag | Walmart value |
|---|---|
| `winter` | `WINTER` |
| `all-weather` | `ALL_WEATHER` |
| `summer` | `SUMMER` |
| `all-terrain` | `ALL_TERRAIN` |
| `all-season` / default | `ALL_SEASON` |
| `LT` prefix or `light-truck` tag | `LIGHT_TRUCK` |
| `suv`/`crossover` tag | `SUV_CROSSOVER` |
| default | `PASSENGER_CAR` |

---

## 8. Item Feed Implementation (api/walmart-item-feed.ts)

### Feed Spec — MP_ITEM_INTL v3.16
```
feedType: MP_ITEM_INTL
Header: version 3.16, processMode REPLACE, subset EXTERNAL,
        sellingChannel marketplace, mart WALMART_CA
productIdentifiers: { productIdType: "GTIN", productId: "CUSTOM" }
Item structure: Orderable + Visible.Tires
```

### Current Feed Stats (last run May 25, 2026)
- **Submitted:** 2,812
- **Skipped:** 274 (flotation sizes + nulls + duplicates)
- **Succeeded:** 848+ (still processing)
- **Failed:** 1,962 — Amar monitoring, will resolve compliance issues

### No Brand Filter
All brands are now eligible (GTIN exemption covers full account).
Previously restricted to Cooper/Nexen/Vredestein — removed May 25.

### No SKU Prefix Filter
`TIRE-` prefix check removed May 25 — all variant SKUs eligible.

### Deduplication
- `Map<sku, productId>` — lowest productId wins (oldest/canonical)
- Some null SKUs exist in catalogue — logged but skipped gracefully

### Brand → Country of Origin
| Brand | Country |
|---|---|
| Vredestein | NL |
| Nexen | KR |
| Cooper | US |
| default | CN |

### Tire Size Parser
- Standard: `/\b(LT|P)?(\d{3})\/(\d{2,3})R(\d{2})\b/i`
- **Not yet handled:** flotation (`3513/R`, `3313/R`), `31X10.50R15`, `310/r` lowercase
- ~40+ SKUs currently skipped due to unparseable sizes

---

## 9. Current Status

### ✅ Fully Working
- Global API auth ✅
- Price sync (array format + `currentPriceType: BASE`) ✅
- Inventory sync (`?sku=` query param) ✅
- `mode=listed` filter (PUBLISHED+ACTIVE only) ✅
- Daily 4 AM cron ✅
- Full catalogue feed (2,812 SKUs submitted) ✅
- GTIN exemption: all brands approved ✅
- Root URL status page (gci-order-hub.vercel.app) ✅
- Walmart order sync cron (every 15 min) ✅
- Order acknowledgement + Google Sheets logging ✅
- Walmart ship endpoint ✅
- CT tracking PDF parser ✅
- getPendingOrders endpoint ✅

### 🔴 Active Issues
1. **1,962 feed items failing** — Amar monitoring and resolving compliance flags
2. **~40 SKUs skipped** — flotation/non-standard tire sizes not parseable
3. **20 persistent duplicate TIRE- SKUs** — Cooper Endeavor/Procontrol pairs, archived in Shopify but still in ct-sync smart collection. Feed dedup handles correctly.

### ⏳ Next Steps
1. **Await Amar** — compliance resolution on 1,962 failed items
2. **Enroll items in Flash deals** — Seller Center action (manual)
3. **Fix flotation tire parser** — add regex for `3513/R`, `31X10.50R15` formats
4. **Fix null SKU logging** — show product title in skipped log when SKU is null
5. **Fix Shopify smart collection** — exclude archived products from ct-sync

---

## 10. Walmart Order Routing (gci-order-hub)

### Status: ✅ Fully built and deployed

All order routing infrastructure is live. The full flow runs automatically:

```
Vercel cron (every 15 min) → GET /api/walmart-order-sync
        ↓
GET /v3/orders?status=Created (Walmart CA, last 24h)
        ↓
For each new order (deduped against Google Sheet):
  ├── Acknowledge on Walmart (required within 4hrs) ✅
  ├── Append row to Google Sheet (status: PENDING_CT) ✅
  └── Send Telegram alert with order details ✅
```

```
When CT ships:
POST /api/walmart-ship { orderId, trackingNumber, carrier }
  ├── Fetch order lines from Walmart
  ├── POST /v3/orders/{id}/shipping (mark shipped) ✅
  ├── Update Google Sheet row (status: SHIPPED) ✅
  └── Send Telegram confirmation ✅
```

```
POST /api/ct-tracking-parser
  └── Parse Canada Tire shipping PDF → extract tracking + carrier ✅
```

### Google Sheet Schema (tab: `GCI Tires — Walmart Order Log`)
| Col | Field | Notes |
|---|---|---|
| A | order_id | Walmart purchaseOrderId |
| B | created_at | ISO timestamp |
| C | sku | Line item SKU |
| D | qty | Quantity |
| E | customer_name | From shipping address |
| F | customer_address | Full formatted address |
| G | price | Line price CAD |
| H | status | `PENDING_CT` → `SHIPPED` |
| I | tracking_number | Filled on ship |
| J | carrier | Normalized carrier code |
| K | shipped_at | ISO timestamp |
| L | walmart_ack | `TRUE`/`FALSE` |
| M | notes | |
| N | po_number | `GCI####` auto-generated |

### Carrier Normalization
| Input | Walmart code |
|---|---|
| purolator | `PUROLATOR` |
| ups | `UPS` |
| fedex | `FEDEX` |
| canada post / canadapost | `CANADA_POST` |
| dhl | `DHL` |
| gls / *gls | `OTHER` |

---

## 11. Key Technical Decisions

| Decision | Rationale |
|---|---|
| `mode=listed` sync | Only push to PUBLISHED SKUs — prevents 404s |
| `pricing` array + `currentPriceType: BASE` | Global API v3.1 requirement |
| `?sku=` query param on inventory PUT | Global API lookup key |
| `fetchListedSkus` → PUBLISHED+ACTIVE only | Errored items 404 on inventory PUT |
| `feedType=MP_ITEM_INTL` | Walmart Canada requirement |
| `productId: CUSTOM` | GTIN exemption requirement |
| No TIRE- prefix filter | Nuproz discontinued, all SKUs are tires |
| No brand allowlist | Full GTIN exemption approved by Amar |
| `crypto.randomUUID()` | `uuid` v14 ESM-only, crashes Vercel CJS |
| Lowest productId wins on dedup | Oldest = canonical listing |
| Tiered pricing (×2.10/×1.72/×1.58) | Replaces old WALMART_FEE formula |
| Safety-zero qty < 4 | Avoid overselling |
| `export const config = { maxDuration }` | Correct Vercel export syntax — bare `export const maxDuration` is silently ignored |
| `.js` extensions on all local imports | ESM convention required by `@vercel/node` |

---

## 12. PR / Commit History (gci-order-hub)

| Commit / PR | Description |
|---|---|
| PR #4 | Add walmart-item-feed, walmart-feed-status, tire-parser |
| PR #5 | Fix timeout: drop body_html, raise maxDuration |
| PR #7 | Fix productId: GTIN_EXEMPT → CUSTOM |
| PR #9 | Switch to MP_ITEM_INTL schema v3.16 |
| PR #10 | Fix ESM: uuid → crypto.randomUUID() |
| PR #13 | Fix root 404 (add index.html); fix `maxDuration` export syntax in walmart-order-sync + getPendingOrders; add missing .js import extensions; add walmart-order-sync, getPendingOrders, ct-tracking-parser to vercel.json functions; add WALMART_ORDER_LOG_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON to .env.local.example |
| direct | Dedup by lowest productId |
| direct | Brand allowlist (later removed) |
| direct | 300s timeout + remove 50ms delays |
| direct | mode=listed + fetchListedSkus |
| direct | Price: array + currentPriceType=BASE |
| direct | Inventory: ?sku= query param |
| direct | fetchListedSkus → PUBLISHED+ACTIVE |
| direct | Remove TIRE- prefix filter |
| direct | Remove brand allowlist |
| direct | getPendingOrders + CT tracking parser + PO# + Sheets |

## 13. PR / Commit History (gci-brain)

| PR | Description |
|---|---|
| PR #107 | Add Duplicate SKU Audit tool |
| PR #108 | Legacy TIRE- comment in shopifySync.ts |
| PR #110 | Add CT-Sync Tag Backfill tool (scan confirmed 0 missing) |

---

## 14. gci-brain Internal Tools (/brain)

| Tool | Route | Purpose |
|---|---|---|
| Shopify Sync | /sync | Daily product sync from Canada Tire |
| Update SEO | /update-seo | SEO field updates |
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

---

## 15. Known Issues / Tech Debt

| Issue | Detail | Fix |
|---|---|---|
| Flotation size parser | `3513/R`, `3313/R`, `31X10.50R15`, `310/r` not parsed | Update tire-parser.ts regex |
| Null SKU logging | Variants with null SKU show `sku: null` in skippedItems | Log product title instead |
| 20 persistent TIRE- dupes | Cooper Endeavor/Procontrol pairs in ct-sync smart collection despite archived status | Fix smart collection rule to exclude archived |
| Legacy TIRE- secondary-index | shopifySync.ts ~line 301 | Remove once TIRE- products retired |
| Bridgestone WS90 wrong vendor | TIRE-BBK90 has vendor "GCI Tires" | Change to "Bridgestone" in Shopify |

---

## 16. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar | Walmart MP Support | Via Walmart Seller Center ticket |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |

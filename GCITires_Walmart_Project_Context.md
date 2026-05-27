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

| Variable | Used in | Notes |
|---|---|---|
| `WALMART_CLIENT_ID` | walmart-client.ts | Canada marketplace client ID |
| `WALMART_CLIENT_SECRET` | walmart-client.ts | Canada marketplace secret |
| `WALMART_BASE_URL` | walmart-client.ts + others | `https://marketplace.walmartapis.com` |
| `WALMART_MARKET` | all Walmart calls | `ca` (lowercase — required) |
| `SHOPIFY_STORE_DOMAIN` | walmart-sync, walmart-item-feed | `gcitires.myshopify.com` |
| `SHOPIFY_ADMIN_API_TOKEN` | walmart-sync, walmart-item-feed | Shopify admin token (`shpat_...`) |
| `SHOPIFY_WEBHOOK_SECRET` | order-router | Webhook verification |
| `ORDER_ROUTER_SECRET` | order-router, authorize-order | HMAC auth |
| `APP_BASE_URL` | order-router | Base URL for HMAC links |
| `TELEGRAM_BOT_TOKEN` | notify, walmart-order-sync, walmart-ship, ct-tracking-parser | |
| `TELEGRAM_CHAT_ID` | notify, walmart-order-sync, walmart-ship, ct-tracking-parser | |
| `RESEND_API_KEY` | notify | Email fallback |
| `NOTIFY_EMAIL_TO` | notify | |
| `NOTIFY_EMAIL_FROM` | notify | |
| `CJ_API_KEY` | cj-client | Discontinued — no active code paths use it |
| `WALMART_ORDER_LOG_SHEET_ID` | walmart-order-sync, walmart-ship, getPendingOrders, ct-tracking-parser | Google Sheet ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | sheets-client, getPendingOrders | Full service account JSON stringified |
| `GMAIL_CLIENT_ID` | ct-tracking-parser | Gmail OAuth — confirm set in Vercel |
| `GMAIL_CLIENT_SECRET` | ct-tracking-parser | Gmail OAuth — confirm set in Vercel |
| `GMAIL_REFRESH_TOKEN` | ct-tracking-parser | Gmail OAuth — confirm set in Vercel |
| `VERCEL_URL` | order-router, ct-tracking-parser | Auto-injected by Vercel |

---

## 4. API Endpoints (gci-order-hub.vercel.app)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/walmart-sync` | GET | Push price+inventory for published SKUs |
| `/api/walmart-item-feed` | GET/POST | Submit bulk MP_ITEM_INTL feed |
| `/api/walmart-feed-status` | GET | Poll feed status by feedId |
| `/api/walmart-order-sync` | GET (cron) | Poll Walmart orders, acknowledge, log to Sheet |
| `/api/walmart-ship` | POST | Mark order shipped on Walmart, update Sheet |
| `/api/order-router` | POST | Shopify webhook — routes paid orders |
| `/api/authorize-order` | GET | HMAC-signed payment link generator |
| `/api/getPendingOrders` | GET | Fetch PENDING_CT orders from Sheet |
| `/api/ct-tracking-parser` | GET (cron) | Poll Gmail for CT invoices, extract tracking, call walmart-ship |

**Crons (vercel.json):**
| Path | Schedule | Purpose |
|---|---|---|
| `/api/walmart-sync` | `0 9 * * *` (4 AM EST) | Daily price+inventory push |
| `/api/walmart-order-sync` | `*/15 * * * *` | Poll Walmart for new orders |
| `/api/ct-tracking-parser` | `*/30 * * * *` | Parse CT tracking emails (added PR #14) |

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

## 6. Walmart Order Routing (api/walmart-order-sync.ts)

### Status: ✅ Fully built and verified (May 25, 2026)

### Full Flow
```
Vercel cron (every 15 min) → /api/walmart-order-sync
        ↓
GET /v3/orders?status=Created (last 24h)
        ↓
Dedup vs Google Sheet (skip already-logged orders)
        ↓
For each new order:
  ├── POST /v3/orders/{id}/acknowledge (required within 4hrs)
  ├── Append rows to Google Sheet (tab: GCI Tires — Walmart Order Log)
  └── Send batched Telegram alert
        ↓
Manual: Patrick confirms CT order
        ↓
CT ships → emails invoice PDF to info@gcitires.ca
        ↓
/api/ct-tracking-parser (every 30 min)
  ├── Poll Gmail for unread emails from info@cdatire.com (subject: Invoice CS + PDF)
  ├── Extract PO# + tracking + carrier via pdf2json
  ├── Look up Walmart order ID from Sheet by PO#
  └── POST /api/walmart-ship { orderId, trackingNumber, carrier }
        ↓
/api/walmart-ship
  ├── GET /v3/orders/{id} (fetch order lines)
  ├── POST /v3/orders/{id}/shipping (mark shipped)
  ├── Update Sheet → status: SHIPPED
  └── Send Telegram confirmation
```

### Key constraint
Walmart requires order acknowledgement within 4 hours. The 15-min cron ensures this is met.

### Google Sheet structure (tab: GCI Tires — Walmart Order Log)
Columns: order_id, created_at, customer_name, customer_address, status, walmart_ack, po_number, skus[], price, qty, carrier, tracking (col L = ack result)

### Carrier normalization (walmart-ship.ts)
Supports: purolator, ups, fedex, canada post, dhl, gls → Walmart carrier codes + tracking URL per carrier.

---

## 7. Walmart API Configuration (api/lib/walmart-client.ts)

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

## 8. Shopify Data Structure

### Products
- Tag filter: `ct-sync` (applied automatically by `shopifySync.ts` to all new products)
- All active tire products have `ct-sync` tag
- Fields fetched: `id, title, vendor, tags, images, variants`
- No SKU prefix filter — all variants eligible regardless of prefix
- **Note:** 500+ archived products had `ct-sync` tag removed May 25 via bulk action — these no longer appear in the Featured Tires collection

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

## 9. Item Feed Implementation (api/walmart-item-feed.ts)

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
- **Next run:** will recover ~40 previously skipped flotation SKUs (PR #15)

### No Brand Filter
All brands eligible — GTIN exemption covers full account (approved by Amar May 2026).

### No SKU Prefix Filter
`TIRE-` prefix check removed May 25 — all variant SKUs eligible.

### Deduplication
- `Map<sku, productId>` — lowest productId wins (oldest/canonical)
- Null SKUs logged with `{ sku: null, productTitle: product.title, reason: 'Null SKU' }` (PR #15)

### Brand → Country of Origin
| Brand | Country |
|---|---|
| Vredestein | NL |
| Nexen | KR |
| Cooper | US |
| default | CN |

---

## 10. Tire Size Parser (api/lib/tire-parser.ts) — Updated PR #15

### Supported Formats (in match order)

**FORMAT 1 — Cross-section flotation** e.g. `31X10.50R15`
```
Regex: /\b(\d{2})X(\d{2}(?:\.\d+)?)R(\d{2})\b/i
width = Math.round(sectionWidthInches × 25.4)
aspectRatio = Math.round(((overallDiameter - rimDiameter) / 2 / sectionWidthInches) × 100)
prefix = 'LT' if title contains 'LT' before match
```

**FORMAT 2 — Compact flotation** e.g. `3513/R`, `3313/R`
```
Regex: /\b(\d{2})(\d{2})\/R\b/i
width = Math.round(widthInches × 25.4)
aspectRatio = 0 (not applicable, Walmart accepts 0)
prefix = 'LT' (always light truck)
```

**FORMAT 3 — Standard metric** e.g. `215/55R17`, `LT265/70R17`, `P205/65R15`, `310/r15`
```
Regex: /\b(LT|P)?(\d{3})\/(\d{2,3})R(\d{2})\b/i
/i flag handles lowercase 'r' — no separate pattern needed
```

Unknown formats log: `[tire-parser] No size pattern matched: "{title}"`

---

## 11. Shopify Featured Tires Collection (305891082288)

**Conditions** (all must match):
| Field | Operator | Value |
|---|---|---|
| Tag | is equal to | ct-sync |
| Tag | is not equal to | sold-out |
| Tag | is not equal to | Out of stock |
| Inventory stock | is greater than | 1 |

**Note:** "Product status = Active" is not available as a Shopify smart collection condition. Instead, `ct-sync` tag was bulk-removed from all 500+ archived products on May 25, 2026. The collection now contains only active products. `shopifySync.ts` will not re-add `ct-sync` to archived products.

---

## 12. Current Status

### ✅ Fully Working
- Global API auth ✅
- Price sync (array format + `currentPriceType: BASE`) ✅
- Inventory sync (`?sku=` query param) ✅
- `mode=listed` filter (PUBLISHED+ACTIVE only) ✅
- Daily 4 AM cron ✅
- Full catalogue feed (2,812 SKUs submitted) ✅
- GTIN exemption: all brands approved ✅
- Order polling cron (every 15 min) ✅
- Walmart order acknowledge ✅
- Google Sheets logging ✅
- Telegram + email notifications ✅
- `walmart-ship.ts` — mark shipped + update Sheet ✅
- `ct-tracking-parser.ts` — Gmail poll + PDF parse + auto-ship ✅ (bugs fixed PR #14)
- Flotation tire parser (31X10.50R15, 3513/R formats) ✅ (PR #15)
- Null SKU logging with product title ✅ (PR #15)
- Featured Tires collection — archived products removed ✅

### 🔴 Active Issues
1. **1,962 feed items failing** — Amar monitoring and resolving compliance flags
2. **No real Walmart tire orders received yet** — order routing untested with live data

### ⏳ Next Steps
1. **Await Amar** — compliance resolution on 1,962 failed items
2. **Refire item feed** once compliance clears — expect higher success count (~40 flotation SKUs now parseable)
3. **Enroll items in Flash deals** — manual Seller Center action
4. **Verify Gmail OAuth creds** — confirm `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` are set in Vercel gci-order-hub
5. **Fix Bridgestone WS90 vendor** — change from "GCI Tires" to "Bridgestone" on TIRE-BBK90 in Shopify

---

## 13. Key Technical Decisions

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
| Acknowledge embedded in order-sync | No separate endpoint needed; fires before Sheet log |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON stringified into single env var |
| ct-sync bulk untag (not collection rule) | Shopify smart collections don't support Product Status condition |
| ct-tracking-parser cron every 30 min | Balance between tracking freshness and Gmail API quota |

---

## 14. PR / Commit History (gci-order-hub)

| PR | Description |
|---|---|
| PR #4 | Add walmart-item-feed, walmart-feed-status, tire-parser |
| PR #5 | Fix timeout: drop body_html, raise maxDuration |
| PR #7 | Fix productId: GTIN_EXEMPT → CUSTOM |
| PR #9 | Switch to MP_ITEM_INTL schema v3.16 |
| PR #10 | Fix ESM: uuid → crypto.randomUUID() |
| PR #13 | Fix root 404, maxDuration exports, vercel.json |
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
| **PR #14** | **Fix ct-tracking-parser: .js import, config syntax, .env.local.example, add 30-min cron** |
| **PR #15** | **Add flotation tire parser (31X10.50R15, 3513/R) + null SKU productTitle logging** |

## 15. PR / Commit History (gci-brain)

| PR | Description |
|---|---|
| PR #107 | Add Duplicate SKU Audit tool |
| PR #108 | Legacy TIRE- comment in shopifySync.ts |
| PR #110 | Add CT-Sync Tag Backfill tool (scan confirmed 0 missing) |

---

## 16. gci-brain Internal Tools (/brain)

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

## 17. Known Issues / Tech Debt

| Issue | Detail | Fix |
|---|---|---|
| 1,962 feed items failing | Compliance flags — Amar monitoring | Await Amar, refire feed |
| Gmail OAuth creds unverified | GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN may not be set in Vercel | Verify in Vercel dashboard |
| Bridgestone WS90 wrong vendor | TIRE-BBK90 has vendor "GCI Tires" | Change to "Bridgestone" in Shopify |
| Legacy TIRE- secondary-index | shopifySync.ts ~line 301 | Remove once TIRE- products retired |
| Flash deal enrollment | Manual Seller Center action pending | Patrick to action in Seller Center |
| Order routing untested live | No real Walmart tire orders received yet | Will validate on first order |

---

## 18. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar | Walmart MP Support | Via Walmart Seller Center ticket |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |

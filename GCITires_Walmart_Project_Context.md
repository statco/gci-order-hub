# GCI Tires — Walmart Canada Integration
## Project Context Document
**Last updated:** May 23, 2026
**Prepared by:** Claude (Anthropic) for Patrick B. Pierre, GCI Inc.

---

## 1. Business Context

**Company:** Groupe de Commerce Intercontinental Inc. (GCI Inc.)
**Division:** GCI Tires — gcitires.com
**Walmart Seller ID:** 10002930522
**Walmart Store Name:** GC Tires
**Walmart Support Contact:** Amar (Walmart MP Support Team)

**Goal:** Automate daily price and inventory sync from Shopify (gcitires.com) to Walmart Canada Marketplace for Cooper, Nexen, and Vredestein tire SKUs. Full order routing from Walmart → Canada Tire → customer now operational.

**Focus:** Tires only (Cooper, Nexen, Vredestein). Nuproz/CJ Dropshipping discontinued. Wheels may be added eventually.

---

## 2. Technology Stack

### Repositories
| Repo | Purpose | Deployed at |
|---|---|---|
| `statco/gci-order-hub` | Walmart sync backend, order routing | gci-order-hub.vercel.app |
| `statco/gci-brain` | Shopify sync, fitment app, internal tools | gci-brain.vercel.app |

### Core Stack
- **Runtime:** Node.js / TypeScript
- **Deployment:** Vercel (Pro plan, 300s max timeout)
- **Shopify:** gcitires.myshopify.com (REST API)
- **Walmart API:** Global Marketplace API v3.1
- **Google Sheets:** Order log via service account (`googleapis`)
- **Gmail API:** CT invoice parser via OAuth2 refresh token

---

## 3. Vercel Environment Variables (gci-order-hub)

| Variable | Value / Notes |
|---|---|
| `WALMART_CLIENT_ID` | Canada marketplace client ID |
| `WALMART_CLIENT_SECRET` | Canada marketplace secret |
| `WALMART_BASE_URL` | `https://marketplace.walmartapis.com` |
| `WALMART_MARKET` | `ca` (lowercase — required) |
| `SHOPIFY_STORE_DOMAIN` | `gcitires.myshopify.com` |
| `SHOPIFY_ADMIN_API_TOKEN` | Shopify admin API token (`shpat_...`) |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook verification secret |
| `ORDER_ROUTER_SECRET` | HMAC auth for order routing |
| `TELEGRAM_BOT_TOKEN` | Notification bot |
| `TELEGRAM_CHAT_ID` | Notification target |
| `WALMART_ORDER_LOG_SHEET_ID` | `1ntLns7Cd7l6hE3xLIZBUsLaaYVfPwgXBk2Rzx-llmYk` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key for `gci-order-hub@gen-lang-client-0471491181.iam.gserviceaccount.com` |
| `GMAIL_CLIENT_ID` | OAuth2 client ID for Gmail parser |
| `GMAIL_CLIENT_SECRET` | OAuth2 client secret for Gmail parser |
| `GMAIL_REFRESH_TOKEN` | Long-lived refresh token (info@gcitires.ca) |

---

## 4. API Endpoints (gci-order-hub.vercel.app)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/walmart-sync` | GET | Push price+inventory to Walmart for published SKUs |
| `/api/walmart-item-feed` | GET/POST | Build + submit bulk MP_ITEM_INTL feed to Walmart |
| `/api/walmart-feed-status` | GET | Poll async feed status by feedId |
| `/api/walmart-order-sync` | GET | Poll Walmart for new orders, acknowledge, log, notify |
| `/api/walmart-ship` | GET/POST | Mark order shipped on Walmart, update Sheet |
| `/api/ct-tracking-parser` | GET | Parse CT invoice PDF from Gmail, auto-ship |
| `/api/getPendingOrders` | GET | Return PENDING_CT rows from Sheet (for Brain dashboard) |
| `/api/order-router` | POST | Shopify webhook → routes paid orders |
| `/api/authorize-order` | GET | HMAC-signed payment link generator |

### Cron Schedule (vercel.json)
| Cron | Schedule | Purpose |
|---|---|---|
| `/api/walmart-sync` | `0 9 * * *` (4 AM EST) | Daily price+inventory sync |
| `/api/walmart-order-sync` | `*/15 * * * *` | Poll new Walmart orders every 15 min |
| `/api/ct-tracking-parser` | `*/30 * * * *` | Parse CT invoice emails every 30 min |

---

## 5. Walmart Sync Flow (api/walmart-sync.ts)

```
GET /api/walmart-sync?mode=listed
  1. Fetch all Shopify TIRE- variants (ct-sync tag)
  2. Fetch Walmart published SKUs via GET /v3/items?publishedStatus=PUBLISHED
  3. Filter to only Shopify variants that match published Walmart SKUs
  4. Safety-zero inventory for qty < 4
  5. Push price (PUT /v3/price) + inventory (PUT /v3/inventory?sku=xxx)
  6. Log success/failure counts
```

**Status:** ✅ Fully working — 23/23 price + inventory on last run (35s).

### Correct API payload formats (Global API v3.1)

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

### Token Request (POST /v3/token)
- Auth: `Authorization: Basic Base64(clientId:clientSecret)`
- Body: `grant_type=client_credentials`
- Token cached 900s

### Required Headers
```
WM_SEC.ACCESS_TOKEN: <bearer_token>
WM_GLOBAL_VERSION: 3.1
WM_MARKET: ca
WM_SVC.NAME: Walmart Marketplace
WM_QOS.CORRELATION_ID: <crypto.randomUUID()>
Accept: application/json
Content-Type: application/json
```

### Key functions
- `getWalmartToken()` — cached token retrieval
- `bulkPriceFeed(items)` — price updates, returns `{ success, failed }`
- `bulkInventoryFeed(items)` — inventory updates, returns `{ success, failed }`
- `fetchListedSkus()` — paginates `GET /v3/items?publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`, returns `Set<string>`

---

## 7. Shopify Data Structure

### Products
- Tag filter: `ct-sync`
- Fields: `id, title, vendor, tags, images, variants`
- `body_html` excluded (too heavy)

### SKU format
- Tires: `TIRE-XXXXXX`
- `TIRE-` prefix applied historically by `api/fixSkus.ts` (one-time)
- Daily sync never re-writes SKUs
- **The numeric part after `TIRE-` is the actual Canada Tire part number** (e.g. `TIRE-160136025` → CT part `160136025`)

### Title format
- Pattern: `{Brand} {Model} {Size}` e.g. `Vredestein Quatrac 215/55R17`
- `vendor` field = brand

### Season/vehicle type (from Shopify tags)
| Tag | Walmart value |
|---|---|
| `winter` | `WINTER` |
| `all-weather` | `ALL_WEATHER` |
| `summer` | `SUMMER` |
| `all-terrain` | `ALL_TERRAIN` |
| `all-season` / default | `ALL_SEASON` |
| `LT` prefix or `light-truck` tag | `LIGHT_TRUCK` |
| `suv` / `crossover` tag | `SUV_CROSSOVER` |
| default | `PASSENGER_CAR` |

### Pricing Model (gci-brain/api/bulkPriceUpdate.ts)
```
WALMART_FEE = 12%, TARGET_MARGIN = 14%, MARKUP = 1.08
shippingBuffer = $40 (passenger) / $50 (LT) / $65 (heavy)
floorPrice = (netCost + shippingBuffer) / (1 - 0.26)
sellingPrice = floorPrice × 1.08 — rounded to .99
```

---

## 8. Item Feed Implementation

### Files (gci-order-hub)
| File | Purpose |
|---|---|
| `api/walmart-item-feed.ts` | Fetches Shopify, filters brands, deduplicates, builds feed, submits |
| `api/walmart-feed-status.ts` | Polls `GET /v3/feeds/{feedId}?includeDetails=true` |
| `api/lib/tire-parser.ts` | Parses tire size, season, vehicle type |

### Feed Spec — MP_ITEM_INTL v3.16
```
feedType: MP_ITEM_INTL
Header: version 3.16, processMode REPLACE, subset EXTERNAL,
        sellingChannel marketplace, mart WALMART_CA
productIdentifiers: { productIdType: "GTIN", productId: "CUSTOM" }
Item structure: Orderable + Visible.Tires
Required: sku, productIdentifiers, productName {en}, brand {en},
  price, shippingWeight, productTaxCode (2038411),
  shortDescription {en}, mainImageUrl, countryOfOriginAssembly[]
Visible.Tires: tireSize, tireWidth, tireAspectRatio, wheelDiameter,
  tireSeason, vehicleType, constructionType
```

### Brand Allowlist (GTIN Exemption)
```typescript
const GTIN_EXEMPT_BRANDS = new Set(['Cooper', 'Nexen', 'Vredestein']);
```

### Brand → Country of Origin
| Brand | Country |
|---|---|
| Vredestein | NL |
| Nexen | KR |
| Cooper | US |
| default | CN |

### Deduplication
- SKU dedup uses `Map<sku, productId>` — keeps lowest productId (oldest/canonical)
- Shopify ct-sync smart collection includes archived/draft products — dedup handles this

### Tire Size Parser
- Standard: `/\b(LT|P)?(\d{3})\/(\d{2,3})R(\d{2})\b/i`
- Flotation (`3513/R` format) — **not yet handled**, ~25 SKUs skipped

---

## 9. Walmart Order Routing (✅ BUILT May 23, 2026)

### Full automated flow
```
[Every 15 min] walmart-order-sync.ts
  → GET /v3/orders?createdStartDate=<24h ago>
  → Filter Created status in code (CA doesn't support /released endpoint)
  → Skip if order_id already in Sheet (dedup)
  → Acknowledge on Walmart (4hr requirement)
  → Auto-generate PO# (GCI0001, GCI0002...)
  → Log to Sheet (status: PENDING_CT)
  → Telegram notification (batched) with:
      - Order ID, SKU, qty, price
      - CT Part # (TIRE- prefix stripped)
      - PO# to use in CT portal
      - Customer name + address

[Patrick places CT order manually via CT portal]

[Every 30 min] ct-tracking-parser.ts
  → Search Gmail (info@gcitires.ca) for unread emails from info@cdatire.com
  → Subject filter: "Invoice CS" + has attachment
  → Download PDF attachment
  → Parse with pdf2json: extract PO#, tracking number, carrier
  → Look up PO# in Sheet → get Walmart order_id
  → Call /api/walmart-ship → mark shipped on Walmart
  → Update Sheet (status: SHIPPED)
  → Telegram confirmation
  → Mark Gmail email as read
  → Fallback: Telegram alert if parse fails
```

### CT Invoice format (Canada Tire — info@cdatire.com)
- Subject: `Canada Tire Company Inc.: Invoice CS #CSXXXXX`
- PDF attachment with: PO#, Tracking Number, Mode of Delivery, CT part number
- Primary carrier: GLS (`*GLS` in invoice) → maps to Walmart `OTHER`
- Secondary carriers: Purolator, UPS, FedEx, Canada Post, DHL

### Carrier map
| CT Invoice value | Walmart code | Tracking URL |
|---|---|---|
| `*GLS` / `gls` | `OTHER` | gls-group.com/CA/en/parcel-tracking/?match= |
| `purolator` | `PUROLATOR` | purolator.com/en/shipping/tracker?pin= |
| `ups` | `UPS` | ups.com/track?tracknum= |
| `fedex` | `FEDEX` | fedex.com/fedextrack/?trknbr= |
| `canada post` | `CANADA_POST` | canadapost-postescanada.ca/track-reperage/en#/details/ |
| `dhl` | `DHL` | dhl.com/en/express/tracking.html?AWB= |

### Google Sheet — Order Log
- **Sheet ID:** `1ntLns7Cd7l6hE3xLIZBUsLaaYVfPwgXBk2Rzx-llmYk`
- **Tab name:** `GCI Tires — Walmart Order Log` (not Sheet1)
- **Service account:** `gci-order-hub@gen-lang-client-0471491181.iam.gserviceaccount.com`
- **Columns:** order_id, created_at, sku, qty, customer_name, customer_address, price, status, tracking_number, carrier, shipped_at, walmart_ack, notes, po_number

### Sheets client functions (api/lib/sheets-client.ts)
- `getSheetOrderIds()` — returns Set of existing order IDs for dedup
- `appendSheetRows()` — append new order rows
- `updateSheetRowByOrderId()` — update status/tracking by order_id
- `getNextPoNumber()` — auto-increment GCI0001, GCI0002...
- `getOrderIdByPoNumber()` — look up Walmart order_id by PO#

### walmart-ship endpoint (api/walmart-ship.ts)
- Accepts: `orderId`, `trackingNumber`, `carrier` (GET or POST)
- Fetches order lines from Walmart
- Posts shipment to `POST /v3/orders/{orderId}/shipping`
- Updates Sheet + sends Telegram confirmation
- Default carrier: `PUROLATOR`

---

## 10. Brain Dashboard — Walmart Manual Ship

**Route:** `https://gci-brain.vercel.app/walmart-ship`
**Component:** `src/components/WalmartManualShip.tsx`
**Backend:** `gci-order-hub/api/getPendingOrders.ts`

### How it works
1. Loads all `PENDING_CT` rows from Sheet on page open
2. Displays orders with order_id, PO#, SKU, qty, customer, date
3. Click order → pre-fills form
4. Enter tracking number + select carrier
5. Submit → calls `walmart-ship` → success/error shown inline
6. List auto-refreshes after successful ship

### Use case
Fallback for when CT invoice PDF fails to parse automatically. Also useful for manual overrides.

---

## 11. Current Status

### ✅ Fully Working
- Global API auth (token via Basic auth, cached 900s)
- Price sync: `pricing` as array + `currentPriceType: "BASE"` ✅
- Inventory sync: SKU as query param `?sku=TIRE-xxx` ✅
- `mode=listed` filter: only pushes to PUBLISHED Walmart SKUs ✅
- Daily 4 AM cron: operational ✅
- GTIN exemption: approved and active ✅
- 39 tires Published on Walmart Canada with live price+inventory ✅
- Order polling (15 min cron): operational ✅
- Order acknowledgement: automatic ✅
- PO# auto-generation: operational ✅
- CT invoice PDF parsing: operational ✅
- Auto-ship on tracking receipt: operational ✅
- Manual ship Brain dashboard: operational ✅
- Google Sheet order log: operational ✅
- Telegram notifications: operational ✅

### 🔴 Active Issue — 810 Prohibited Items
- Error: "This item is prohibited because it violates one of our legal or compliance policies"
- Affects 810 of 828 submitted items
- Support case open with Amar
- Likely caused by earlier unauthorized brand submissions triggering compliance flag
- **39 Published items are unaffected and fully syncing**

### ⏳ Remaining Tasks
1. **Resolve 810 prohibited items** — await Amar's support case response
2. **Refire item feed** when compliance clears — target ~849 published
3. **Fix flotation tire parser** — recover 25 SKUs (`3513/R` format)
4. **Fix Bridgestone WS90 vendor** — change from "GCI Tires" to "Bridgestone" (TIRE-BBK90)

---

## 12. Key Technical Decisions

| Decision | Rationale |
|---|---|
| `mode=listed` sync filter | Only push to PUBLISHED SKUs — prevents 404s on errored items |
| `pricing` as array + `currentPriceType: "BASE"` | Global API v3.1 requirement |
| `?sku=` query param on inventory PUT | Global API lookup key requirement |
| `fetchListedSkus` filters PUBLISHED+ACTIVE only | Errored items return 404 on inventory PUT |
| `feedType=MP_ITEM_INTL` | Walmart Canada Global API requirement |
| `productId: "CUSTOM"` | GTIN exemption requirement |
| `maxDuration: 300` (vercel.json with `.ts` extension) | Must include `.ts` extension in key |
| `crypto.randomUUID()` not `uuid` package | `uuid` v14 is ESM-only, crashes Vercel CJS |
| Brand allowlist (Cooper/Nexen/Vredestein) | GTIN exemption scoped to these brands only |
| Safety-zero qty < 4 | Avoid overselling low-stock items |
| No 50ms delay between API calls | Removed — was causing timeouts, not needed |
| `GET /v3/orders?createdStartDate=` not `/released` | Walmart CA doesn't support `/released` endpoint (520 error) |
| `orderStatus` not `status` query param | Walmart CA API parameter name |
| Google Sheets as order dedup + log | Visible, editable, no extra DB needed |
| Service account for Sheets | Server-to-server, no OAuth flow needed |
| `pdf2json` not `pdf-parse` | `pdf-parse` requires `DOMMatrix` — crashes Vercel serverless |
| Gmail OAuth2 refresh token | Personal Gmail (info@gcitires.ca) — service accounts don't support personal Gmail |
| Tab name `GCI Tires — Walmart Order Log` not `Sheet1` | CSV import named tab after file title |
| TIRE- numeric suffix = CT part number | e.g. TIRE-160136025 → search 160136025 on CT portal |
| GLS carrier → Walmart `OTHER` | Walmart CA has no GLS carrier code |

---

## 13. PR History (gci-order-hub)

| PR / Commit | Description | Status |
|---|---|---|
| #4 | Add walmart-item-feed, walmart-feed-status, tire-parser | Merged |
| #5 | Fix timeout: drop body_html, raise maxDuration to 300s | Merged |
| #7 | Fix productId: GTIN_EXEMPT → CUSTOM | Merged |
| #9 | Switch to MP_ITEM_INTL schema v3.16 | Merged |
| #10 | Fix ERR_REQUIRE_ESM: uuid → crypto.randomUUID() | Merged |
| direct | Deduplicate SKUs (lowest productId wins) | Merged |
| direct | Add GTIN_EXEMPT_BRANDS allowlist filter | Merged |
| direct | Fix vercel.json maxDuration (300s) + remove 50ms delays | Merged |
| direct | Add mode=listed + fetchListedSkus + timing logs | Merged |
| direct | Fix price payload: array + currentPriceType=BASE | Merged |
| direct | Fix inventory: ?sku= query param | Merged |
| direct | Filter fetchListedSkus to PUBLISHED+ACTIVE only | Merged |
| direct | Add walmart-order-sync + sheets-client | Merged |
| direct | Fix /released → ?createdStartDate + filter Created in code | Merged |
| direct | Add walmart-ship + carrier map + tracking URLs | Merged |
| direct | Add ct-tracking-parser (pdf2json + Gmail OAuth) | Merged |
| direct | Add getPendingOrders endpoint (CORS open) | Merged |
| direct | Fix Sheet tab name: Sheet1 → GCI Tires — Walmart Order Log | Merged |

## 14. PR History (gci-brain)

| PR | Description | Status |
|---|---|---|
| #107 | Add Duplicate SKU Audit tool | Merged |
| #108 | Add legacy TIRE- comment to shopifySync.ts | Merged |
| direct | Add WalmartManualShip component + /walmart-ship route | Merged |

---

## 15. gci-brain Internal Tools

| Tool | Route | Purpose |
|---|---|---|
| Shopify Sync | /sync | Daily product sync |
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
| Duplicate SKU Audit | /duplicate-sku-audit | Find + clear duplicate TIRE- SKUs |
| **Walmart Manual Ship** | **/walmart-ship** | **Manual fallback for CT tracking entry** |

### Duplicate SKU Audit — backend (api/duplicateSkuAudit.ts)
- `action=scan` — groups by SKU (not title), supports `ctSyncOnly=true`
- `action=fix` — clears SKU on higher-productId duplicates
- `action=archive-duplicate` — archives higher-productId product in Shopify
- 103 duplicate SKUs cleared May 21, 2026. Daily sync never re-writes SKUs.

---

## 16. Known Shopify Data Issues

| Issue | SKUs | Fix |
|---|---|---|
| Flotation sizes (`3513/R` format) | ~25 SKUs | Fix titles OR update tire-parser.ts |
| Wrong vendor on Bridgestone WS90 | TIRE-BBK90 | Change vendor from "GCI Tires" to "Bridgestone" |
| Legacy TIRE- secondary-index block | shopifySync.ts ~line 301 | Remove once TIRE- products retired |

---

## 17. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar | Walmart MP Support | Via Walmart Seller Center ticket thread |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |

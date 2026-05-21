# GCI Tires — Walmart Canada Integration
## Project Context Document
**Last updated:** May 21, 2026
**Prepared by:** Claude (Anthropic) for Patrick B. Pierre, GCI Inc.

---

## 1. Business Context

**Company:** Groupe de Commerce Intercontinental Inc. (GCI Inc.)
**Division:** GCI Tires — gcitires.com
**Walmart Seller ID:** 10002930522
**Walmart Store Name:** GC Tires
**Walmart Support Contact:** Amar (Walmart MP Support Team)

**Goal:** Automate daily price and inventory sync from Shopify (gcitires.com) to Walmart Canada Marketplace for ~1,000 Cooper, Nexen, and Vredestein tire SKUs.

---

## 2. Technology Stack

### Repositories
| Repo | Purpose | Deployed at |
|---|---|---|
| `statco/gci-order-hub` | Walmart sync backend, order routing, CJ Dropshipping | gci-order-hub.vercel.app |
| `statco/gci-brain` | Shopify sync, fitment app, bulk price update | match.gcitires.com |

### Core Stack
- **Runtime:** Node.js / TypeScript
- **Deployment:** Vercel (serverless functions, Pro plan — 300s max timeout)
- **Shopify:** gcitires.myshopify.com (REST API)
- **Walmart API:** Global Marketplace API v3.1

---

## 3. Vercel Environment Variables (gci-order-hub)

| Variable | Value / Notes |
|---|---|
| `WALMART_CLIENT_ID` | Canada marketplace client ID (updated Mar 24) |
| `WALMART_CLIENT_SECRET` | Canada marketplace secret (updated Mar 24) |
| `WALMART_BASE_URL` | `https://marketplace.walmartapis.com` |
| `WALMART_MARKET` | `ca` (lowercase — required for Global API) |
| `SHOPIFY_STORE_DOMAIN` | `gcitires.myshopify.com` |
| `SHOPIFY_ADMIN_API_TOKEN` | Shopify admin API token (starts with `shpat_`) |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook verification secret |
| `ORDER_ROUTER_SECRET` | HMAC auth for order routing |
| `CJ_API_KEY` | CJ Dropshipping API key |
| `TELEGRAM_BOT_TOKEN` | Notification bot |
| `TELEGRAM_CHAT_ID` | Notification target |

---

## 4. API Endpoints (gci-order-hub.vercel.app)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/walmart-sync` | GET | Fetch Shopify variants, push price+inventory to Walmart |
| `/api/walmart-item-feed` | GET/POST | Build + submit bulk MP_ITEM_INTL feed to Walmart Canada |
| `/api/walmart-feed-status` | GET | Poll async feed status by feedId |
| `/api/order-router` | POST | Shopify webhook — routes paid orders to CJ or manual |
| `/api/authorize-order` | GET | HMAC-signed payment link generator |

**Cron:** Walmart sync runs daily at 4 AM EST (`0 9 * * *` UTC).

---

## 5. Walmart Sync Flow (api/walmart-sync.ts)

```
1. Fetch all Shopify products tagged 'ct-sync'
2. Extract variants where SKU starts with 'TIRE-'
3. Safety-zero inventory for variants with qty < 4
4. Build WalmartPriceItem[] and WalmartInventoryItem[]
5. Loop through each item — call PUT /v3/price and PUT /v3/inventory
6. Log success/failure counts
```

**Current status:** Auth works, token obtained, price/inventory calls reach Walmart correctly.
**Blocker:** `404.OFFER_SETUP.NOT_FOUND.100` — no tire listings exist yet on Walmart Canada.

---

## 6. Walmart API Configuration (api/lib/walmart-client.ts)

### Token Request (POST /v3/token)
- Auth: `Authorization: Basic Base64(clientId:clientSecret)`
- Body: `grant_type=client_credentials`
- Token cached for 900 seconds

### API Calls (all endpoints)
Headers required:
```
WM_SEC.ACCESS_TOKEN: <bearer_token>
WM_GLOBAL_VERSION: 3.1
WM_MARKET: ca
WM_SVC.NAME: Walmart Marketplace
WM_QOS.CORRELATION_ID: <uuid>
Accept: application/json
Content-Type: application/json
```

### Price Update (PUT /v3/price)
```json
{
  "sku": "TIRE-205-55R16",
  "pricing": {
    "currentPrice": { "currency": "CAD", "amount": 189.99 }
  }
}
```

### Inventory Update (PUT /v3/inventory)
```json
{
  "sku": "TIRE-205-55R16",
  "quantity": { "unit": "EACH", "amount": 12 }
}
```

---

## 7. Shopify Data Structure

### Products fetched from Shopify
- Tag filter: `ct-sync`
- Fields used: `id, title, vendor, tags, images, variants`
- `body_html` intentionally excluded (too heavy for 996 products, not needed for listings)

### SKU format
- Tires: `TIRE-XXXXXX` (e.g. `TIRE-160110025`)
- Nuproz: `NUPROZ-XXXXXXX` (dropship, excluded from Walmart sync)

### Title format
- Pattern: `{Brand} {Model} {Size}` — e.g. `Vredestein Quatrac 215/55R17`
- `vendor` field = brand (e.g. `Vredestein`, `Cooper`, `Nexen`)
- Tire size embedded in title, parsed by regex

### Season/vehicle type detection (from Shopify tags)
| Tag | Walmart value |
|---|---|
| `winter` | `WINTER` |
| `all-weather` | `ALL_WEATHER` |
| `summer` | `SUMMER` |
| `all-terrain` | `ALL_TERRAIN` |
| `all-season` / default | `ALL_SEASON` |
| `LT` prefix in size or `light-truck` tag | `LIGHT_TRUCK` |
| `suv` / `crossover` tag | `SUV_CROSSOVER` |
| default | `PASSENGER_CAR` |

### Pricing Model (gci-brain/api/bulkPriceUpdate.ts)
```
WALMART_FEE = 12%
TARGET_MARGIN = 14%
MARKUP = 1.08
shippingBuffer = $40 (passenger) / $50 (light truck) / $65 (heavy truck)
floorPrice = (netCost + shippingBuffer) / (1 - WALMART_FEE - TARGET_MARGIN)
sellingPrice = floorPrice × MARKUP → rounded to .99
```

---

## 8. Item Feed Implementation (api/walmart-item-feed.ts)

### Files added (PRs #4–#7)
| File | Purpose |
|---|---|
| `api/walmart-item-feed.ts` | Fetches Shopify products, builds feed, submits to Walmart |
| `api/walmart-feed-status.ts` | Polls `GET /v3/feeds/{feedId}?includeDetails=true` |
| `api/lib/tire-parser.ts` | Parses tire size, season, vehicle type from title/tags |

### Tire size parser
- Standard sizes: regex `/\b(LT|P)?(\d{3})\/(\d{2,3})R(\d{2})\b/i` covers `215/55R17`, `LT265/70R17`
- Flotation/compact sizes (`3513/R`, `3313/R`, etc.) — **not yet handled**, these 26 SKUs are currently skipped

### 26 Skipped SKUs (flotation + one missing size)
- Cooper Discoverer STT Pro, AT3 XLT, Rugged Trek, Evolution MT, Roadmaster RM300 — compact format e.g. `3513/R`
- `TIRE-BBK90` — Bridgestone Blizzak WS90 — no size in title at all (fix in Shopify)

### GTIN Exemption
- **Approved** by Walmart on May 20, 2026 (6+ hours before first feed attempt)
- Correct productIdentifier: `{ productIdType: "GTIN", productId: "CUSTOM" }`
- Products with CUSTOM productId use SKU as primary identifier in Walmart's system

### Description
- Static template (no HTML fetch): `{vendor} {model} {fullSize} tire. Available at GCI Tires Canada.`
- Example: `Vredestein Quatrac 215/55R17 tire. Available at GCI Tires Canada.`

---

## 9. Current Status & Blockers

### ✅ Done
- Global API auth working (token obtained via Basic auth)
- Correct headers confirmed and deployed
- Per-item price/inventory sync working (pending listings)
- Shopify fetch working: 984 TIRE- variants built into feed payload, 26 skipped
- `walmart-item-feed.ts` submitting feeds successfully (feedId returned)
- GTIN exemption approved; `productId: "CUSTOM"` deployed (PR #7)
- `maxDuration` raised to 300s; `body_html` removed from fetch (PR #5)

### 🔴 Active Blocker — Wrong Feed Type / Schema
- All feed submissions return `feedStatus: ERROR, itemsTotal: 0`
- Root cause: we are sending `feedType=MP_ITEM` (legacy US v3.2 format)
- **Walmart Canada Global API requires `feedType=MP_ITEM_INTL`** with v4.X schema
- Schema file needed: `CA_MP_ITEM_INTL_SPEC.json`
- Download URL: `https://developer.walmart.com/file/mp/ca/CA_MP_ITEM_INTL_SPEC.json`
- **Next action: Patrick to download and share `CA_MP_ITEM_INTL_SPEC.json`** so Claude can rewrite the feed payload to match the v4.X structure

### ⏳ Remaining Steps (in order)
1. **Get CA_MP_ITEM_INTL_SPEC.json** — download from Walmart developer portal and share
2. **Rewrite `walmart-item-feed.ts`** — switch to `feedType=MP_ITEM_INTL`, rebuild payload per v4.X schema
3. **Fix flotation tire parser** — add regex for compact sizes (`3513/R` etc.) to recover 25 skipped SKUs
4. **Fix Shopify title for TIRE-BBK90** — add size to `Bridgestone Blizzak - WS90` title
5. **Refire feed** — once schema is correct, submit and confirm `feedStatus: PROCESSED`
6. **Verify listings live** — check Walmart Seller Center that tires appear as published
7. **Daily sync will activate automatically** — `/api/walmart-sync` cron will work once listings exist
8. **Resolve CJ store API verification** — CJ live chat pending for gcitires.com

---

## 10. Key Decisions Made

| Decision | Rationale |
|---|---|
| Bulk feed (not per-item creation) | Per-item creation would timeout at 996 items; bulk feed is async |
| `maxDuration: 300` for item feed | Shopify pagination of 996 products needs >60s |
| Exclude `body_html` from Shopify fetch | Too heavy; use generated description instead |
| Static description template | `{vendor} {model} {size} tire. Available at GCI Tires Canada.` |
| Safety-zero qty < 4 | Avoid overselling low-stock items |
| `WM_MARKET: ca` (lowercase) | Global API requirement — uppercase `CA` caused 401 |
| Remove `WM_TENANT_ID` / `WM_LOCALE_ID` | Not used in Global API |
| Bearer token via `WM_SEC.ACCESS_TOKEN` | Global API requirement — not `Authorization: Bearer` |
| `productId: "CUSTOM"` | GTIN exemption requirement per Walmart docs |

---

## 11. Known Issues / Watch List

- `url.parse()` deprecation warning in logs — non-critical, cosmetic
- Nuproz products on Walmart (4 published) use separate manual listings — not managed by this sync
- 25 flotation/LT tire SKUs currently skipped due to compact size format (`3513/R`) — needs parser fix
- `TIRE-BBK90` (Bridgestone Blizzak WS90) has no size in Shopify title — needs manual fix

---

## 12. PR History (gci-order-hub)

| PR | Description | Status |
|---|---|---|
| #2 | feat: GCI brand identity in order alert email header | Merged |
| #3 | fix: replace inline SVG with hosted PNG in email header | Merged |
| #4 | Add walmart-item-feed, walmart-feed-status, tire-parser | Merged |
| #5 | Fix timeout: drop body_html, raise maxDuration to 300s | Merged |
| #6 | Rebase/cleanup of PR #4 branch | Merged |
| #7 | Fix productId: GTIN_EXEMPT → CUSTOM | Merged |

---

## 13. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar | Walmart MP Support | Via Walmart Seller Center ticket thread |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |

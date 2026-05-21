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

**Goal:** Automate daily price and inventory sync from Shopify (gcitires.com) to Walmart Canada Marketplace for Cooper, Nexen, and Vredestein tire SKUs (~849 valid listings).

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

**Current status:** Auth works, price/inventory calls reach Walmart correctly.
**Blocker:** `404.OFFER_SETUP.NOT_FOUND.100` — no tire listings exist yet on Walmart Canada.
**Will resolve automatically** once item feed listings are confirmed live.

---

## 6. Walmart API Configuration (api/lib/walmart-client.ts)

### Token Request (POST /v3/token)
- Auth: `Authorization: Basic Base64(clientId:clientSecret)`
- Body: `grant_type=client_credentials`
- Token cached for 900 seconds

### API Calls — Required Headers
```
WM_SEC.ACCESS_TOKEN: <bearer_token>
WM_GLOBAL_VERSION: 3.1
WM_MARKET: ca
WM_SVC.NAME: Walmart Marketplace
WM_QOS.CORRELATION_ID: <uuid via crypto.randomUUID()>
Accept: application/json
Content-Type: application/json
```

---

## 7. Shopify Data Structure

### Products fetched from Shopify
- Tag filter: `ct-sync`
- Fields used: `id, title, vendor, tags, images, variants`
- `body_html` intentionally excluded (too heavy, replaced by static description)

### SKU format
- Tires: `TIRE-XXXXXX` (e.g. `TIRE-160110025`)
- Nuproz: `NUPROZ-XXXXXXX` (dropship, excluded from Walmart sync)

### Title format
- Pattern: `{Brand} {Model} {Size}` — e.g. `Vredestein Quatrac 215/55R17`
- `vendor` field = brand (e.g. `Vredestein`, `Cooper`, `Nexen`)

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

## 8. Item Feed Implementation

### Files (all in `statco/gci-order-hub`)
| File | Purpose |
|---|---|
| `api/walmart-item-feed.ts` | Fetches Shopify products, filters brands, deduplicates SKUs, builds MP_ITEM_INTL feed, submits to Walmart |
| `api/walmart-feed-status.ts` | Polls `GET /v3/feeds/{feedId}?includeDetails=true` |
| `api/lib/tire-parser.ts` | Parses tire size, season, vehicle type from title/tags |

### Feed Spec — MP_ITEM_INTL v3.16
```
feedType: MP_ITEM_INTL
Header: version 3.16, processMode REPLACE, subset EXTERNAL,
        sellingChannel marketplace, mart WALMART_CA
productIdentifiers: { productIdType: "GTIN", productId: "CUSTOM" }
Item structure: Orderable + Visible.Tires
Required Orderable fields: sku, productIdentifiers, productName {en},
  brand {en}, price, shippingWeight, productTaxCode (2038411),
  shortDescription {en}, mainImageUrl, countryOfOriginAssembly[]
Visible.Tires: tireSize, tireWidth, tireAspectRatio, wheelDiameter,
  tireSeason, vehicleType, constructionType, vehicleClassDesignator
```

### Brand Allowlist (GTIN Exemption scope)
```typescript
const GTIN_EXEMPT_BRANDS = new Set(['Cooper', 'Nexen', 'Vredestein']);
```
Products with other vendors (Apollo, Michelin, Nitto, Toyo, GCI Tires, etc.)
are skipped with reason `"Brand not in GTIN exemption: {vendor}"`.

### Tire Size Parser
- Standard sizes: `/\b(LT|P)?(\d{3})\/(\d{2,3})R(\d{2})\b/i` → covers `215/55R17`, `LT265/70R17`
- Flotation/compact sizes (`3513/R`, `3313/R`, etc.) — **not yet handled**, ~25 SKUs skipped

### Known Skipped SKUs (161 total in last run)
| Reason | Count | Examples |
|---|---|---|
| Brand not in exemption | 4 | Michelin, Nitto, Toyo, GCI Tires (Bridgestone WS90 has wrong vendor) |
| Duplicate SKU in Shopify | ~132 | TIRE-166xxx, TIRE-160xxx series — same SKU on multiple products |
| Flotation size unparseable | 25 | Cooper STT Pro, AT3 XLT, Rugged Trek, Evolution MT, Nexen MTX RM7 |

### Brand → Country of Origin Mapping
| Brand | Country |
|---|---|
| Vredestein | NL |
| Nexen | KR |
| Cooper | US |
| Bridgestone | JP |
| default | CN |

---

## 9. Current Status

### ✅ Fully Working
- Global API auth (token via Basic auth, cached 900s)
- Correct headers (`WM_SEC.ACCESS_TOKEN`, `WM_GLOBAL_VERSION: 3.1`, `WM_MARKET: ca`)
- Shopify fetch (paginated, 996 products, fields optimized)
- Brand allowlist filter (Cooper, Nexen, Vredestein only)
- SKU deduplication
- Feed schema correct (MP_ITEM_INTL v3.16 per `CA_MP_ITEM_INTL_SPEC.json`)
- GTIN exemption approved and confirmed active by Amar
- 849 items submitted successfully, feed accepted by Walmart

### ⏳ Waiting — Compliance Review Queue (ETA: May 22 evening)
- All 849 SKUs show: *"This item is currently under compliance review
  from your previous submission and cannot be resubmitted until the
  review is complete, which may take up to 48 hours."*
- **Root cause:** Earlier feeds (before brand filter) submitted ~800 non-exempt
  brands (Apollo, Maxtrek, Minerva, Starfire, etc.) which triggered a
  compliance lock on all those SKUs
- **No code changes needed** — just wait for the 48h lock to expire
- **Next action:** Refire feed on May 22 ~6 PM EST

### 📋 Remaining Tasks (post-compliance clearance)
1. **Refire feed** — `GET https://gci-order-hub.vercel.app/api/walmart-item-feed`
2. **Verify listings live** — check Walmart Seller Center → Manage Items
3. **Daily sync activates** — `/api/walmart-sync` cron will work once listings exist
4. **Fix flotation tire parser** — add regex for `3513/R` format to recover 25 SKUs
5. **Fix duplicate SKUs in Shopify** — 132 variants share SKUs, invisible to Walmart
6. **Fix Bridgestone WS90 vendor** — change from "GCI Tires" to "Bridgestone" in Shopify (TIRE-BBK90)
7. **Resolve CJ store API verification** — CJ live chat pending for gcitires.com
8. **Expand GTIN exemption** — request Amar add more brands if needed (Maxtrek, Minerva, etc.)

---

## 10. Key Technical Decisions

| Decision | Rationale |
|---|---|
| Bulk feed (not per-item creation) | Per-item would timeout at 996 items; bulk is async |
| `feedType=MP_ITEM_INTL` | Walmart Canada Global API requirement (not `MP_ITEM`) |
| `productId: "CUSTOM"` | GTIN exemption requirement per Walmart docs |
| `maxDuration: 300` for item feed | Shopify pagination of 996 products needs >60s |
| Exclude `body_html` from Shopify fetch | Too heavy; static description template used instead |
| `crypto.randomUUID()` not `uuid` package | `uuid` v14 is ESM-only, crashes Vercel CJS runtime |
| `WM_MARKET: ca` (lowercase) | Global API requirement — uppercase `CA` causes 401 |
| Remove `WM_TENANT_ID` / `WM_LOCALE_ID` | Not used in Global API |
| `WM_SEC.ACCESS_TOKEN` header | Global API requirement — not `Authorization: Bearer` |
| Brand allowlist filter | GTIN exemption scoped to Cooper, Nexen, Vredestein only |
| Safety-zero qty < 4 | Avoid overselling low-stock items |

---

## 11. PR History (gci-order-hub)

| PR | Description | Status |
|---|---|---|
| #2 | feat: GCI brand identity in order alert email header | Merged |
| #3 | fix: replace inline SVG with hosted PNG in email header | Merged |
| #4 | Add walmart-item-feed, walmart-feed-status, tire-parser | Merged |
| #5 | Fix timeout: drop body_html, raise maxDuration to 300s | Merged |
| #6 | Rebase/cleanup | Merged |
| #7 | Fix productId: GTIN_EXEMPT → CUSTOM | Merged |
| #8 | Add project context doc | Merged |
| #9 | Switch to MP_ITEM_INTL schema v3.16 | Merged |
| #10 | Fix ERR_REQUIRE_ESM: uuid → crypto.randomUUID() | Merged |
| direct | Deduplicate SKUs before feed submission | Merged to main |
| direct | Add GTIN_EXEMPT_BRANDS allowlist filter | Merged to main |

---

## 12. Known Shopify Data Issues (to fix)

| Issue | SKUs affected | Fix |
|---|---|---|
| Duplicate TIRE- SKUs across multiple products | ~132 | Audit & reassign unique SKUs in Shopify |
| Wrong vendor on Bridgestone WS90 | TIRE-BBK90 | Change vendor from "GCI Tires" to "Bridgestone" |
| Missing size in title | TIRE-BBK90 | Add size to title e.g. "Bridgestone Blizzak WS90 225/55R17" |
| Flotation sizes in compact format | 25 SKUs | Fix titles OR update tire-parser.ts regex |

---

## 13. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar | Walmart MP Support | Via Walmart Seller Center ticket thread |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |

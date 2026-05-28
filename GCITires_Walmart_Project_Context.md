# GCI Tires — Walmart Canada Integration
## Project Context Document
**Last updated:** May 28, 2026 (Session 11)
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
- **Amar requirement (May 28):** Product titles MUST include season keyword: "All Season Tires", "Winter Tires", "All Weather Tires" (plural "Tires", no hyphens). Walmart shelving algorithms require this keyword for correct categorisation.

**Status:** Latest feed submitted **2,463 items** (Session 11 final run). 612 → 181 skips (-70% improvement in Session 11.

**Focus:** Tires only. Nuproz/CJ Dropshipping discontinued. Wheels may be added eventually.

---

## 2. Technology Stack

### Repositories
| Repo | Purpose | Deployed at |
|---|---|---|
| `statco/gci-order-hub` | Walmart sync, item feed, order routing | gci-order-hub.vercel.app |
| `statco/gci-brain` | Shopify sync, CT sync, internal tools | match.gcitires.com |
| `statco/gcitires-chatbot` | Customer chatbot widget | gcitires-chatbot.vercel.app |
| `statco/gci-command-center` | Internal BI/admin dashboard | gci-command-center.vercel.app |

### Core Stack
- **Runtime:** Node.js 24.x / TypeScript
- **Deployment:** Vercel Pro (300s max timeout)
- **Shopify:** gcitires.myshopify.com (REST API 2024-01)
- **Walmart API:** Global Marketplace API v3.1
- **Canada Tire:** NetSuite RESTlet OAuth 1.0 HMAC-SHA256

---

## 3. Vercel Environment Variables

### gci-order-hub
| Variable | Value / Notes |
|---|---|
| `WALMART_CLIENT_ID` | Canada marketplace client ID |
| `WALMART_CLIENT_SECRET` | Canada marketplace secret |
| `WALMART_BASE_URL` | `https://marketplace.walmartapis.com` |
| `WALMART_MARKET` | `ca` (lowercase — required) |
| `SHOPIFY_STORE_DOMAIN` | `gcitires.myshopify.com` |
| `SHOPIFY_ADMIN_API_TOKEN` | Shopify admin token (`shpat_...`) |
| `SHOPIFY_LOCATION_ID` | `74016423984` (GCI Tires HQ) |
| `ORDER_ROUTER_SECRET` | HMAC auth for order routing |
| `TELEGRAM_BOT_TOKEN` | Notification bot |
| `TELEGRAM_CHAT_ID` | Notification target |
| `GMAIL_USER` | Gmail for CT tracking notifications |
| `GMAIL_APP_PASSWORD` | Gmail app password |
| `GOOGLE_SHEETS_*` | Sheets credentials for order logging |

### gci-brain
| Variable | Value / Notes |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `gcitires.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Note: different name from gci-order-hub |
| `CT_CONSUMER_KEY` | NetSuite OAuth consumer key (64-char hex) |
| `CT_CONSUMER_SECRET` | NetSuite OAuth consumer secret (64-char hex) |
| `CT_TOKEN_ID` | NetSuite access token ID (64-char hex) |
| `CT_TOKEN_SECRET` | NetSuite access token secret (64-char hex) |
| `CT_CUSTOMER_NUMBER` | `19997` |
| `CT_CUSTOMER_API_TOKEN` | Customer API token (rotate after Session 11 exposure) |
| `CT_USE_SANDBOX` | `false` for production, `true` for sandbox (8031691_SB1) |
| `CRON_SECRET` | Vercel cron auth secret |

---

## 4. Canada Tire API (NetSuite RESTlet)

**Endpoint:** `POST https://8031691.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_item_search_rl&deploy=customdeploy_item_search_rl`

**Auth:** OAuth 1.0 / HMAC-SHA256. Key implementation details:
- `script` and `deploy` query params go in the OAuth signature base string (NOT just in the URL)
- `filters` is an **object** (not array) containing `page: N` for pagination
- `isTire` / `isWheel` are **booleans** (not strings)
- `partNumber` is an **array** (empty `[]` for all, or `["160006024"]` for specific)
- `searchKey: ""` field is required
- Response: check `data.success === false` before reading `data.data`
- Pagination: CT_PAGE_SIZE = 50; use `page` field in filters; stop when `data.length < 50`
- Size field: packed integer `2256517` → `225/65R17` (3 digits width, 2 aspect, 2 rim)
- CT contact: Nija Elsa Varghese (Junior ERP & Systems Developer)

**⚠️ Security:** CT_CUSTOMER_API_TOKEN was exposed in Session 11 chat. Must be rotated.

---

## 5. API Endpoints (gci-order-hub.vercel.app)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/walmart-sync` | GET | Push price+inventory for published SKUs |
| `/api/walmart-item-feed` | GET/POST | Submit bulk MP_ITEM_INTL feed |
| `/api/walmart-feed-status` | GET | Poll feed status by feedId (includeDetails=true) |
| `/api/walmart-feed-diag` | GET | Diagnostic: raw Walmart feed response |
| `/api/walmart-listed-count` | GET | Count published SKUs by status |
| `/api/walmart-order-sync` | GET/cron | Poll Walmart orders, acknowledge, route to CT |
| `/api/getPendingOrders` | GET | Fetch pending Walmart orders |
| `/api/ct-tracking-parser` | GET/cron | Parse CT tracking PDFs from Gmail |
| `/api/order-router` | POST | Shopify webhook — routes paid orders |
| `/api/authorize-order` | GET | HMAC-signed payment link generator |

**Crons (vercel.json):**
- `walmart-sync` offset=0..2400, limit=300: 9 staggered jobs, 4:00–4:40 AM EST daily
- `walmart-order-sync`: every 15 min
- `ct-tracking-parser`: periodic

---

## 6. Walmart Item Feed (api/walmart-item-feed.ts)

### Title Format (Amar requirement — implemented Session 11)
```typescript
function walmartTitle(baseTitle: string, season: SeasonClassification): string {
  const suffixMap = {
    ALL_SEASON:  'All Season Tires',   // ← no hyphen, plural
    ALL_WEATHER: 'All Weather Tires',  // ← no hyphen, plural
    WINTER:      'Winter Tires',
    SUMMER:      'Summer Tires',
    ALL_TERRAIN: 'All Terrain Tires',
  };
  return `${baseTitle} ${suffixMap[season]}`;
}
// productName: { en: walmartTitle(product.title, season) }
```

### Season Detection
Season detected from Shopify `ct-sync` tags via `getSeasonFromTags()` in `api/lib/tire-parser.ts`.
Priority: WINTER > ALL_WEATHER > SUMMER > ALL_TERRAIN > ALL_SEASON (fallback).

### SKU Filter Logic (d53d480)
```typescript
// Only skip bare SKU when a TIRE- prefixed version exists
const tirePrefixedBaseSkus = new Set<string>();
for (const p of allProducts) {
  for (const v of p.variants) {
    if (v.sku?.startsWith('TIRE-')) tirePrefixedBaseSkus.add(v.sku.slice(5));
  }
}
// In variant loop:
if (!variant.sku.startsWith('TIRE-') && tirePrefixedBaseSkus.has(variant.sku)) {
  skipped.push({ reason: 'Non-TIRE- SKU (TIRE- version exists)' });
  continue;
}
```

### Feed Run History (Session 11 — May 28, 2026)
| Run | feedId | Submitted | Skipped | Notes |
|---|---|---|---|---|
| Run 1 | `18B3CBFD834C563286745C408AC356A2@Ae0BBwA` | 2,474 | 612 | Before dedup |
| Run 2 | `18B3CDB3C9265366A10BD4F033AFCA80@Ae0BBgA` | 2,459 | 185 | After 106 Shopify dupes deleted |
| **Run 3 (final)** | `18B3CE7DCCAC56EBA8A92398B3B3DBDA@Ae0BBgA` | **2,463** | **181** | Final state |

### Previous Feed Run (Session 10 — May 27, 2026)
- feedId: `18B38EBDDBE555E1BB37C616058C8F43@Ae0BBwA`
- Submitted: 2,474 | Skipped: 612

---

## 7. Shopify Catalog State (as of Session 11)

### SKU Architecture
- **Canonical SKU:** bare part number e.g. `160006024` tagged `ct-sync`
- **Legacy SKU:** `TIRE-160006024` prefix — being archived via `archive-tire-skus`
- **Tag:** `ct-sync` marks all CT-sourced products
- **Status:** `active` = in stock at CT; `archived` = not in CT feed or zero stock

### Dedup Actions (Session 11)
- Ran `shopifySync?action=dedup&confirm=true&limit=50` (9 passes)
- **106 duplicate Shopify products deleted**, 0 failures
- Groups resolved: Cooper Procontrol, Nexen all models, Vredestein, Minerva

### Remaining Skip Categories (181 total)
| Category | Count | Action |
|---|---|---|
| Non-TIRE- SKU (TIRE- version exists) | ~60 | ✅ By design — correct |
| Null SKU ghost products | ~115 | Archived products; will clear on next feed cycle |
| Duplicate SKU skipped (TIRE-166xxx) | ~4 | Legacy TIRE- dupes, harmless |
| Parse failures | 2 | Fix titles below |

### 4 Title Fixes Still Needed in Shopify Admin
| SKU | Current title | Fix |
|---|---|---|
| `18787NXK` | `Nexen Roadian ATX LT 310/r` | `Nexen Roadian ATX LT 310/70R17` |
| `601001` | `Kenda Klever RT285/70R17` | `Kenda Klever RT 285/70R17` |
| `TIRE-170122034` | `Cooper Discoverer STT Pro 310/R` | `Cooper Discoverer STT Pro 310/70R17` |
| `TIRE-BBK90` | `Bridgestone Blizzak - WS90` | `Bridgestone Blizzak WS90 205/55R16` (verify size) |

---

## 8. gci-brain (match.gcitires.com)

### shopifySync.ts Actions
| Action | Purpose |
|---|---|
| `full-import` | Create/update all CT products in Shopify |
| `daily-sync` | Chunked price/inventory update (cron 03:00 ET) |
| `update-only` | Update existing products only |
| `retry-create` | Create specific SKUs by part number |
| `dedup` | Find and delete duplicate products by title |
| `archive-orphans` | Archive products not in CT feed |
| `archive-tire-skus` | Archive legacy TIRE- prefix products |
| `archive-single` | Archive one product by ID |
| `find-orphans` | Find active products not in CT catalog |
| `debug-ct-pages` | Paginate CT API and report brand/page counts |
| `audit-tire-skus` | Cross-reference TIRE- vs bare-SKU products |
| `repair-tags` | Fix corrupt tag strings |
| `backfill-ai-match` | Add `ai-match` tag to ct-sync products |
| `status` | Shopify connection + product count |

### PR / Commit History (gci-brain)
| PR / Commit | Description |
|---|---|
| PR #107 | Add Duplicate SKU Audit tool |
| PR #108 | Legacy TIRE- comment in shopifySync.ts |
| PR #109 | Tiered pricing formula (×2.10/×1.72/×1.58) |
| PR #110 | CT-Sync Tag Backfill tool |
| `509c372` | feat: archive-null-sku action in duplicateSkuAudit |
| **PR #111** | **fix: 6 surgical fixes (Session 11)** |

### PR #111 — 6 Surgical Fixes (Session 11, May 28, 2026)
| Fix | File | Change |
|---|---|---|
| Domain | `src/services/shopifyProductService.ts` | `gcitires.ca` → `gcitires.com` in productUrl |
| Duplicate key | `src/services/shopifyProductService.ts` | Remove duplicate bare `productUrl` return key |
| Type cast | `api/chat.ts` | `res.json() as any` on Gemini + Deepseek calls |
| Generic cast | `api/bulkPriceUpdate.ts` | `res.json() as T` in shopifyFetch helper |
| GMC feed season | `api/feed/gmc/index.ts` | `seasonStr` now used in description template |
| Microsoft feed season | `api/feed/microsoft/index.ts` | Season prefix added to description |
| Bundle split | `vite.config.ts` | `'maps'` chunk for `@maptiler/sdk` + `@react-google-maps/api` |

---

## 9. Internal Tools — scripts/archiveGhostProducts.ts

New script added in Session 11 (`scripts/archiveGhostProducts.ts`):
- Finds active products with null SKU on ALL variants AND ghost title pattern
- Ghost patterns: titles ending in "All-Season Tire", "Summer Tire", "Winter Tire", etc. + exact matches (Installation & Service, Michelin X-Ice Snow, Nokian Hakkapeliitta 10, Pirelli Ice Zero)
- Dry run by default: `npx tsx scripts/archiveGhostProducts.ts`
- Live run: `npx tsx scripts/archiveGhostProducts.ts --confirm`
- **Result on first run: 0 found** — ghost products were already archived

---

## 10. Order Routing (api/walmart-order-sync.ts)

Polls every 15 min. When Walmart orders arrive:
1. Acknowledge on Walmart (within 4hr requirement)
2. Match SKU → Canada Tire part number
3. Generate CT PO
4. Log to Google Sheets
5. Send Telegram + Gmail notification to Patrick

**CT Tracking Parser** (`api/ct-tracking-parser.ts`): Parses CT tracking PDFs from Gmail, extracts tracking numbers, marks orders shipped on Walmart.

**No orders yet received** — system live and polling.

---

## 11. Current Status (Session 11 End State)

### ✅ Working
- **2,463 tires live on Walmart Canada** (Session 11 final feed)
- Walmart titles include season suffix ("All Season Tires", "Winter Tires", etc.)
- 106 Shopify duplicate products deleted (dedup confirmed 0 failures)
- Skip rate reduced 70%: 612 → 181
- `gci-brain` PR #111 merged and deployed to `match.gcitires.com`
- Product URLs corrected to `gcitires.com` (was `.ca`)
- GMC + Microsoft shopping feeds now include season in descriptions
- Daily shopifySync cron running (03:00 ET)
- Daily walmart-sync cron running (04:00–04:40 AM EST, 9 chunks)
- Order routing running every 15 min

### 🔴 Active Issues
1. **4 bad titles** causing parse failures — need Shopify Admin fix (see table above)
2. **CT_CUSTOMER_API_TOKEN exposed** in Session 11 chat — **must be rotated immediately**
3. **~115 null-SKU ghost products** still appearing in feed skip list (archived, will clear on next cycle)
4. **TIRE- duplicate legacy products** (TIRE-166xxx) — some still active, need `archive-tire-skus`

### ⏳ Next Actions (Priority Order)
1. 🔴 **Rotate CT_CUSTOMER_API_TOKEN** in NetSuite + update Vercel env var
2. 🔴 **Fix 4 bad titles** in Shopify Admin (see table in Section 7)
3. **Re-run walmart-item-feed** after title fixes → should reach ~2,470+ submitted
4. **Reply to Amar** confirming season titles are live (example: "Nexen Npriz AH5 225/65R17 All Season Tires")
5. **Enroll items in Flash deals** — Seller Center manual action
6. **Run archive-tire-skus** to clear remaining TIRE- legacy active products
7. **Test order routing** — wait for first Walmart order

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
| Smart bare-SKU filter | Brands like Minerva/Ovation/Maxtrek have bare SKUs only; blanket TIRE- filter dropped 1,598 valid items |
| Lowest productId wins on dedup | Oldest = canonical listing |
| Season suffix in Walmart titles | Amar requirement: Walmart shelving algorithm requires keyword |
| Tiered pricing ×2.10/×1.72/×1.58 | Decoupled from shipping, based on CT cost tiers |
| `crypto.randomUUID()` not uuid package | uuid v14 ESM-only crashes Vercel CJS |
| `itemIngestionStatus` field path | Walmart returns `itemDetails.itemIngestionStatus[]` |
| `noUnusedParameters: true` in tsconfig | Unused params must be prefixed `_` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` (brain) vs `SHOPIFY_ADMIN_API_TOKEN` (hub) | Different env var names — do not mix |

---

## 13. PR / Commit History (gci-order-hub)

| PR / Commit | Description |
|---|---|
| PR #4–10 | Initial feed, schema fixes, ESM fix, MP_ITEM_INTL |
| PR #13 | Fix root 404, maxDuration, vercel.json |
| PR #14 | CT tracking parser bugs, Gmail env vars, cron |
| PR #15 | Flotation tire sizes + null-SKU logging |
| PR #16 | Context doc update |
| `5beb442` | fix: skip bare (non-TIRE-) SKUs in item feed |
| `d53d480` | fix: only skip bare SKUs when TIRE- twin exists |
| `90999df` | fix: use itemIngestionStatus key |
| PR #17 | Merge diagnostic endpoints to main |
| `1cb0a75` | fix: add walmart-feed-diag to vercel.json |
| `c171ba8` | docs: update project context Session 10 |
| **`2bcb367`** | **fix: season suffix in Walmart titles (Session 11)** |

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

---

## 15. Known Issues / Tech Debt

| Issue | Detail | Priority |
|---|---|---|
| CT_CUSTOMER_API_TOKEN exposed | Session 11 chat exposure — rotate immediately in NetSuite | 🔴 CRITICAL |
| 4 bad-title parse failures | Kenda, Nexen, Cooper STT Pro, Bridgestone WS90 | HIGH |
| Ghost null-SKU products | ~115 archived products still appearing in feed skip list | MEDIUM (self-resolves) |
| Flotation size parser | `3513/R`, `31X10.50R15` not parsed (~25 SKUs) | MEDIUM |
| Legacy TIRE- active products | TIRE-166xxx still active; run archive-tire-skus | MEDIUM |
| Vredestein AP### duplicates | Some AP### Vredestein SKUs still duplicate | LOW |
| BookingPage.ts JSX errors | JSX in .ts file — pre-existing, not introduced by PR #111 | LOW |

---

## 16. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar (Amarjeet Singh) | Walmart MP Support | Via Walmart Seller Center ticket |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |
| Nija Elsa Varghese | Canada Tire, Junior ERP & Systems Developer | NetSuite OAuth credentials contact |

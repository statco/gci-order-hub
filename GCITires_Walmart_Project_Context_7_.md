Suggestion slots populate correctly with the Ovation as a same-size, different-brand match; hint banner displays. (A 235/60R20 test earlier returned 0 matches — confirmed as a genuine catalog gap, not a bug: no other brand carries that exact size.)

### Known cosmetic, unrelated issue
`merchantWidgetScript.addEventListener is not a function` errors appear in console — pre-existing third-party script conflict, not introduced by this work, does not affect compare bar functionality.

---

## 13. Current Status

### ✅ Fully Working
- Global API auth (token via Basic auth, cached 900s)
- Price sync: `pricing` as array + `currentPriceType: "BASE"` ✅
- Inventory sync: SKU as query param `?sku=TIRE-xxx` ✅
- `walmart-sync-cursor`: chunked sync running every 2 min ✅
- Order polling (15 min cron) with **persistent KV cursor**: operational, verified no-gap catch-up ✅
- Order acknowledgement: automatic ✅
- PO# auto-generation: operational ✅
- CT invoice PDF parsing: operational ✅
- Auto-ship on tracking receipt: operational ✅
- Manual ship Brain dashboard: operational ✅
- Google Sheet order log: operational ✅
- Telegram notifications: operational ✅
- Storefront compare bar: unreachable-button fix + same-size cross-brand suggestions ✅

### 🔴 Active Issue — 810 Prohibited Items
- Error: "This item is prohibited because it violates one of our legal or compliance policies"
- Affects 810 of 828 submitted items
- Support case open with Amar
- Likely caused by earlier unauthorized brand submissions triggering compliance flag

### ⏳ Remaining Tasks
1. **Resolve 810 prohibited items** — await Amar's support case response
2. **Refire item feed** when compliance clears — target ~849 published
3. **Fix flotation tire parser** — recover 25 SKUs (`3513/R` format)
4. **Fix Bridgestone WS90 vendor** — change from "GCI Tires" to "Bridgestone" (TIRE-BBK90)
5. **Complete June 26 order** (`600000100319395`) — add to Sheet manually, call `walmart-ship` once CT tracking received
6. **Audit other potential missed orders** — now that KV cursor is fixed, confirm no other gaps exist between May 31 (KV created) and June 30 (env vars confirmed live)

---

## 14. Key Technical Decisions

| Decision | Rationale |
|---|---|
| `mode=listed` sync filter | Only push to PUBLISHED SKUs — prevents 404s on errored items |
| `pricing` as array + `currentPriceType: "BASE"` | Global API v3.1 requirement |
| `?sku=` query param on inventory PUT | Global API lookup key requirement |
| `feedType=MP_ITEM_INTL` | Walmart Canada Global API requirement |
| `productId: "CUSTOM"` | GTIN exemption requirement |
| `crypto.randomUUID()` not `uuid` package | `uuid` v14 is ESM-only, crashes Vercel CJS |
| `GET /v3/orders?createdStartDate=` not `/released` | Walmart CA doesn't support `/released` endpoint (520 error) |
| `orderStatus` not `status` query param | Walmart CA API parameter name |
| Google Sheets as order dedup + log | Visible, editable, no extra DB needed |
| Service account for Sheets | Server-to-server, no OAuth flow needed |
| `pdf2json` not `pdf-parse` | `pdf-parse` requires `DOMMatrix` — crashes Vercel serverless |
| Gmail OAuth2 refresh token | Personal Gmail (info@gcitires.ca) — service accounts don't support personal Gmail |
| Tab name `GCI Tires — Walmart Order Log` not `Sheet1` | CSV import named tab after file title |
| TIRE- numeric suffix = CT part number | e.g. TIRE-160136025 → search 160136025 on CT portal |
| GLS carrier → Walmart `OTHER` | Walmart CA has no GLS carrier code |
| **Vercel KV for order-sync cursor** | **24h fixed lookback silently dropped a real order; persistent last-success timestamp makes the cron self-healing across any outage up to 14 days** |
| **`setSyncSuccess` uses run-start time, not completion time** | Orders created mid-run are still caught on the very next pass |
| **Client-side `/collections/all/products.json` fetch for compare suggestions, not Shopify search API** | Third-party analytics script corrupts any `resources[...]` bracket-pattern query string on both `fetch` and `XHR`; the plain REST products endpoint is unaffected |
| **`extractSize()` returns `''` not original string on no regex match** | Original bug caused the fallback chain (`variant.size \|\| title`) to short-circuit on non-size strings like "Default Title" |

---

## 15. PR History (gci-order-hub)

| PR / Commit | Description | Status |
|---|---|---|
| #4 | Add walmart-item-feed, walmart-feed-status, tire-parser | Merged |
| #5 | Fix timeout: drop body_html, raise maxDuration to 300s | Merged |
| #7 | Fix productId: GTIN_EXEMPT → CUSTOM | Merged |
| #9 | Switch to MP_ITEM_INTL schema v3.16 | Merged |
| #10 | Fix ERR_REQUIRE_ESM: uuid → crypto.randomUUID() | Merged |
| #40 | Oversell monitor, zero-chunking, retire lifecycle (pre-existing, found this session) | Merged |
| #41 | Cursor-driven price/inventory sync — walmart-sync-cursor (pre-existing, found this session) | Merged |
| direct | Deduplicate SKUs (lowest productId wins) | Merged |
| direct | Add GTIN_EXEMPT_BRANDS allowlist filter | Merged |
| direct | Add walmart-order-sync + sheets-client | Merged |
| direct | Fix /released → ?createdStartDate + filter Created in code | Merged |
| direct | Add walmart-ship + carrier map + tracking URLs | Merged |
| direct | Add ct-tracking-parser (pdf2json + Gmail OAuth) | Merged |
| direct | Add getPendingOrders endpoint (CORS open) | Merged |
| direct | Fix Sheet tab name: Sheet1 → GCI Tires — Walmart Order Log | Merged |
| direct | Extend order lookback window (initial 24h→7d quick fix, later superseded by KV) | Merged |
| direct | Add ORDER_SYNC_LOOKBACK_HOURS / MAX env vars | Merged |
| direct | chore: remove stray debug artifacts, update .gitignore | Merged |

## 16. PR History (gci-brain)

| PR | Description | Status |
|---|---|---|
| #107 | Add Duplicate SKU Audit tool | Merged |
| #108 | Add legacy TIRE- comment to shopifySync.ts | Merged |
| direct | Add WalmartManualShip component + /walmart-ship route | Merged |

## 17. Storefront Theme Changes (Dawn, gcitirescanada.com)

| Change | File | Status |
|---|---|---|
| Compare drawer bottom padding fix (desktop + mobile) | `main-collection-product-grid.liquid` | Live |
| JS toggle to hide sticky bar while drawer open | `main-collection-product-grid.liquid` | Live |
| `loadCatalog()` — 10-page parallel fetch of full product catalog | `main-collection-product-grid.liquid` | Live |
| `fetchSuggestions()` — same-size, cross-brand matching | `main-collection-product-grid.liquid` | Live |
| `extractSize()` — fixed empty-string fallback bug | `main-collection-product-grid.liquid` | Live |
| Suggestion hint banner + slot click-to-add UI | `main-collection-product-grid.liquid` + `gci-compare-bar.liquid` | Live |

---

## 18. gci-brain Internal Tools

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
| Walmart Manual Ship | /walmart-ship | Manual fallback for CT tracking entry |

### Duplicate SKU Audit — backend (api/duplicateSkuAudit.ts)
- `action=scan` — groups by SKU (not title), supports `ctSyncOnly=true`
- `action=fix` — clears SKU on higher-productId duplicates
- `action=archive-duplicate` — archives higher-productId product in Shopify
- 103 duplicate SKUs cleared May 21, 2026. Daily sync never re-writes SKUs.

---

## 19. Known Shopify Data Issues

| Issue | SKUs | Fix |
|---|---|---|
| Flotation sizes (`3513/R` format) | ~25 SKUs | Fix titles OR update tire-parser.ts |
| Wrong vendor on Bridgestone WS90 | TIRE-BBK90 | Change vendor from "GCI Tires" to "Bridgestone" |
| Legacy TIRE- secondary-index block | shopifySync.ts ~line 301 | Remove once TIRE- products retired |

---

## 20. Contact References

| Name | Role | Contact |
|---|---|---|
| Patrick B. Pierre | President, GCI Inc. | info@gcitires.ca / (438) 402-6616 |
| Amar | Walmart MP Support | Via Walmart Seller Center ticket thread |
| Amanda Muise | Canada Tire, Sr. Sales Enablement Mgr | amuise@cdatire.com |
# GCI Tires — Walmart Project Context (v14)
**Updated:** May 31, 2026 (end of session)
**Owner:** Patrick B. Pierre — info@gcitires.ca · 438-402-6616 — President, Groupe de Commerce Intercontinental Inc.

This supersedes v13 (`GCITires_Walmart_Project_Context_13.md`). Read this first in a new session.

---

## 0. ONE-LINE STATUS

The below-cost pricing crisis is **resolved and structurally prevented**. All infrastructure layers except Layer 3 (item feed $285 default fix) are live. Order-sync is resilient with retry, catch-up cursor, and early Telegram alerts. Daily reconcile (Layer 2) and cost-integrity (Layer 4) crons are running. Remaining work: Layer 3 + 17 SKU cost resolution + unmatched listings cleanup.

---

## 1. WHAT WAS FIXED (all merged + deployed)

### `statco/gci-brain` — PRs #114–#117

#### PR #114 — Root cause removed (the cost-halving / MSRP-substitution bug)
`shopifySync` had a rule `cost ≥ msrp×0.90 → substitute msrp×NET_MULTIPLIER (0.50)` — when real CT cost looked "too high," it threw away the real cost and stored **half the MSRP**. Corrupted cost on ~145 SKUs; ultimate origin of the $285 saga.
- Rule existed in **5 paths**: `buildPayload` (create), retry-create, `runSync` update loop (2 branches), `update-chunk`, **and the daily-sync cron**.
- **Fix:** single shared `parseCTDealerCost()` gate on all 5 paths. Returns real CT dealer cost unmodified, or `null` if missing/non-numeric → SKU skipped + flagged, never substituted, never halved, never `||0`.
- Both `Cost per item` AND the `canada_tire.cost` metafield now write the same strict-parsed value on every path.
- `NET_MULTIPLIER` constant fully removed. Metafield write no longer `.catch()`-swallowed.

#### PR #115 — MSRP-ratio band enforcement (write-time guard)
Band check on every write: cost must satisfy **`msrp×0.25 ≤ cost < msrp×0.90`**. Out-of-band costs skipped and reported in `outOfBandSkus`, never written. Missing-MSRP tires still write through.

#### PR #116 — Raw CT diagnostic
`?raw=1` on `ct-cost-lookup` endpoint returns complete unmodified CT/NetSuite object per part number. Used to confirm the 17-SKU CT data problem (see §3).

#### PR #117 — `costOverrides` + NetSuite RESTlet fix doc
- `update-chunk` now accepts optional `costOverrides: Record<string, number>` map. Overrides are **still band-checked** against CT MSRP — bad values flagged in `outOfBandSkus`/`badOverrides`, never written. New `overridden` count in response.
- `docs/netsuite-restlet-add-dealer-cost.md` — SuiteScript snippets to add real dealer cost fields to CT RESTlet, ready to paste into NetSuite (requires CT/NetSuite access — Pat does not have this).
- `docs/update-chunk-cost-overrides.md` — usage reference for `costOverrides`.
- `costOverrides` is the **only sanctioned non-CT cost injection** (still band-checked). See §6.

### `statco/gci-order-hub` — PRs #22 + #23

#### PR #22 — Order-sync resilience (merged ✅)
**(a)** Early Telegram alert fires before CT PO step — no order ever invisible. `sendTelegram()` hardened to log HTTP failures.
**(b)** Retry-with-backoff via `api/lib/retry.ts`: 4 attempts at 2s/4s/8s, retrying on HTTP 5xx, Cloudflare 520, `fetch failed`. Failure alert fires once, after all retries exhausted.
**(c)** Catch-up cursor via `api/lib/sync-state.ts`: fetches orders since `lastSuccessfulSyncTimestamp` (Vercel KV via REST; 24h look-back fallback). Cursor advances only on clean completion, capped at 7 days.
**KV:** true catch-up mode is **active once `KV_REST_API_URL` + `KV_REST_API_TOKEN` are confirmed in the `gci-order-hub` env vars** (Upstash for Redis linked to the project auto-injects them). Until confirmed, it safely runs in 24h look-back fallback.

#### PR #23 — Layers 2 + 4 (daily crons, merged ✅)
**Layer 2 — `api/walmart-reconcile.ts`:** Daily cron. For every Walmart-matched SKU: reads Shopify price + cost, computes floor via `safeWalmartPrice`, pushes corrected price and/or inventory to Walmart if divergent. Reports `corrected`, `skippedNoCost`, `inventoryUpdated`, `errors`. Sends Telegram summary on completion (skips dry-runs). GraphQL pagination for Shopify variants; offset 200/page for Walmart items.

**Layer 4 — `api/cost-integrity-audit.ts`:** Daily read-only cron. Flags per SKU with reason codes:
- `MISSING_UNIT_COST` — no `Cost per item`
- `MISSING_CT_COST` — no `canada_tire.cost` metafield
- `COST_OUT_OF_BAND` — fails `[msrp×0.25, msrp×0.90)` band (uses `compareAtPrice` as MSRP — confirmed correct, no MSRP metafield exists)
- `STALE` — cost not updated in >30 days
Sends Telegram summary only when flags found. **No writes under any condition.** Accepts POST for same-origin DevTools testing.

**Shared:** `api/lib/telegram.ts` — non-throwing GCI Orders sender reused by both crons.

---

## 2. THE WALMART FLOOR (live in gci-order-hub)

`safeWalmartPrice({shopifyPrice, cost})` is the only sanctioned price-write path. `PRICE_FLOOR_MULTIPLIER = 1.15`. Returns `max(shopifyPrice, cost×1.15)` rounded to `.99`; returns **null if cost missing → caller skips the write**. Hard assertion backstop throws on any below-cost write.

**Prior session: ran `walmart-price-audit` live → `corrected: 482`, `skippedNoCost: 9`, zero below-cost writes.** Re-run after the 17 SKUs get real cost written. Endpoint: `https://gci-order-hub.vercel.app/api/walmart-price-audit?offset=0&limit=2755` (add `&dryRun=true` to preview). Splits into 300-batches if it 504s.

---

## 3. THE 17 SKUs — DIAGNOSED, WRITE MECHANISM READY, COSTS NOT YET ENTERED

**Finding (definitive, via #116 raw dump, `sandbox: false`):** For 17 SKUs, **CT's API returns `cost` === `msrp` (identical)** — CT is handing back list price in the cost field, no dealer-cost field anywhere in the object. Band check correctly rejects all 17. This is a **CT data problem, not a code problem.**

The 17 (all confirmed `cost = msrp`):
| SKU | CT cost=msrp | Real cost should be ~ |
|---|---|---|
| 170003001 (Cooper Discoverer AT3 LT) | 516.00 | 232–372 |
| 166122006 (Cooper Evolution Winter) | 304.00 | 137–219 |
| MB5027 (Maxtrek Trek M900 Ice) — **247 units in stock** | 452.00 | 203–325 |
| MB4155 | 430.00 | 194–310 |
| MB502L | 363.00 | 163–261 |
| MB5054 | 359.00 | 162–258 |
| MB4148 | 351.00 | 158–253 |
| MB6059 | 334.00 | 150–240 |
| MB6114 | 329.00 | 148–237 |
| MB4016U — **22 units in stock** | 303.00 | 136–218 |
| MB4003U | 299.00 | 135–215 |
| MB4062L | 279.00 | 126–201 |
| M347U | 273.00 | 123–197 |
| MB4277 | 231.00 | 104–166 |
| M2164 | 210.00 | 94–151 |
| M2031U | 179.00 | 81–129 |
| M1087L | 155.00 | 70–112 |

**Current state in Shopify:** still holding BAD clearance values (e.g. `170003001` = $24.97, `MB5027` = $119.97, `M1087L` = $49.97). **Floor-protected** — Walmart price is the correct Shopify retail which wins the floor's `max()`. No below-cost risk; bad cost distorts margin reporting and weakens floor backstop if retail drops. Latent, not active.

**Note on Vredestein Winter dupes:** 4 Vredestein Winter SKUs have duplicate Walmart listings — `costOverrides` would hit the wrong listing. Investigate mapping before using overrides on these.

**FIXED earlier (3 Coopers, real in-band cost, written manually via `inventoryItemUpdate`):**
- 166497021 → $202.40 ✓
- 166483021 → $199.18 ✓
- 166006004 → $177.56 ✓

**Two resolution paths for the 17 (do both):**
1. **Amanda Muise email — sent.** Reports `cost = msrp` symptom. If CT fixes at source, a single re-pull corrects all 17 automatically. If CT won't fix API, apply `docs/netsuite-restlet-add-dealer-cost.md` (requires NetSuite access via CT).
2. **`costOverrides` via `update-chunk`** (PR #117, live) for in-stock SKUs (MB5027 247u, MB4016U 22u priority) once verified dealer costs sourced from purchase invoices/POs. Band check validates every entry. After writing, re-run `walmart-price-audit`.

**Also still excluded / unresolved:** 4 Vredestein Winter dupes, Nitto Ridge Grappler V2 (`TIRE-NIT-RG2-2857017-117T`), Toyo Open Country AT3 (`TIRE-TOY-AT3-2756518-116T`), merged `MB515L / MB515U`. Need investigation (mapping or source).

---

## 4. PENDING WORK (priority order)

1. **Layer 3 — fix `walmart-item-feed.ts`** so new items never default to $285, then re-submit feed for items still showing $285. ← **Next Claude Code session (gci-order-hub, isolated PR).**
2. **17 SKUs** — waiting on Amanda response. Use `costOverrides` for in-stock SKUs once dealer costs sourced. Re-run `walmart-price-audit` after.
3. **~662 unmatched Walmart listings** / archived null-SKU products; flotation-size parser (~25 SKUs).
4. **Storefront widget bug:** `merchantWidgetScript.addEventListener is not a function` firing repeatedly on gcitirescanada.com — investigate, may be breaking a live widget. Deferred.

---

## 5. KEY OPERATIONAL FACTS

- **Claude Code session** (`claude.ai/code`) does all code work — has GitHub + Vercel + Shopify connectors and can edit/commit/deploy/query. **BUT its sandbox has egress hard-blocked (403 to NetSuite, Vercel, even ops.gcitires.com) and no CT_*/WALMART_* creds** — it cannot run live CT pulls or hit deployed endpoints. Pat runs those from a browser. **Context docs are NOT in the repo — upload the latest `.md` at the start of each Claude Code session.**
- **Running deployed endpoints from a locked-down work laptop (no terminal/Codespaces budget):** GET endpoints → paste URL in browser address bar. POST endpoints → DevTools Console `fetch()` **from a tab already on `gci-brain.vercel.app`** (same-origin avoids CORS). Multi-line snippets get mangled on paste → **paste as ONE line.** Fallback: hoppscotch.io with Proxy on. Network tab shows the real status when Console only shows `Promise {<pending>}`.
- **`update-chunk` request:** `POST https://gci-brain.vercel.app/api/shopifySync?action=update-chunk`, header `Authorization: Bearer <CRON_SECRET>`, body `{"skus":[...], "costOverrides":{"SKU":cost}}` (max 50 SKUs). SKU strings must be CT part numbers in STRIPPED form (no `TIRE-` prefix) — `170003001` not `TIRE-170003001`; Maxtrek codes (`MB5027`) as-is.
- **Raw CT diagnostic:** `GET https://gci-brain.vercel.app/api/bulkPriceUpdate?action=ct-cost-lookup&raw=1&parts=<comma,list>` — returns full unmodified CT objects. Watch `envCheck.sandbox` (confirmed `false` — production data).
- **CT source = NetSuite RESTlet via OAuth** (`CT_*` creds). CT contact: Amanda Muise, amuise@cdatire.com. Pat has no NetSuite access.
- **MSRP source confirmed live:** `compareAtPrice` is the correct MSRP field. No MSRP metafield exists (`canada_tire.msrp`, `canada_tire.list_price`, `canada_tire.retail` all null). Real costs cluster ~52% of `compareAtPrice` — well inside the [25%, 90%) band.
- **`gci-order-hub` order-sync KV:** catch-up cursor needs `KV_REST_API_URL` + `KV_REST_API_TOKEN` (auto-injected by linked Upstash for Redis). Confirm both are present to leave 24h look-back fallback mode. Optional tuning: `ORDER_SYNC_LOOKBACK_HOURS` (default 24), `ORDER_SYNC_MAX_LOOKBACK_HOURS` (default 168 / 7-day back-fill cap).
- **CRON_SECRET:** rotated ✅. Never paste the real value — use `<CRON_SECRET>` placeholder.

---

## 6. HARD CONSTRAINTS (do not break)

- `vercel.json` `functions` block is an **allowlist** — unlisted API files 404. Add every new endpoint.
- Use `crypto.randomUUID()`, never the `uuid` npm pkg (ESM crash on Vercel CJS) for WM_QOS.CORRELATION_ID.
- Do NOT add `"type":"module"` to root `package.json` (ESM/TS Vercel conflict).
- Shopify variant pagination MUST use GraphQL (REST Link header caps ~2,527).
- TS strict: `noImplicitAny`, `noUnusedParameters` (prefix unused `_`).
- **Cost rule (permanent):** always store real CT dealer cost unmodified; if missing → skip + flag, NEVER substitute MSRP, NEVER halve, NEVER `||0`. Enforced by `parseCTDealerCost` + band check. `costOverrides` is the only sanctioned non-CT cost injection — still band-checked, never bypasses the guard.
- **`safeWalmartPrice()` is the only sanctioned Walmart price-write path** — do not bypass it.
- **Layer 4 is read-only** — no writes under any condition.
- Walmart price payload: `{sku, pricing:[{currentPriceType:'BASE', currentPrice:{currency:'CAD', amount}}]}`. Inventory: PUT `/v3/inventory?sku=X` body `{sku, quantity:{unit:'EACH', amount}}`. Items: GET `/v3/items` (NOT `/v3/ca/items`), offset pagination 200/page. Market via `WM_MARKET: ca` header.
- Walmart deal: 75% referral-fee discount until Jan 31 2027 (effective 2.5%); submit promotions, don't cut prices.
- cjdropshipping Shopify location intentionally kept for Driver & Crew Essentials — do not remove.

---

## 7. REPOS / IDS

- `statco/gci-brain` → gci-brain.vercel.app (Shopify sync, cost, CT pulls, tools). Prod includes #114–#117.
- `statco/gci-order-hub` → gci-order-hub.vercel.app (Walmart sync/feed/orders, floor, price-audit, reconcile, cost-audit). Prod includes PR #22, #23.
- Walmart Seller ID 10002930522, store "GC Tires". Walmart support: Amar (Amarjeet Singh). API v3.1, `WM_MARKET=ca`, base marketplace.walmartapis.com.
- Shopify: gcitires.myshopify.com / storefront gcitirescanada.com (Dawn theme, FR default + EN).
- Cancelled bad order (reference): Jason Harrisson, order 600000103212221, 4× Cooper AT3 XLT `TIRE-170034002` at $285 vs correct $537.99.

---

## 8. RELATED FILES
**gci-order-hub `api/lib/` (added PR #22 / #23):**
- `api/lib/telegram.ts` — non-throwing GCI Orders Telegram sender; shared by `walmart-reconcile.ts` + `cost-integrity-audit.ts` cron summaries (PR #23).
- `api/lib/retry.ts` — `retryWithBackoff()` + `HttpError` + `isTransientError()`; transient-only retries (5xx/520/`fetch failed`) at 2s/4s/8s for order-sync (PR #22).
- `api/lib/sync-state.ts` — order-sync catch-up cursor (`getSyncSince` / `setSyncSuccess`); Vercel KV via REST with 24h look-back fallback (PR #22).

**Specs / docs / worklists (in outputs):**
- `Walmart_Permanent_Fix_Spec_for_ClaudeCode.md` — full 4-layer spec (floor, reconcile, correct-at-creation, cost-integrity).
- `CT_cost_repull_combined.csv` — the 28 SKUs with validation bands.
- `docs/netsuite-restlet-add-dealer-cost.md` (in gci-brain repo) — SuiteScript snippet to add dealer cost to CT RESTlet.
- `docs/update-chunk-cost-overrides.md` (in gci-brain repo) — usage reference for `costOverrides`.
- `null_cost_repull_worklist.csv`, `missing_cost_backfill_worklist.csv`, `suspicious_low_cost_verify.csv` — earlier worklists.
- Storefront bug: `merchantWidgetScript.addEventListener is not a function` on gcitirescanada.com — deferred.

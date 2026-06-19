# Walmart Inventory Runbook — gci-order-hub (Shopify → Walmart)

> Companion doc: `gci-brain/docs/INVENTORY_INTEGRITY_RUNBOOK.md` (Canada Tire → Shopify).
> Read both for the full picture. The **Inventory Invariants** section below is shared
> verbatim between the two repos — keep them in sync if either is edited.

---

## 1. What problem this system prevents

Customers were buying out-of-stock tires on Walmart, forcing manual cancellations. The bad
quantity originated upstream (Shopify, fed by stale Canada Tire data) and this repo faithfully
pushed it to Walmart. The root cause is fixed in gci-brain; **this repo's job is to make sure
Walmart receives the corrected `0` fast, and to clean up listings that have no live Shopify
product behind them.**

Three vectors existed (full detail in the gci-brain runbook): active products losing CT backing,
orphaned legacy `TIRE-` listings, and stranded archived inventory. The orphan-sweep here
neutralizes the second and third on the Walmart + Shopify side.

---

## 2. Inventory Invariants (shared — do not violate)

1. **Inventory is decoupled from price/cost.** A suspect/missing cost may block a *price* write
   (the exposure hold), but must **never** block the *inventory* write.
2. **Zeros-only is always safe.** Pushing quantity `0` can only ever *under*-sell (recoverable),
   never *over*-sell. The reactive push and orphan-sweep write **only** `0`. Safe to re-run.
3. **Zero before archive — never archive before zero.** Archiving strands inventory outside the
   active-only scans.
4. **Dry-run first, verify after.** Any operation with per-SKU writes is previewed with
   `dryRun=true` (never writes) and confirmed afterward with a read-back.

---

## 3. System data flow

```
Shopify (gcitires.com)
        │  daily: walmart-sync (price + qty, mode=listed, chunked)
        │  daily: walmart-orphan-sweep (zero listings with no active Shopify product)
        │  reactive: walmart-zero  ◄── POST from gci-brain inventory-reconcile
        │  manual:   walmart-retire (one-time/cleanup operations — no cron)
        ▼
Walmart Marketplace
```

`walmart-sync` is the steady-state push. `walmart-zero` is the fast reactive path (minutes).
`walmart-orphan-sweep` is the safety net for listings that fell out of the active catalog.
`walmart-retire` is the surgical removal tool for confirmed duplicate/obsolete listings.

---

## 4. Components in this repo

### `api/walmart-sync.ts` — steady-state push

Reads active `ct-sync` Shopify variants, pushes price + quantity to Walmart in bulk feeds.

- **Inventory rule:** Shopify qty `0` → Walmart `0`; Shopify qty `>0` → real qty (no
  low-stock suppression; the old `<4 → 0` switch was removed).
- **Exposure hold (`heldExposed`):** if the price to push is below `ctCost × PRICE_FLOOR_MULTIPLIER`
  (suspect/stale stored cost), the **price** write is skipped but **inventory is still pushed**.
  Auto-releases once the stored cost is corrected. This is the price/inventory decoupling in action.
- **Modes:** `?mode=listed` (only Walmart-listed SKUs), `?mode=audit` (compare sets, no writes),
  `?mode=sku-sample`, `?dry=true`, `?offset`/`?limit` for chunked listed runs.

### `api/walmart-zero.ts` — reactive zero target (Phase 3)

POST-only, Bearer-authed with `WALMART_ZERO_SECRET`. Receives a SKU list from gci-brain's
`inventory-reconcile` and pushes **quantity `0` only** for the SKUs Walmart actually lists
(matches both bare and `TIRE-` forms). Cannot push any non-zero value → can only under-sell.
Separate from `walmart-sync`, which is untouched and remains the daily backstop.

### `api/walmart-orphan-sweep.ts` — orphan safety net

Computes `fetchListedSkus()` − active `ct-sync` Shopify SKUs = **orphans** (listed on Walmart,
no live Shopify product). For each orphan:
- **(a)** push Walmart qty `0`, and
- **(b)** zero the Shopify `inventory_quantity` **all-status** (active OR archived OR draft) —
  this clears phantom records like archived `TIRE-11201NXK` qty 2 that were feeding the
  storefront/Agentic assistant false stock.

Supports `?dryRun=true`, `?withQty=true` (per-SKU Walmart qty probe → `liveVectorCount`), and
**`?offset`/`?limit` chunking (required — see §7).**

### `api/walmart-retire.ts` — catalogue retirement (PR #31, manual only)

**Purpose:** Permanently removes a listing from the Walmart catalogue via `DELETE /v3/items/{sku}`.
Used when a SKU should never appear on Walmart again (e.g. confirmed duplicate `TIRE-` listings
that have a live bare twin). Retire is near-permanent — **not a zero, not reversible via the
normal sync cycle.** There is **no cron entry** for this endpoint; it is triggered manually only.

**Auth:** Bearer token matching `WALMART_RETIRE_SECRET` (separate from `WALMART_ZERO_SECRET` —
never share secrets between destructive operations).

**Request body:** `POST /api/walmart-retire` with `{ "skus": ["TIRE-XXX", ...] }` (max 500 SKUs).

**Hard guardrails (all evaluated before any write):**

| Guard | Behaviour |
|---|---|
| TIRE- prefix required | If **any** non-`TIRE-` SKU is present the **entire batch is rejected (400)**. Structurally prevents retiring a live bare listing. |
| Live bare-twin check | `TIRE-XXX` is only retired if bare `XXX` is **currently listed** on Walmart. SKUs whose bare twin is absent → `skippedNoBareTwin` (never retired). |
| `dryRun` default `true` | Must pass `?dryRun=false` explicitly to write. Returns `willRetire` + `skippedNoBareTwin` with no API calls in dry mode. |
| Idempotent | `404`/`410` from Walmart treated as success — safe to re-run. |

**Chunking:** `?offset=N&limit=N` (default limit `100`). Walk `nextOffset` across calls for
large batches; the full SKU array is passed in the body every call and the endpoint slices it.

**Exceptions — SKUs that must never be retired without manual review:**

| SKU | Reason |
|---|---|
| `TIRE-170122034` | No bare twin exists at all — exclude from input. |
| `TIRE-10987NXK` | Bare twin `10987NXK` exists but is **UNPUBLISHED**. Retiring the `TIRE-` form would leave this product with no live listing. Resolve by publishing the bare twin first. |

### Existing supporting jobs
`walmart-order-sync` (order ingestion), `cost-integrity-audit` (reads `cost_synced_at`),
`walmart-reconcile`, `ct-tracking-parser`.

---

## 5. Cron schedule (this repo's `vercel.json`)

| Path | Schedule | Purpose |
| --- | --- | --- |
| `/api/walmart-sync?mode=listed&offset=0&limit=300` | `0 9 * * *` | Walmart push chunk 0. |
| `…offset=300…` → `…offset=2400…` | `5..40 9 * * *` | Chunks 1–8 (staggered 5 min). |
| `…offset=2700&limit=300` | `45 9 * * *` | **Tail chunk (added).** |
| `…offset=3000&limit=300` | `50 9 * * *` | **Tail chunk + headroom (added).** |
| `/api/walmart-orphan-sweep` | `0 11 * * *` | **Daily orphan safety net.** |
| `/api/walmart-order-sync` | `*/15 * * * *` | Order ingestion. |
| `/api/cost-integrity-audit` | `0 9 * * *` | Cost-freshness audit. |
| `/api/walmart-reconcile` | `0 10 * * *` | Existing reconcile. |
| `/api/ct-tracking-parser` | `*/30 * * * *` | Tracking parse. |

`walmart-retire` has **no cron entry** — manual trigger only.

---

## 6. Env vars

| Variable | Purpose |
| --- | --- |
| `WALMART_ZERO_SECRET` | Bearer secret for `walmart-zero` (must match gci-brain's `ORDER_HUB_ZERO_SECRET`) |
| `WALMART_RETIRE_SECRET` | Bearer secret for `walmart-retire` (separate — never reuse `WALMART_ZERO_SECRET`) |

Vercel env only — never in code/chat/shell history. Rotate immediately if exposed (same policy
as `WALMART_ZERO_SECRET`).

---

## 7. Operating procedures

### The orphan-sweep playbook (dry-run → verify → execute → verify)

1. **Audit (read-only):** `GET /api/walmart-sync?mode=audit` → `unmatchedWalmart` is the orphan
   blast radius. `walmartTotal − matched` is the real count (the list is truncated to 20).
2. **Chunked dry run with quantities** (production domain — see gotchas):
   ```
   for OFFSET in 0 150 300 450 600; do
     curl -s "https://gci-order-hub.vercel.app/api/walmart-orphan-sweep?dryRun=true&withQty=true&offset=$OFFSET&limit=150" \
       | jq '{offset, chunkSize, orphanCount, liveVectorCount, qtyLookupFailed}'
   done
   ```
   Validate: `chunkSize` non-zero, chunk sizes sum to `orphanCount`, `qtyLookupFailed: 0`.
   Sum `liveVectorCount` = SKUs currently overselling.
3. **Execute (writes — one physical line per curl, secret via `read -rs`):**
   ```
   read -rs ZERO_SECRET   # paste secret, enter (no echo)
   for OFFSET in 0 150 300 450 600; do
     curl -s -X POST -H "Authorization: Bearer $ZERO_SECRET" "https://gci-order-hub.vercel.app/api/walmart-orphan-sweep?dryRun=false&offset=$OFFSET&limit=150" | jq '{offset, chunkSize, done, walmartZeroed, shopifyZeroed, errors}'
   done
   ```
4. **Verify:** re-run the dry run; `liveVectorCount` should sum to `~0`. Spot-check a known SKU
   via the `sku-lookup` mode → `shopifyAnyStatus` qty `0`.

### The retire playbook (manual, one-time operations)

Use only when you have a confirmed set of `TIRE-` duplicate listings where each has a verified
live bare twin. **Never retire bare SKUs. Never skip the dry-run.**

1. **Dry run — confirm counts:**
   ```
   read -rs RETIRE_SECRET
   curl -s -X POST "https://gci-order-hub.vercel.app/api/walmart-retire?dryRun=true" \
     -H "Authorization: Bearer $RETIRE_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"skus": ["TIRE-XXX", "TIRE-YYY", ...]}' \
     | jq '{willRetireCount, skippedNoBareTwin, done}'
   ```
   Verify `willRetireCount` matches expectation and review `skippedNoBareTwin` — those SKUs
   will be excluded from the live run automatically.

2. **Execute in chunks of 100 (same body every call — offset slices server-side):**
   ```
   for OFFSET in 0 100 200 300; do
     curl -s -X POST "https://gci-order-hub.vercel.app/api/walmart-retire?dryRun=false&offset=$OFFSET&limit=100" \
       -H "Authorization: Bearer $RETIRE_SECRET" \
       -H "Content-Type: application/json" \
       -d '{"skus": [...full array...]}' \
       | jq '{offset, retiredCount, failedCount, nextOffset, done}'
   done
   ```
   Walk `nextOffset` until `done: true`. Any `failed` entries are safe to re-run (idempotent).

3. **Post-retire verification (let propagation settle — ~minutes):**
   - `mode=audit`: `walmartTotal` drops by retired count; `matched` also drops (expected —
     duplicate TIRE- forms were counting as matched; losing them does not harm bare listings).
   - `mode=listed&dry=true&offset=0` SKU sample should show only bare SKUs, not retiring `TIRE-` ones.
   - `walmart-orphan-sweep?dryRun=true&withQty=true`: `liveVectorCount: 0` across all pages
     confirms no residual oversell vectors.

4. **Inventory sync for bare listings (after retire propagates):**
   Run `mode=listed` real (non-dry) to push current Shopify truth to the bare Walmart listings,
   correcting any Walmart-side default-100 quantities that may have appeared after retire.

### Golden rules (learned the hard way)
- **Production domain, not preview.** `gci-order-hub.vercel.app` works with plain curl. The
  preview branch URL (`…-git-claude-…`) sits behind Vercel Deployment Protection → `401` +
  HTML. Use production, or a bypass token / the Vercel MCP for preview.
- **Chunk per-SKU work.** Un-chunked 680 → `504 FUNCTION_INVOCATION_TIMEOUT`. `limit≈150` for
  sweep, `limit≈100` for retire.
- **One physical line per curl.** Multi-line `\`-continuations mangle on paste → garbled command
  → all-`null` jq output (no write happened).
- **Zeros-only + idempotent.** Re-running any sweep or retire chunk is harmless.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `jq: parse error: Invalid numeric literal … column 10` | Endpoint returned HTML, not JSON | Add `-w "\n[HTTP %{http_code}]\n"`; usually 401 (preview) or 504 (timeout). |
| `Authentication Required` HTML, `[HTTP 401]` | Vercel Deployment Protection on preview | Use production domain, or bypass token / Vercel MCP. |
| `504 FUNCTION_INVOCATION_TIMEOUT` | Too many per-SKU calls in one invocation | Lower `limit`, walk `nextUrl`. |
| `chunkSize:0`, `offset:null` | `parseInt`→NaN param parse | Fixed in `75e6ac5`; ensure deploy is current. |
| All fields `null` in jq output | Mangled multi-line curl; no request sent | One physical line per curl; re-run. |
| Retire 400: "bare SKUs present" | Non-`TIRE-` SKU slipped into the input array | Audit input; every SKU must start with `TIRE-`. |
| Retire returns SKU in `skippedNoBareTwin` | Bare twin not currently listed on Walmart | Check twin's publish status; publish before retiring or leave as exception. |

### Learnings from the June 2026 TIRE- duplicate incident

**Listing-view inventory ≠ purchasable inventory.**
The Seller Center CSV showed ~325 `TIRE-` listings at qty 100. The `withQty` fulfillment-API
probe (`walmart-orphan-sweep?withQty=true`) showed only 28 actually buyable. Always trust the
API probe over Seller Center display when assessing live oversell risk.

**External catalog ops can re-arm swept orphans.**
An additive Walmart SKU-rename (bare → `TIRE-`) re-stamped 384 old `TIRE-` SKUs with Walmart's
default qty 100, re-arming the orphan sweep's oversell vectors. The sweep zeroed them, but the
root cause was the catalogue operation. Recommend alerting when an orphan-sweep dry-run reports
`liveVectorCount > 0` unexpectedly between incident cycles.

**`mode=audit` matched count includes dual-form duplicates.**
When both `TIRE-XXX` and `XXX` are listed, the audit counts both as matched. Retiring the
`TIRE-` duplicates lowers `matched` and `walmartTotal` by the same amount — bare listings are
unharmed. Do not panic at the drop in matched count after a retire run.

**Retire is async — sync after propagation, not immediately.**
After retire completes the Walmart catalogue takes a few minutes to reflect the removals. Run
`mode=listed?dry=true` and check the SKU sample before triggering a `mode=listed` real sync.
Syncing too early may push inventory updates to SKUs that are mid-retire.

**`mode=listed` dry-run `shopifyQty` is unreliable for retiring `TIRE-` rows.**
The field echoes Walmart's stored default (100), not the real archived Shopify qty. Do not use
it to assess oversell risk for retiring `TIRE-` products; use the `withQty` fulfillment probe instead.

**Orphan-sweep blind spot: matched bare listings stuck at Walmart-side defaults.**
The sweep only sees listings with no active Shopify product (orphans). A bare listing that
exists in both systems but has a Walmart-side default qty (because it was recently added or
un-retired) is invisible to the sweep. Catch these via the `mode=listed` sync dry-run
(Shopify qty vs. Walmart qty comparison) or the Shopify-vs-Walmart cross-reference.

---

## 9. Known gaps / follow-ups

- **Coverage vs. listing growth.** The `walmart-sync` chunks now cover offsets 0–3300.
  Periodically check `listedSkuCount` (in any `walmart-sync` response) against that ceiling; if
  listings grow past it, add another offset chunk. The reactive push + daily orphan-sweep reduce
  the urgency, but the tail must stay covered.
- **Second daily salvo (optional).** A second `walmart-sync` run later in the day would shorten
  the ~24h price/qty lag. Lower priority now that `walmart-zero` pushes zeros reactively within
  minutes.
- **Bare listing inventory sync (post-retire, pending).** After the June 2026 retire run
  propagates, run `mode=listed` real to push Shopify truth to the bare Walmart listings and
  correct any residual Walmart-side default-100 quantities.
- **Two retire exceptions requiring follow-up:**
  - `TIRE-10987NXK` — publish bare `10987NXK` first, then retire.
  - `TIRE-170122034` — confirm discontinued or create a bare twin before retiring.
- **Oversell alert.** Add a monitoring alert when orphan-sweep dry-run `liveVectorCount > 0`
  to catch future catalog ops that re-arm swept vectors.

---

## 10. Change log

| PR / commit | Change |
| --- | --- |
| #28 | `walmart-zero`, `walmart-orphan-sweep`, tail crons (offset 2700/3000). |
| `75e6ac5` | Fix `parseInt`→NaN chunking bug. |
| #123 (gci-brain) | `inventory-reconcile` (hourly) + zero-before-archive + reactive `pushWalmartZeros`. |
| #31 | `walmart-retire` endpoint: bulk-retire `TIRE-` duplicate listings. Separate `WALMART_RETIRE_SECRET`. Hard guardrails: bare-SKU batch reject, live bare-twin check, `dryRun` default `true`, 100-SKU chunks, idempotent. No cron. |

**June 2026 — TIRE- duplicate incident & retire execution:**
An additive Walmart SKU-rename created 384 `TIRE-` duplicate listings (each had a confirmed
live bare twin) re-armed with default qty 100. Remediation sequence:
1. 28 buyable orphan oversell vectors zeroed via orphan-sweep.
2. All 680 orphans re-flattened; 131 drifted Shopify phantoms re-zeroed.
3. `walmart-retire` PR #31 deployed and executed: 384-SKU input → dry-run returned
   `willRetire: 383` (1 excluded: `TIRE-10987NXK`, bare twin unpublished) + `TIRE-170122034`
   excluded from input (no bare twin). 375 retired, 0 failed across 4 chunks.
4. Post-retire audit: `walmartTotal 2822 → 2453`, orphan-sweep `liveVectorCount: 0` confirmed.
   Live oversell window shut. 2 exceptions held for manual follow-up (see §9).

Initial backfill (Phase 3): 680/680 orphans swept, 108 live oversell vectors → 0, 372 phantom
Shopify records zeroed (108 visible + 264 in alternate SKU forms the Walmart probe couldn't see),
verified by post-sweep dry run (`liveVectorCount: 0` across all 5 pages).

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
        ▼
Walmart Marketplace
```

`walmart-sync` is the steady-state push. `walmart-zero` is the fast reactive path (minutes).
`walmart-orphan-sweep` is the safety net for listings that fell out of the active catalog.

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

---

## 6. Env vars (Phase 3)

| Variable | Value |
| --- | --- |
| `WALMART_ZERO_SECRET` | shared secret (must match gci-brain's `ORDER_HUB_ZERO_SECRET`) |

Vercel env only — never in code/chat/shell history. Rotate immediately if exposed.

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

### Golden rules (learned the hard way)
- **Production domain, not preview.** `gci-order-hub.vercel.app` works with plain curl. The
  preview branch URL (`…-git-claude-…`) sits behind Vercel Deployment Protection → `401` +
  HTML. Use production, or a bypass token / the Vercel MCP for preview.
- **Chunk per-SKU work.** Un-chunked 680 → `504 FUNCTION_INVOCATION_TIMEOUT`. `limit≈150`.
- **One physical line per curl.** Multi-line `\`-continuations mangle on paste → garbled command
  → all-`null` jq output (no write happened).
- **Zeros-only + idempotent.** Re-running any chunk is harmless.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `jq: parse error: Invalid numeric literal … column 10` | Endpoint returned HTML, not JSON | Add `-w "\n[HTTP %{http_code}]\n"`; usually 401 (preview) or 504 (timeout). |
| `Authentication Required` HTML, `[HTTP 401]` | Vercel Deployment Protection on preview | Use production domain, or bypass token / Vercel MCP. |
| `504 FUNCTION_INVOCATION_TIMEOUT` | Too many per-SKU calls in one invocation | Lower `limit`, walk `nextUrl`. |
| `chunkSize:0`, `offset:null` | `parseInt`→NaN param parse | Fixed in `75e6ac5`; ensure deploy is current. |
| All fields `null` in jq output | Mangled multi-line curl; no request sent | One physical line per curl; re-run. |

---

## 9. Known gaps / follow-ups

- **Coverage vs. listing growth.** The `walmart-sync` chunks now cover offsets 0–3300.
  Periodically check `listedSkuCount` (in any `walmart-sync` response) against that ceiling; if
  listings grow past it, add another offset chunk. The reactive push + daily orphan-sweep reduce
  the urgency, but the tail must stay covered.
- **Second daily salvo (optional).** A second `walmart-sync` run later in the day would shorten
  the ~24h price/qty lag. Lower priority now that `walmart-zero` pushes zeros reactively within
  minutes.

---

## 10. Change log

| PR / commit | Change |
| --- | --- |
| #28 | `walmart-zero`, `walmart-orphan-sweep`, tail crons (offset 2700/3000). |
| `75e6ac5` | Fix `parseInt`→NaN chunking bug. |
| #123 (gci-brain) | `inventory-reconcile` (hourly) + zero-before-archive + reactive `pushWalmartZeros`. |

Initial backfill: 680/680 orphans swept, 108 live oversell vectors → 0, 372 phantom Shopify
records zeroed (108 visible + 264 in alternate SKU forms the Walmart probe couldn't see),
verified by post-sweep dry run (`liveVectorCount: 0` across all 5 pages).

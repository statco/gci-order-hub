# Walmart Oversell Incident — Handoff & Fix Brief (2026-06-20)

**Audience:** next working session (Claude Code).
**Status at handoff:** live oversell window **CLOSED and live-verified**. No known live oversell vector. Remaining work is **code, not curl** — every write-path tool exposed a defect this session, and live firefighting caused two re-arms. Do not run live inventory ops until the fixes below are in.

---

## 1. What happened (accurate timeline)

1. **Additive SKU-rename, round 2.** A Walmart catalog operation re-created bare listings alongside the old `TIRE-` ones and stamped new/duplicate listings with a flat default inventory of **100**. This created two distinct problems:
   - **Duplicate `TIRE-` listings** (orphans: no active Shopify product under the `TIRE-` form). All `TIRE-` Shopify products are archived/draft.
   - **Matched bare listings stuck at 100** — brand-new bare listings the rename created, carrying default 100 while Shopify truth is far lower (often 0).

2. **`TIRE-` duplicates were retired.** `api/walmart-retire.ts` ran (chunked, bare-twin-validated). Live evidence says this **largely worked**: catalog `Published` dropped 2822 → ~2454, audit `walmartTotal` 2822 → 2453, and a live Seller Center spot-check (`TIRE-16106NXK`) confirmed it is **gone**. (A downloaded Walmart Item Report showed only 16 RETIRED / 862 active `TIRE-`, which briefly looked like retire had failed — but that report was **stale**; live catalog contradicted it. See §4 "stale reports".)

3. **A `mode=listed` live sync was run prematurely and re-armed 360 vectors.** Running `walmart-sync?mode=listed&dry=false` pushed its own `shopifyQty` field — which for `TIRE-`/archived-matched rows is a **false 100**, not the real archived Shopify qty (5/24/48…). Confirmed: the `withQty` orphan probe jumped **0 → 360** immediately after. This is the **central bug** (§3 Fix A).

4. **Two emergency zero-sweeps closed the windows.**
   - `walmart-orphan-sweep` (zeros-only) cleared the 360 re-armed `TIRE-` orphans → probe back to 0.
   - `walmart-zero` cleared **321 matched bare listings** at 100 (the rename artifact). These were **invisible to the orphan probe** because they are *matched* (active bare Shopify) — the probe only sees orphans. Caught only by cross-referencing the Walmart Inventory Report against the Shopify export, then **confirmed live in Seller Center** (`17414NXK`, `MH196` at 100 → 0).

5. **Final verification was done against the live catalog**, not endpoint counts — after feed propagation. Spot-checks across the list (`17414NXK` early, `200E3001` mid, `TSWH15`/`TSWH04` tail) all read **0**.

---

## 2. Current state

**Closed & live-verified**
- 321 bare oversell vectors → 0 (Seller Center confirmed, post-propagation).
- `TIRE-` duplicates → retired/removed from catalog.
- Two malformed SKUs (`MB551L / MB551U`, `MH328U / MH3297`): underlying forms already 0 or not listed — no action.
- Live catalog ≈ 2370 live items, consistent with the audit.

**Open (none is a live oversell; all for this session)**
1. **~250 of the 321 are now UNDER-selling** — they have real Shopify stock (2, 34, 87…) but sit at 0 on Walmart. Lost sales until real quantities are re-pushed. **Blocked on Fix A** (the only real-qty tool, `mode=listed`, is unsafe until fixed).
2. **`mode=listed` is unsafe** — pushes false `shopifyQty` for archived/orphan-matched rows (Fix A).
3. **Monitoring blind spot** — the orphan probe / audit cannot see *matched* listings whose Walmart qty exceeds Shopify truth (Fix B).
4. **`walmart-zero` has no server-side chunking** — 321 in one call → 504; had to be split client-side (Fix C).
5. **`walmart-retire` trusts its own 200s** — worked here, but never verifies lifecycle (Fix D, hardening).

---

## 3. Fixes (priority order)

### Fix A — `mode=listed` must never push a quantity it did not source from an ACTIVE Shopify variant  *(highest priority; this caused the re-arm)*

**File:** `api/walmart-sync.ts` (the `mode=listed` path).

**Bug:** for a listed Walmart SKU whose Shopify match is **archived or draft** (all `TIRE-` products are), the endpoint's `shopifyQty` surfaces a value (observed: 100) that is **not** the real Shopify inventory (the archived product is actually 5/24/48…). On `dry=false` it pushes that 100 → oversell. Proven: a live run drove the `withQty` probe 0 → 360.

**Required behaviour:**
- Resolve each listed Walmart SKU to its Shopify product. **Only** read inventory from an **active** Shopify variant.
- If the matched Shopify product is **archived / draft / not-found / not active-ct-sync → push `0` (or skip the SKU); never push a listing-view / default-derived number.**
- The quantity pushed must be provably sourced from an active Shopify variant's real `inventory_quantity`. If it cannot be, the safe value is `0`.
- Mirror the gci-brain `inventory-reconcile` contract: inventory is decoupled from price/cost; zeros-only is always safe.

**Also investigate (suspected, not confirmed):** `mode=listed` offset 0 repeatedly returned the *same 5 `TIRE-` SKUs* with identical payloads across calls, even after retire. Determine whether `fetchListedSkus()` (shared with `mode=audit`) is **cached/stale** in the `mode=listed` path. The audit recomputed and showed those `TIRE-` gone; `mode=listed` did not. If cached, bust it so the listed set reflects current Walmart state.

**Acceptance:** a `mode=listed&dry=true` sample shows, for every row, a `shopifyQty` that equals the real active-Shopify quantity (or 0 for archived/draft), and **no row** echoes a Walmart listing-view default. A dry run over the full catalog reports `wouldPush` values that never exceed the matching active-Shopify inventory.

### Fix B — Monitoring for the matched-listing blind spot  *(this is what would have caught the 321 on day one)*

The orphan sweep/probe only inspect listings with **no active Shopify match**. The 321 bare vectors were **matched** and therefore invisible — the probe read `liveVectorCount: 0` while 321 vectors were live.

**Add a check** that compares **Walmart inventory vs Shopify truth for ALL listed SKUs** (matched included) and flags any where `walmartQty > shopifyQty`. Sources, in order of trust: live Walmart inventory API → (fallback) the Inventory Report CSV. Emit a count + sample; alert when `> 0`.

Also add the alert we already flagged: **orphan-sweep dry-run `liveVectorCount > 0` → alert** (external catalog ops can re-arm orphans silently).

### Fix C — `walmart-zero` server-side chunking  *(operational hardening)*

**File:** `api/walmart-zero.ts`. Currently accepts `{skus}` (max 1000) but processes the whole array in one invocation → **504 at ~150–321 SKUs** (each SKU is a Walmart round-trip). Add `offset`/`limit` chunking + `nextOffset`/`done` like `walmart-orphan-sweep`, so a large set can be walked without client-side splitting. Keep it zeros-only and idempotent. (Today's workaround: client-side split to ~40/chunk with `sleep`.)

### Fix D — `walmart-retire` lifecycle verification  *(hardening; not a confirmed bug)*

`retiredCount`/`done:true` reflect **accepted** DELETE calls, not confirmed retirement. Retire *appears* to have worked here (live catalog confirmed), but the endpoint should **poll item lifecycle status** (or re-query the item) and report `confirmedRetired` vs `acceptedButPending`, rather than trusting 200s. Same "accepted ≠ applied" lesson as everywhere else this session.

### Fix E — Re-push real quantities to the 321 under-sellers  *(do AFTER Fix A ships)*

The 321 are zeroed for safety but ~250 have genuine stock. Once Fix A is verified, run the corrected `mode=listed` (dry-run first, live-verify after) so these listings carry real Shopify quantities again and resume selling. Do not use the current `mode=listed` for this — it is the thing that re-armed vectors.

---

## 4. Durable lessons (runbook)

- **Accepted ≠ applied.** Every success signal in this stack reports *accepted*, not *live*: `feedResult.success` (walmart-zero), `retiredCount/done` (walmart-retire), and the orphan probe's `liveVectorCount: 0`. The **only** trustworthy confirmation is the **live Seller Center value after feed propagation**. Verify there, not on the curl response.
- **The live catalog is the authority** — above both the orphan probe *and* the downloadable Walmart reports. This session, both lied in different directions:
  - The **orphan probe** read 0 while 321 *matched* bare vectors were live (it's structurally blind to matched listings).
  - The **Walmart Item/Inventory Reports** (timestamped current) were **stale** — they showed 862 active `TIRE-` and `TIRE-16106NXK` at 100, but the live catalog showed those retired/zeroed. Treat downloaded reports as a *lagging snapshot*, not real-time truth.
- **Listing-view inventory ≠ purchasable inventory.** Seller Center display and report CSVs can show defaults (100) that aren't buyable; the fulfillment/inventory API and post-propagation live value are authoritative.
- **External catalog ops re-arm orphans.** An additive SKU-rename re-stamped old SKUs with default 100 and created matched bare-100s. Both were outside the sync's normal view. Hence Fix B's alerts.
- **Zeros-only is the safe write-path.** `walmart-zero` can only under-sell, never oversell — so it's the right emergency tool even under uncertainty. Oversell (cancellations, ODR) >> under-sell (temporary lost sales): zero first, re-push real qty after.
- **Chunk every per-SKU Walmart operation** (~40–100 depending on API latency) or hit 504. Verify with the *live value*, not the chunk's success count — a 504 mid-run leaves some SKUs accepted-but-unapplied (this happened: `TSWH15` read 100 after a chunk reported 200).
- **Secrets:** `WALMART_ZERO_SECRET` and `WALMART_RETIRE_SECRET` are distinct, both ~44 chars; length alone won't catch a mix-up. Rotate on exposure; a rotation needs a redeploy to take effect on the live deployment.

---

## 5. Suggested order of work next session

1. **Fix A** (`mode=listed` qty sourcing + cache check) — unblocks everything.
2. **Fix B** (matched-listing oversell monitor + orphan-sweep alert) — closes the blind spot that hid the 321.
3. **Fix C** (`walmart-zero` chunking) and **Fix D** (`walmart-retire` lifecycle) — hardening.
4. **Fix E** — re-push real qty to the 321 under-sellers via the corrected `mode=listed`, dry-run then live-verify.
5. Commit this file + the Shopify export (`docs/products_export_1.csv`) and the Inventory Report already in `docs/` as the incident's source data.

**Do not run any live inventory write until Fix A is merged and dry-run-verified.**

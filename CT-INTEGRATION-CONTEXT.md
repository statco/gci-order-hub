# Canada Tire (CT) Order Automation — Working Context

**Repo:** `gci-order-hub`
**Last updated:** 2026-08-06
**Status:** Client + ledger + routing all merged to `main`. `CT_AUTO_PO_ENABLED` was flipped to **`true` in Vercel production 2026-08-02** — routing now genuinely engages on real orders (`claimOrder()`, `classifyLineItems()`, real ledger rows). `CT_DRY_RUN` is still unset (default `true`), so **no real transmission to CT can happen** — but this is no longer "identical to before this work began" (see § 2, updated). **Shopify plan/PII gap (§ 10a) is now CLOSED** (2026-08-26). **§ 12 (Cowork PO-drafting tool vs. the ledger) is now CLOSED** — PR #75 merged and deployed 2026-08-26. **§ 13 adds a canary mechanism** for the first real `submitOrder()` call, since no CT sandbox exists. **✅ § 10 is now CLOSED** — the CT credential + `CT_ENVIRONMENT` fix landed 2026-08-27/28, and auth to CT's real production server was confirmed working (see § 15). **🔴 New current blocker: § 15** — the first order ever to reach `submitOrder()` (`#1011`, a dry-run rehearsal) exposed a real bug: dry-run "success" incorrectly reports as the maximum-severity `indeterminate` ("CT may have committed this for real, do not resubmit") alarm instead of `submitted (DRY RUN)`. **Do not run further dry-run rehearsals against orders with CT-recognized SKUs until this is fixed** — each one burns a real PO number and permanently locks that order out of auto-retry. **Also open: § 14** — `order-router.ts`'s direct-Shopify-order path has a stale `TIRE-` SKU-prefix filter; no orders lost yet, but only because Pat has been checking dashboards manually.

**Nothing in this repo can place a real CT order today.** See § Safety Gates.

> **Read this before touching anything CT-related.** This document is the
> hand-off record between working sessions. If you change behaviour, update it
> in the same PR.

---

## ⚠️ Documentation is not proof

This project has previously lost ~6 weeks to a fix that was *documented as
complete but never shipped*. Treat every claim below as needing verification
against live behaviour before you rely on it. Where something is unverified,
this document says so explicitly — **do not quietly upgrade those to "done".**

---

## 1. Architecture — Shopify is the hub

Two sales channels, **one** path to Canada Tire:

```
Walmart order ──► mirrored into Shopify ──┐
                                          ├──► shared routing fn ──► CT
Direct Shopify order ─────────────────────┘
```

CT is called from exactly one implementation, always keyed off a Shopify order.

### Trigger mechanism — "Option 2", decided 2026-07-27

`walmart-order-sync` mirrors the order into Shopify, then **invokes the shared
routing function in-process** (`maybeRouteToCT()`, wired 2026-07-31 — see
§ 5a). It does *not* wait for a Shopify webhook.

Rejected alternative ("Option 1"): let the mirrored order's `orders/paid`
webhook drive routing. Rejected because:

- ✅ **CONFIRMED 2026-07-31, not merely assumed.** Shopify does NOT fire
  `orders/paid` for an order created via Admin API with `financial_status`
  derived as paid from a `transactions` array (no real transaction processed
  — Walmart already collected payment). Live-tested against production
  Shopify: order id `7163049082928` created 2026-07-31T14:59:46Z, deleted
  immediately after. Vercel runtime logs for gci-order-hub
  (`prj_anvgQttOhkbESYZImTMUvV4qB8Fk`) checked over
  2026-07-31T14:58:30Z–15:05:00Z: only the two scheduled crons
  (`walmart-sync-cursor`, `ct-tracking-parser`) fired — no `orders/paid`
  request received. Independently re-checked a second time over the same
  window with the same result. Option 1 would have silently never routed a
  single Walmart order to CT.
- It adds an async hop of unpredictable latency against Walmart's 4-hour
  acknowledgment SLA.

Option 1 becomes attractive only if orders hand-created in Shopify Admin should
also route automatically. That is not a current requirement.

### Three independent duplicate-order defences

| Layer | Guarantees | Key |
|---|---|---|
| Mirror idempotency | one Walmart PO → at most one Shopify order | Walmart PO# |
| `gci-walmart-mirror` webhook guard | one router invocation per order | Shopify tag |
| `ct_orders` claim | one CT submission per Shopify order | Shopify order id |

Any one layer can fail and two remain.

### 🔴 The `gci-walmart-mirror` guard — do not "fix" this

**Tag name correction (2026-07-31):** this section previously called the tag
`walmart-import`. That name was never actually built — a repo-wide grep found
zero hits before PR #66 existed. When the real mirror shipped, it used
`gci-walmart-mirror` instead (not to be confused with `gci-walmart-sync`'s
own, unrelated `walmart-canada` tag on a different app entirely). If you're
grepping for `walmart-import` anywhere in this repo, stop — it doesn't exist
and never did.

`order-router.ts` (PR #65/#66, merged to `main` 2026-08-02) returns 200
early, without supplier routing, for any Shopify order tagged
`gci-walmart-mirror`.

**This looks like a bug and is not.** The mirror calls the routing function
*directly*; if the webhook were also allowed to route the same order, the tire
would be submitted to Canada Tire **twice against a live credit line**.

The guard's rationale inverted mid-design (it originally existed to stop a
passive bookkeeping copy from ordering at all). The code is identical either
way. Removing it causes duplicate real orders.

**Update 2026-07-31:** live-tested — the `orders/paid` webhook this guard
protects never actually fires for a mirrored order in the first place (see
Trigger Mechanism above), so today this guard is not exercised in practice.
Keep it anyway: it is zero-cost belt-and-braces against Shopify's webhook
behavior changing in the future. `ct_orders`'s own claim constraint is the
real backstop regardless.

---

## 2. Safety gates — current state

| Variable | Vercel state | Default if unset | Effect |
|---|---|---|---|
| `CT_AUTO_PO_ENABLED` | **`true`** (flipped 2026-08-02, Vercel production) | `false` | routing engages for real |
| `CT_DRY_RUN` | unset | `true` | nothing transmitted |
| `CT_ENVIRONMENT` | unset | `sandbox` | non-production realm |

`CT_DRY_RUN` requires the exact string `'false'` to transmit. Any other value,
including unset, means dry-run.

**No longer "identical to before this work began."** With `CT_AUTO_PO_ENABLED`
now `true`, any real order (Walmart-mirrored or direct Shopify) that comes in
now genuinely runs `classifyLineItems()` → `claimOrder()` → a real
`ct_orders` row with a real burned PO number → an attempted `submitOrder()`
call. `CT_DRY_RUN` intercepts that last step before anything reaches CT, so
**no real order can be placed** — that guarantee still holds — but `ct_orders`
is no longer reliably empty, and any real order since the flip should be
checked next session. Do not set `CT_DRY_RUN` or `CT_ENVIRONMENT` without an
explicit decision recorded in a PR — same rule as always, now higher-stakes
given `CT_AUTO_PO_ENABLED` is live.

---

## 3. CT API — verified facts

Verified 2026-07-27 against **production realm 8031691** via `ct-verify.mjs`.

- **OAuth 1.0a HMAC-SHA256 signing: WORKING.**
- **Base URL:** `https://8031691.restlets.api.netsuite.com/app/site/hosting/restlet.nl`
- **Sandbox realm:** `8031691_SB1` @ `8031691-sb1.restlets.api.netsuite.com`
  (credentials **not yet issued** — see § Blocked)

### 🔴 customerId is 19997, not 7329

CT's onboarding email said "credentials for customer 7329". **7329 is not a
customer id.** It is a dealer number that appears as `addrId 378931:
7329 GCI TIRES INC` under customer **19997**. The correct `CT_CUSTOMER_ID` is
`19997`, verified against catalog + address endpoints.

⚠️ This is confirmed for catalog and ship-to search. It is **not yet confirmed
for Submit Order**, which has never been called.

### Endpoints

| Purpose | script / deploy | Status |
|---|---|---|
| Product search | `customscript_item_search_rl` / `customdeploy_item_search_rl` | ✅ working |
| Ship-to search | `customscript_get_cust_addr_rl` / `customdeploy_get_cust_addr_rl` | ✅ working |
| **Submit order** | `customscript_create_sales_order_rl` / `customdeploy_create_sales_order_rl` | ⛔ **never called** |
| Update order address | `customscript_update_order_addr_rl` / `customdeploy_update_order_addr_rl` | untested |
| Wheel search | `customscript_cda_wheel_search_rl` / `customdeploycda_wheel_search_rl` | untested |

### 🔴 HTTP 200 does not mean success

CT returns 200 on failure. You **must** check `body.success` (boolean) and
`error.code`. Any code treating 200 as success is wrong.

### 🔴 Warehouse names — the V1.4 guide's examples are WRONG

Live, case-sensitive, actual API values:

```
Toronto, ON | Montreal, QC | Sherbrooke, QC | Levis, QC
Dartmouth, NS | Moncton, NB | Mount Pearl, NFLD
```

The integration guide's examples reference **Valleyfield**, **Mississauga**, and
a bare **Sherbrooke** — none of which exist in the live API. Earlier code used
those names and would have failed. Trust the live API, not the guide.

### Reference part — 200E1059

Cost **$97.50** (matches a manual PO), MSRP **$125.00**.
Stock at verification: Toronto 1, Montreal 7, Mount Pearl 11, **all others 0**.

**Stock is thin.** Insufficient stock is a *routine outcome*, not an error
condition — design for it. See § Error mapping.

### Ship-to addresses on file

| addrId | Description |
|---|---|
| 348674 | GCI HQ |
| 378931 | `7329 GCI TIRES INC` (dealer) |
| 525820 | Coquitlam BC — past customer |
| 536338 | Toronto ON — past customer |

---

## 4. SKU classification

Shopify and Walmart SKUs are **mixed**:
- some carry a legacy `TIRE-` prefix — `TIRE-166028008`
- some are bare CT part numbers — `200E1059`

**CT part numbers follow no discernible pattern.** Prefix matching cannot
classify them. Catalog validation via `classifyLineItems()` is the only source
of truth. After stripping the optional `TIRE-` prefix, the remainder is the CT
`partNumber` (verified: `TIRE-166028008` → `166028008`).

**Exclude:** `INSTALL-FEE-20`, `-25`, `-30`, `-35` (prefix `INSTALL-FEE-`) —
already handled inside `classifyLineItems()`.

**No brand exclusions needed.** Michelin / Toyo / Goodyear are archived in
Shopify. Pirelli is active and CT carries it.

`unknownItems` must be surfaced to Telegram — **never silently dropped.**

---

## 5. What is merged

### PR #47 — `api/lib/ct-client.ts` (2026-07-27)

Full replacement implementing the real V1.4 contract, replacing a guessed
payload shape.

Backward-compatible exports (unchanged names/signatures so `order-router.ts`
did not need touching): `submitPurchaseOrder`, `CTNotConfiguredError`,
`CT_AUTO_PO_ENABLED`.

New: `submitOrder()`, `searchProducts()`, `findPart()`, `getShipToAddresses()`,
`updateOrderAddress()`, `healthCheck()`, `classifyLineItems()`,
`normalizePartNumber()`, `isCandidateForCT()`, `resolveLocation()`,
`normalizeProvince()`, `normalizeCountry()`.

Also: province-aware routing via `PROVINCE_ROUTING` (correct live location
names); `CTInsufficientStockError` carries a `detail` field;
`validateShipping()` throws on empty address fields; `CT_CUSTOMER_ID` defaults
to 19997 with a warning when not explicitly set. `tsc --noEmit` passes.

### PR #48 — `ct_orders` idempotency ledger (2026-07-27)

- `supabase/migrations/20260727_ct_orders_ledger.sql` — **applied**
- `api/lib/ct-order-ledger.ts`

`public.ct_orders`: 22 columns, 5 constraints (pk, `po_number` UNIQUE,
`(source_channel, source_order_id)` UNIQUE, 2 CHECKs), RLS on with 0 policies,
`updated_at` trigger.

States: `claimed` → `submitted` | `indeterminate` | `failed` |
`manual_required` | `cancelled`.

`claimOrder()` uses a **bare INSERT**, not select-then-insert, and relies on the
unique constraint to resolve races.

`buildPoNumber()`: originally Shopify → `GCI-S-<orderNumber>`, Walmart →
`GCI-W-<purchaseOrderId>`, manual → throws (must be passed explicitly).
**Superseded** — see the canonical-PO-number-format PR below: CT never
recognised the `GCI-S-`/`GCI-W-` shape. Both channels now go through
`GCI-<year>-<seq>`, same as the rest of this section describes.

31 unit tests pass — all pure functions, no CT or Supabase calls.

### Canonical PO number format (2026-07-29)

- `supabase/migrations/20260729_ct_po_number_seq.sql` — checked in, **not yet
  applied** to the live Supabase project (see PR description)
- `api/lib/ct-order-ledger.ts`, `api/ct-tracking-parser.ts`

CT only ever recognises one PO number shape: `GCI-<year>-<seq>` (e.g.
`GCI-2026-447267`, `GCI-2026-447269`), the same shape its staff already use
for manually-issued POs. `buildPoNumber()` now emits exactly that for BOTH
`shopify` and `walmart` — channel is not encoded in the PO number, it lives
in `ct_orders.source_channel`, which is the reconciliation join key. The
`<seq>` portion comes from a new Postgres sequence, `ct_po_number_seq`,
seeded at 447300 (manual POs were at 447267/447269 as of this PR) and
fetched atomically via a `ct_next_po_seq()` PostgREST RPC — `buildPoNumber()`
is now async and non-deterministic per call (each call burns a sequence
slot), which is fine: the double-submission guard was always
`claimOrder()`'s INSERT racing the `ct_orders_source_unique` constraint, not
determinism of the PO number itself. The sequence never resets at year
rollover.

`api/ct-tracking-parser.ts`'s invoice-PO regex (`parseInvoicePdf()`) could
not previously match this shape at all — it required digits immediately
after 2-4 letters, so it hit the literal hyphen in `GCI-2026-447269` and
capped at 6 digits. Both the canonical shape and the older `GCI0003`-style
legacy shape (still present in CT invoice history) are now matched, built
from the same `CANONICAL_PO_NUMBER_SHAPE` constant `buildPoNumber()` uses, so
producer and consumer cannot silently drift apart again.

**Known gap, not fixed by this PR:** `order-router.ts`'s dormant
`CT_AUTO_PO_ENABLED` branch calls `submitPurchaseOrder()` →
`submitOrder({ poNumber: po.gciOrderNumber, ... })` directly, bypassing
`claimOrder()`/`buildPoNumber()` entirely — it would send CT the raw Shopify
order name (e.g. `#1042`), not a canonical PO number, if that gate were ever
flipped on. `CT_AUTO_PO_ENABLED` is unset today so this path is unreachable.
**Fixed 2026-07-31** by PR #65 (`api/lib/ct-order-routing.ts`'s
`routeOrderToCT()`), which replaces this dormant branch entirely — see § 5a.
PR #65 is currently draft, not yet merged to `main`.

---

## 5a. Merged — PR #65 and #66 (2026-08-02)

Both merged to `main`. `CT_AUTO_PO_ENABLED` remains unset, so this changes
what the code *can* do, not what it *does* — no behavior change on `main`
until that gate is explicitly flipped. See § 11 for what's actually left
before flipping it.

### PR #65 — CT order routing (Shopify path)

`api/lib/ct-order-routing.ts`: `routeOrderToCT()` — single shared function,
`classifyLineItems()` → `claimOrder()` → `submitOrder()`, full error mapping
per § 8. Replaces `order-router.ts`'s dormant, ledger-bypassing
`CT_AUTO_PO_ENABLED` branch entirely (see § 5's canonical-PO-number entry).

`ship_to_installer` is refused **before** `claimOrder()`/`classifyLineItems()`
run — the § 9 open bug ("empty address fields") is fixed by refusing auto-PO
on that branch and routing to manual notify, not by populating the fields
(installer drop-ship stays out of scope). Column N (`po_number`) is written
only on a confirmed `markSubmitted` outcome.

Wired only to the existing `orders/paid` webhook at this point — real
Shopify-checkout orders. `walmart-order-sync.ts` untouched by this PR.

### PR #66 (stacked on #65) — Walmart mirror

New table `walmart_shopify_mirror` (migration checked in, applied live —
see § 11). Guard tag `gci-walmart-mirror` (see the guard section above — not
`walmart-import`). Mirrors a Walmart order into Shopify
(`financial_status: paid` via a `transactions` array, no Customer record, no
retry on timeout/5xx — same reasoning as `submitOrder()`, see the "NEVER
BLIND-RETRY" header comment in `walmart-shopify-mirror.ts`). Mirror is
CRITICAL PATH per § 7 — failure alerts loudly and leaves the order for the
next cron run to retry.

`maybeRouteToCT()` (`api/walmart-order-sync.ts`) calls `routeOrderToCT()`
**synchronously, in-process, immediately after a successful mirror** —
extracted into a named, injectable function specifically so this gate has
real test coverage (`api/tests/walmart-order-sync.unit.test.ts`, 2
assertions, mutation-tested: both pass/fail correctly under an
inverted-gate mutation). This is the mechanism the Trigger Mechanism section
above describes — it does not depend on any webhook, which is exactly what
the live `orders/paid` test confirmed is necessary.

### Both merge-gate decisions resolved (2026-08-02)

1. **Inventory decrement on mirrored orders — Option C, no new code.**
   `gci-brain/api/shopifySync.ts` already runs an hourly (`0 * * * *`,
   confirmed live in `vercel.json`) `inventory-reconcile` cron that
   overwrites Shopify's stock with CT's real live quantity, and every synced
   variant carries `inventory_policy: 'deny'` — Shopify itself refuses to
   oversell once a SKU hits 0, it isn't just a stale display number. On top
   of that, `routeOrderToCT()` → `submitOrder()` checks CT's live stock at
   the moment of submission regardless of what Shopify shows; a race just
   produces the already-routine `CTInsufficientStockError` → manual-required
   outcome (§ 8), never a real oversell. A second decrement writer in
   `gci-order-hub` would only reduce how often that routine outcome fires,
   in exchange for a second inventory writer fighting the hourly
   authoritative one in a file explicitly marked "do not touch, live catalog
   integration" (§ 11). Decided not worth it. Revisit only if live data
   later shows manual-required firing often enough to be a real drag — that
   would be a "the numbers say so" call, not a pre-launch one.

   **🔴 Correction, 2026-08-13 (gci-brain#139, merged):** "CT's real live
   quantity" above was wrong in a way that mattered. `inventory-reconcile`
   was writing `getTotalQty(ct)` — the **sum across all 7 CT warehouses** —
   to Shopify. But `resolveLocation()` (this file, § above) requires **one**
   warehouse to cover the whole order; CT's Submit Order API can't
   split-ship. So a SKU with 1 unit in Toronto + 1 in Montreal read as "2 in
   stock" in Shopify — `inventory_policy: 'deny'` never triggers, because
   Shopify genuinely (if wrongly) believes 2 are available — while
   `resolveLocation()` would reject a real 2-unit order with
   `CTInsufficientStockError`. This is a real oversell path, not just a
   routine manual-required outcome: the customer's order is accepted by
   Shopify at checkout time, then fails downstream. **Confirmed live
   incident**: Ovation Vi-682 155/80R12 (SKU `200E2108`), 2026-08-12 — order
   for 2x accepted, CT could only fulfill 1x from any single warehouse;
   order manually cancelled and re-placed for 1x with customer's agreement.
   Fixed by `getMaxLocationQty()` — max quantity at any single warehouse,
   the true ceiling `resolveLocation()` can ever fulfill in one order for
   any province (every `PROVINCE_ROUTING` list falls back across all 7
   locations). The rest of this decision's reasoning still holds — a second
   decrement writer in `gci-order-hub` remains unnecessary — but "Shopify
   itself refuses to oversell once a SKU hits 0" was never the actual
   backstop for this failure mode; the fix above is.

   **Addendum, same day:** the first fix (gci-brain#139) only patched
   `inventory-reconcile`'s own target-qty formula. Three other live
   Shopify inventory-write paths in `gci-brain/api/shopifySync.ts` still
   called `setInventory(..., getTotalQty(ct))` — `syncOneProduct()`
   (regular catalog updates, 3 call sites), new-product creation, and the
   `retry-create` admin action — so any of those running after the hourly
   reconcile would have silently re-inflated a split-stock SKU right back
   to the national sum. Caught by Codex's automated review on #139, not
   by live testing. Closed in gci-brain#140 (merged 2026-08-13) — all
   four write sites now use `getMaxLocationQty()`. As of #140, believed
   complete across every Shopify inventory-write path; not yet
   live-verified against real data.
2. **QST marketplace-facilitator status for Quebec — confirmed.** Walmart's
   own bi-weekly payout statement for a real Quebec-bound sale ($187.99
   product price) showed `Net tax collected: $0.00` and
   `Other taxes (fee): $0.00` — Walmart holds 100% of tax collection and
   remittance and never passes it through the seller payout, same
   marketplace-facilitator behavior already confirmed for GST/HST. No
   further check needed before routing Quebec Walmart orders through the
   mirror.

`walmart_shopify_mirror` migration is now applied and independently
verified live on `enhbckomwdelktdhnuzq` — the only Supabase project on the
account. There was briefly a second, empty duplicate project
(`gqaylwkfiokwsccibvxg`) visible via `list_projects` — created 2026-07-29,
zero tables, a leftover shell from an earlier, never-executed plan to move
gci-order-hub onto its own dedicated project. Confirmed via a direct
before/after: `list_projects` showed two projects, Pat deleted the empty
one from the Supabase dashboard, `list_projects` immediately after showed
exactly one remaining (`enhbckomwdelktdhnuzq`). That backlog item (moving
off the shared project) is now moot — if it's ever wanted again, it would
need a fresh project, not a resume of this one.

`walmart_shopify_mirror` itself: 13 columns matching
`walmart-shopify-mirror.ts` exactly, PK on `walmart_po`, CHECK constraint
on the 4-value status enum, RLS enabled with 0 policies (same deliberate
service-role-only pattern as `ct_orders`, `walmart_order_alerts`,
`walmart_sync_cursor`, `xero_tokens`, `price_monitor_snapshots`,
`chatbot_customers`, `chatbot_conversations`), 0 rows. Security advisor's
`rls_enabled_no_policy` (INFO) flag on it is expected and correct, not a
gap — same as `ct_orders` already showed before this. A pre-existing,
unrelated advisor WARN (`walmart_shopify_mirror_touch_updated_at`'s
mutable `search_path`) mirrors `ct_orders_touch_updated_at`'s identical
existing pattern — not a new issue, no action taken.

---

## 6. 🔴 Known verification gaps

**These are the highest-risk items in this document.**

1. ✅ **CLOSED 2026-07-31.** `claimOrder()` proven against real Supabase
   (project enhbckomwdelktdhnuzq). 5 concurrent calls via
   scratchpad/ledger-race-test.mjs → exactly 1 claimed:true, 4 clean
   claimed:false, 0 thrown exceptions. Row count verified independently
   post-cleanup: 0. PostgREST's 409 on unique-constraint conflict is
   correctly translated into claimed:false by the real code path, not
   just by DB-level inspection. No longer blocks CT_DRY_RUN=false.
2. **`ct_orders` is empty; the ledger is merged, not yet live.**
   `claimOrder()`/`buildPoNumber()` are now called from `routeOrderToCT()`
   (PR #65) and, for the mirror path, from `maybeRouteToCT()` (PR #66) — see
   § 5a. Both merged to `main` 2026-08-02. `CT_AUTO_PO_ENABLED` is still
   unset, so the ledger remains unexercised in production until that gate
   is explicitly flipped on — see § 11 for what's left before that.
3. **Submit Order has never been called** in any environment.
   `customerId 19997` is unconfirmed for that endpoint specifically.
4. ✅ **CLOSED 2026-07-31 (partially — see caveat).** `orders/paid` confirmed
   NOT to fire for an Admin-API-created paid order (live test, order id
   `7163049082928` — full evidence in the Trigger Mechanism section, § 1).
   Independently re-confirmed by a second check of the same Vercel log
   window. **Caveat: `orders/create` was not tested** — only `orders/paid`
   was checked, since that's the only webhook this repo currently listens
   for. If a future need arises to know whether `orders/create` fires too,
   that is still open. The `gci-walmart-mirror` guard (§ 1) is confirmed
   currently non-load-bearing for this specific path, but is kept regardless
   as zero-cost defense against Shopify's behavior changing.
5. ✅ **CLOSED 2026-07-31.** `scratchpad/ledger-race-test.mjs` rebuilt and
   committed (PR #63). Compiles the real ct-order-ledger.ts via tsc rather
   than reimplementing it; self-cleaning; documented recompile step if the
   source changes. See item 1 for the run result.

---

## 7. Walmart channel

### Telegram will fire for a Walmart order once CT_AUTO_PO_ENABLED flips on

Was an **unbuilt feature, not a regression**, through 2026-07-30. **Built and
merged (PR #66)** as of 2026-08-02 — notification is wired into the mirror
flow described in § 5a. Still won't fire in production until
`CT_AUTO_PO_ENABLED` is set — see § 11.

`/api/walmart-order-sync` runs every 15 min (96 runs/24h, zero errors over 7
days). `/api/ct-tracking-parser` runs 48×/day, zero errors — **its actual
behaviour is not yet documented and contradicts an earlier assumption that
tracking was fully manual. Read it before assuming anything.**

### Known missed order

Walmart PO# `309120965612142`, order# `600000112174518`, 2026-07-26,
SKU `200E1059`, $194.99, Acknowledged/Unshipped, ship-by 07/27,
deliver-by 07/30. Found by manually checking the dashboard. Acknowledged
manually. Nothing alerted.

### New-seller payment hold (noted 2026-08-02)

Walmart's bi-weekly payout statements can show a `Seller Payment hold` —
seen on the Jun 20–Jul 4, 2026 statement (`Amount on Hold: $0.00`,
`Released amount: $629.37` for that period, i.e. a prior hold being
released, not a new one). This is a standard new-seller review hold, not an
account or integration problem — releases automatically once the account
hits $1,000+ in payments or 90 days, whichever comes first. Don't mistake
it for a real issue if it shows up on a future statement; confirm current
status in Seller Center if it ever needs a real answer.

### Supabase key rotation outage (2026-08-04 to 2026-08-05)

`SUPABASE_SERVICE_ROLE_KEY` was rotated in Supabase but the new value
wasn't picked up in Vercel production until an explicit redeploy was
triggered — updating the env var alone does not restart already-running
serverless functions. Result: every Supabase write from this repo
(`walmart_sync_cursor`, `walmart_shopify_mirror`, `walmart_order_alerts`)
failed with `401 Unregistered API key` for ~26 hours
(`2026-08-04T16:44:11Z` to `2026-08-05T18:34:35Z`, confirmed via
`get_runtime_errors` — 717 occurrences on `/api/walmart-sync-cursor`
alone). Cursor tracking, mirroring, and alerting were all silently dead
for the whole window; at least one real Walmart order
(`309121867847467`) had to be processed manually as a result, caught only
because the repeated failure alert was noticed in Telegram.

Fixed by: rotating the key (again, to a value both sides agree on),
updating Vercel, and triggering an explicit redeploy. Confirmed resolved
by: zero new `Unregistered API key` errors in the 15 minutes following the
redeploy, and the next real order (`309121867847467` → Shopify `#1009`)
mirroring clean on the first attempt (`walmart_shopify_mirror.attempt_count
= 1`, `error_name = null`).

**No monitoring exists to catch this automatically.** This was caught by a
human noticing repeated Telegram failure alerts, not by any alerting on
the underlying error rate. Worth considering: an alert on sustained
Supabase write failures specifically, independent of any one order's
retry alert, so a credential-level outage like this doesn't require a
human to notice a pattern across multiple messages.

### Heartbeat now counts new orders, not raw fetch count (2026-08-06)

`recordRunAndMaybeHeartbeat()` (`api/lib/sync-heartbeat.ts`, called from
`/api/walmart-order-sync`) previously received the raw count of orders
returned by `fetchRecentOrders()` for the rolling lookback window — which
re-includes every order still inside that window on every run (96
runs/day), not genuinely new ones. Fixed (gci-order-hub#72) to pass
`newOrders.length` (post-Sheet-dedup) instead, matching what a human means
by "orders seen today."

**Trade-off, deliberate, not yet resolved either way:** the heartbeat call
was originally placed before any downstream call specifically so a broken
alert/ack/Sheet step could never suppress the "sync is alive" signal.
Computing `newOrders` requires the Google Sheet lookup, which now runs
before the heartbeat call — so the heartbeat is no longer fully
independent of a Sheet outage. A Sheet-lookup failure still isn't silent
(it throws up to the handler's outer catch, which sends its own
`walmart-order-sync ERROR` Telegram alert) but that run's count won't land
in the heartbeat's 24h accumulator.

**Open, not decided:** whether a second, Sheet-independent "did the
Walmart API respond at all" counter is still wanted alongside this one,
now that the heartbeat's guarantee is narrower than the original design.
Nobody has asked for it yet; flagged in code comments at both the call
site (`api/walmart-order-sync.ts`) and `sync-heartbeat.ts`'s JSDoc if it
comes up later.

### Decisions taken 2026-07-27

- **Auto-acknowledge on Walmart.** Previously manual. Walmart expects
  acknowledgment within 4 hours and scores sellers on it. This is a *write* —
  must be idempotent, must never double-acknowledge, must be logged. Its
  failure must never block notification or mirroring.
- **Mirror into Shopify is CRITICAL PATH, not best-effort.** Under the hub
  architecture a failed mirror means the order never reaches CT and never
  ships. On failure: loud Telegram alert naming the Walmart PO#, leave the
  order unmarked so the next cron run retries.
- **PO numbering** — **superseded 2026-07-29**: this originally said PO
  numbering stays `GCI-W-<walmartPO>` for Walmart-origin orders so CT
  invoices reconcile against Walmart payouts. CT never actually recognised
  that shape; reconciliation instead uses `ct_orders.source_channel` plus the
  Walmart PO# stored as metadata (both channels now share the single
  `GCI-<year>-<seq>` PO number format — see the canonical PO number format
  entry under §5).
- **Ledger keys on the Shopify order id for BOTH channels** (Shopify is the
  hub). The Walmart PO# rides along as metadata; `source_channel` is retained
  for reporting.

### Walmart marketing-data restriction

Mirrored orders must set `send_receipt:false` and
`send_fulfillment_receipt:false`, and must **not** create a Shopify Customer
record. Walmart's Marketplace agreement restricts using their customer data for
marketing. This is a compliance constraint, not a preference.

### Telegram alert contents (agreed)

Walmart PO#, Walmart order#, resulting Shopify order#, SKU + qty, customer
city/province, **ship-by and deliver-by dates**, revenue, CT cost, chosen CT
warehouse, stock status, and either `✅ CT order SO###### placed` or
`⚠️ manual PO required — <reason>`.

### 🔴 `gci-walmart-sync` is NOT this pipeline

`gci-walmart-sync` is a **separate commercial Shopify app**, intentionally in
test mode against `gci-walmart-test.myshopify.com`. It has nothing to do with
GCI's own Walmart orders. Ignore it entirely when working on this.

**Historical note (found 2026-07-31):** gci-walmart-sync's mirror code did
fire for real exactly once, 2026-06-26 (shadowMode: false at the time),
creating Shopify order `gid://shopify/Order/4651989270577` for a genuine GCI
Walmart order (`600000100319395`, Aasiyah Haq, Toronto ON, PO GCI0004).
Already shipped and logged in the Sheet — not a live incident, nothing to
action. gci-walmart-sync has since added a shadow-mode row
(`docs/SHADOW-MODE.md`) that captures real orders for comparison without
creating Shopify orders or acknowledging on Walmart.

---

## 8. Error mapping (to implement)

| Outcome | Ledger action | Notes |
|---|---|---|
| success | `markSubmitted` | |
| `CTInsufficientStockError` | `markManualRequired` | **Routine, not an error.** Telegram with per-location stock detail, return 200. Expect this often — stock is thin. |
| `CTValidationError` | `markFailed` | Safe to fix and resubmit |
| `CTAuthError` | `markFailed` | |
| `CTServerError` / timeout | `markIndeterminate` | 🔴 **LOUD alert. NEVER auto-retry.** CT may have committed the order. |

---

## 9. Open bugs

- **`order-router.ts` `ship_to_installer` branch** sends empty
  `address1`/`city`/`province`/`postalCode`. Since PR #47 this throws
  `CTValidationError` when auto-PO is attempted. **Fixed by PR #65, merged
  2026-08-02** — explicitly refuses auto-PO on that branch, confirmed
  refused **before** `classifyLineItems()`/`claimOrder()` run, routes to
  manual notify. Installer drop-ship remains deferred until a real installer
  list exists — the fields themselves are still never populated.
- **~10 Walmart SKUs** get a persistent 400 "Data error" on price/inventory
  updates via `/api/walmart-sync-cursor` (43 error groups; also transient
  520s). Likely invalid or delisted SKUs. **Separate issue from order sync** —
  do not conflate.

---

## 10. Environment variables

**🔴 CONFIRMED WRONG 2026-08-27 — the five `CT_*` credential rows below are
NOT actually set in `gci-order-hub`'s Vercel project.** Live-verified via
`admin-canary-ct-order.ts` against real order `#1003`:
`assertConfigured()` (which checks the fully-resolved value *after* the
sandbox→production fallback in `creds()`) reported all five as missing —
`CT_CONSUMER_KEY`, `CT_CONSUMER_SECRET`, `CT_TOKEN_ID`, `CT_TOKEN_SECRET`,
`CT_CUSTOMER_API_TOKEN`. **Root cause found: they were set in the `gci-brain`
Vercel project instead.** `gci-brain` and `gci-order-hub` are separate Vercel
projects with fully isolated env vars — nothing copies between them
automatically. This has presumably been the REAL reason every real order's
CT routing has returned `not_configured` all along — not (only) the pending
sandbox creds from the CT rep.

**Fix (not yet done — needs Pat, no tool access to copy Vercel env vars):**
copy all five `CT_*` credential values from `gci-brain`'s Production env vars
into `gci-order-hub`'s Production env vars, then redeploy `gci-order-hub`
(env var changes require an explicit redeploy — see the 🔴 callout below).
After that, re-run the `admin-canary-ct-order.ts` rehearsal against `#1003`
again to confirm `classifyLineItems()` now succeeds instead of returning
`not_configured`.

The table below is kept as originally written for historical record, but
treat the "set in Vercel" notes as **aspirational until re-verified**, not
current fact — this is now the second time this doc has stated something
about Vercel config that live testing contradicted (see § 10a for the
first). Live re-verification via a real call, not doc text, is now the
standard for anything credential-related in this file.

| Variable | Value / default | Notes |
|---|---|---|
| `CT_CONSUMER_KEY` | ❌ confirmed NOT in `gci-order-hub` (was in `gci-brain`) | |
| `CT_CONSUMER_SECRET` | ❌ confirmed NOT in `gci-order-hub` (was in `gci-brain`) | |
| `CT_TOKEN_ID` | ❌ confirmed NOT in `gci-order-hub` (was in `gci-brain`) | |
| `CT_TOKEN_SECRET` | ❌ confirmed NOT in `gci-order-hub` (was in `gci-brain`) | |
| `CT_CUSTOMER_API_TOKEN` | ❌ confirmed NOT in `gci-order-hub` (was in `gci-brain`) | the `d!U3^…` value; pairs with 19997 |
| `CT_CUSTOMER_ID` | `19997` | defaults to 19997 with warning if unset |
| `CT_ENVIRONMENT` | default `sandbox` | `production` to activate |
| `CT_AUTO_PO_ENABLED` | **`true`** (set 2026-08-02) | routing is live for real orders |
| `CT_DRY_RUN` | default `true` | must be exact string `'false'` to transmit |
| `CT_ACCOUNT_ID_PROD` | `8031691` | |
| `CT_ACCOUNT_ID_SANDBOX` | `8031691_SB1` | |
| `CT_LOCATION_PREFERENCE` | optional | comma-separated warehouse order override |
| `CT_FORCE_LOCATION` | optional | force a specific warehouse |
| `CT_ORDER_EMAIL` | | fallback contact |
| `CT_ORDER_PHONE` | | fallback contact |
| `CT_TIMEOUT_MS` | `30000` | |
| `SUPABASE_URL` | `https://enhbckomwdelktdhnuzq.supabase.co` | |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard | **never commit** |

Supabase project `enhbckomwdelktdhnuzq` (ca-central-1) is shared across repos.

**🔴 Any change to an env var in Vercel requires an explicit redeploy to
take effect on already-running serverless functions — saving the value in
Vercel's dashboard alone does nothing until something redeploys.** This
has caused real confusion twice in one night: once with `CT_AUTO_PO_ENABLED`
(§ 2) and once with `SUPABASE_SERVICE_ROLE_KEY` (§ 7, "Supabase key
rotation outage") causing a ~26-hour silent outage. After changing any env
var here, always trigger an explicit redeploy and verify via
`get_runtime_errors` or equivalent — do not assume the new value is live
just because Vercel shows it saved.

---

## 10a. ✅ CLOSED 2026-08-26 — Shopify plan/PII access gap (discovered 2026-08-02)

**Confirmed closed via live re-verification, following the exact steps this
section laid out.** Store confirmed on the Grow plan (GraphQL
`shop.plan.displayName` → `"Shopify"`, the current name for the Grow tier — no
`partnerDevelopment`/`shopifyPlus` flags). A direct Admin GraphQL read of a
real order (`#1014`) returned full, unredacted PII —
`shippingAddress { firstName lastName address1 city province zip }` all
populated (David M., Mississauga ON) — no `ACCESS_DENIED`, no stripped fields.
This is the same query shape that returned redacted data on 2026-08-02.

**Not yet done from the original step list:** admin API token regeneration
(step 2) — worth doing per the original caution about plan-upgrade-without-
token-rotation, even though the live read above already succeeded without it.
The webhook-payload PII question (whether Shopify can also redact fields
inside a webhook delivery, as opposed to Admin API reads) also remains
formally untested — no real webhook-driven checkout order's `ct_orders` row
has been inspected yet, since `ct_orders` is still empty (see § 12, a
separate, unrelated reason for that).

**Original text below, kept for the historical record:**

**This is the current top blocker. Do not flip `CT_DRY_RUN` until this is
closed and re-verified.**

### What was found

Store is on Shopify **Basic** plan (confirmed live via GraphQL
`shop.plan.displayName`). Basic plan lacks API access to customer PII
(name, address, phone) — confirmed on the real, unmodified, merged
`mirrorWalmartOrderToShopify()`, not just by analogy to manual testing:

- The function's real request payload (captured in
  `walmart_shopify_mirror.request_payload`) correctly included full
  synthetic PII.
- Shopify's own create-response (captured in
  `walmart_shopify_mirror.response_payload`) had stripped it down to
  `country`/`province`/`country_code`/`province_code` only.
- A subsequent independent GraphQL read of the same order returned explicit
  `ACCESS_DENIED`: *"This app is not approved to access the Customer
  object. Access to personally identifiable information (PII)... is only
  available on Shopify, Advanced, and Plus plans."*

Test order (`#1008`, `7169661075504`) and its ledger row were deleted after
capturing this evidence. Confirmed via `list_tables`/`execute_sql`
post-cleanup: 0 rows.

### What was confirmed NOT affected — both real production paths, verified via code

**Walmart mirror path:** `maybeRouteToCT()` builds its CT `shipTo` fields
from `order.shippingInfo.postalAddress` — the original Walmart API data,
held in memory — never re-reads the address back from Shopify. Not exposed
to this issue regardless of plan/approval status.

**Direct Shopify order path:** `order-router.ts`'s `orders/paid` webhook
handler builds `shipTo` directly from the parsed webhook POST body
(`order.shipping_address`/`billing_address`) — HMAC-verified against that
same raw body, zero outbound `fetch()` calls anywhere in the file. Never
re-reads via API either.

**The one genuinely open question, confirmed unverified by two independent
sources (Claude Code's code read AND a separately-consulted Shopify AI
agent both said the same thing: don't assume):** whether Shopify's PII
restriction can also redact fields **inside the webhook payload itself**
before delivery, as opposed to only Admin API reads/writes. Nothing tested
tonight exercised a real webhook delivery — only Admin API create + GraphQL
read. Next real Shopify checkout order's `ct_orders.request_payload` will
answer this for free, no test needed — check it next session if one has
come in.

### Plan question — Grow, not Advanced, is very likely sufficient, but not yet empirically confirmed

Shopify renamed its mid-tier "Shopify" plan to **"Grow"** in early 2026 —
same plan, same price, new name (multiple independent sources confirm
this). So *"available on Shopify, Advanced, and Plus plans"* in the error
message means Grow ($79 USD/mo) should qualify, not the $299/mo Advanced
tier. Confirmed against Shopify's own Help Center, verbatim:
*"To access Custom Level 2 PII apps, your store must be on the Grow plan or
higher... If you sign up for or downgrade your plan to either the Basic
plan or the Starter plan, then you won't have access."*
(`help.shopify.com/en/manual/apps/app-types/custom-apps`)

**Caveat, found independently, not from either AI source consulted
tonight:** a Shopify community thread describes a developer whose custom
app worked fine across multiple Basic-plan stores for nearly a year, then
hit this exact same error on one new store despite identical permissions —
suggesting plan tier alone hasn't reliably been the whole story for every
custom app. **Do not treat the plan upgrade as a guaranteed fix without
re-testing after.**

### Decided path forward (Pat, 2026-08-02) — holding until plan change made

1. Upgrade store to **Grow** ($79/mo) — not Advanced.
2. After upgrading: regenerate the Admin API access token (Settings → Apps
   and sales channels → Develop apps → the custom app → API credentials).
   A Shopify AI agent flagged this as commonly missed — plan upgrade alone,
   without token rotation, is a known reason merchants still see PII
   redacted immediately after upgrading. Unverified independently, but
   cheap to just do regardless.
3. Re-test with a **direct GraphQL read** against an existing order (`#1003`
   or `#1008`'s replacement) — same query used tonight
   (`shippingAddress { firstName lastName address1 city province zip
   phone }`). If it comes back full, this gap is closed. If not, escalate
   to Shopify Support directly with this store's specifics — don't guess a
   second time.
4. Only after that: consider whether the webhook-payload question (above)
   still needs separate verification, or whether the plan fix + a genuine
   incoming order settles both at once.

**Session paused here at Pat's request pending the plan change — resume
from step 2 above once upgraded.**

---

## 11. Where this left off — 2026-08-02

### The real state, in order of what actually happened tonight

1. PR #65 and #66 merged, both merge-gate decisions resolved, migration
   applied live — see § 5a.
2. `CT_AUTO_PO_ENABLED` flipped to `true` in Vercel production — see § 2.
3. Attempted to capture a real CT dry-run payload → discovered the PII
   access gap along the way — see **§ 10a, now the actual blocker.**

### Left to do — supersedes anything below that assumed § 10a didn't exist

Everything here is gated on § 10a closing first:

- **Upgrade to Grow, rotate token, re-verify via direct GraphQL read** —
  § 10a steps 1-3. This is genuinely the next action, nothing else should
  happen before it.
- **Once § 10a is closed:** check whether any real order has landed in
  `ct_orders` since `CT_AUTO_PO_ENABLED` went live tonight — it may no
  longer be empty. Review any such row before assuming everything's fine.
- **CT sandbox credentials** — still pending from the CT rep, requested
  2026-07-27, unrelated to § 10a. `submitOrder()` has never been called in
  any environment; `customerId 19997` unconfirmed for that endpoint
  specifically.
- **First `CT_DRY_RUN=false` call is untested territory regardless of § 10a
  being resolved.** Everything to date, including the 2026-08-02 manual PO
  `GCI-2026-447270`, has been manual.

### Standing questions to CT rep

- ✅ Credit line active — confirmed
- ✅ Blind drop-ship configured account-level — confirmed
- ⏳ Sandbox credentials — pending
- ⏳ Confirm `customerId 19997` is correct for **Submit Order** specifically

### Do not touch

- `gci-brain/api/shopifySync.ts` — live catalog integration.
- `gci-walmart-sync` — unrelated commercial app in intentional test mode.

---

## 12. 🔴 A second, separate PO-drafting path exists — not in this repo, not in the ledger

**Discovered 2026-08-26, via a Vercel/Supabase audit that found real orders with
no corresponding `ct_orders` row.** Do not assume `ct_orders` is a complete
record of every PO placed with CT — it isn't.

Pat built a standalone Claude Cowork automation (no repo — lives outside all
six `statco` projects) that **drafts a preview PO** for review. It:

- Runs **only on manual trigger**, not on a schedule or webhook.
- **Never sends anything to CT itself** — output is a draft for Pat to review.
- **Does not read or write Supabase** — has zero visibility into `ct_orders`,
  `walmart_shopify_mirror`, or any claim/idempotency mechanism this repo relies
  on, and vice versa: this repo has zero visibility into it.
- After Pat reviews a draft, **he sends the PO to CT manually** (email/portal).
  The Shopify order is then tagged `po-drafted` (alongside the existing
  `gci-walmart-mirror` tag where applicable) — confirmed on real orders
  including `#1013`, `#1014`.

**Why it exists:** built as a stopgap to semi-automate PO drafting while
waiting on the Shopify Grow upgrade (§10a) and full automation to be ready.
**Shopify is now on Grow as of this session (§10a below, confirmed closed)**
— this tool's original reason for existing may now be largely resolved; worth
a deliberate decision on retiring it rather than letting it run indefinitely
alongside the real pipeline.

**The actual risk:** an order tagged `po-drafted` has **already had a real PO
manually sent to CT** — it is spoken for. But nothing in this repo's guard
stack (mirror idempotency, `gci-walmart-mirror` webhook guard, `ct_orders`
claim) knows that. The moment `CT_AUTO_PO_ENABLED` + `CT_DRY_RUN=false` go
live together, `routeOrderToCT()` has no way to see that a `po-drafted` order
was already handled — it would attempt to claim and submit it again, a real
duplicate PO against the live credit line, the exact failure mode § 1's guard
stack exists to prevent. **`po-drafted` is not currently checked anywhere in
`classifyLineItems()`, `claimOrder()`, or `routeOrderToCT()`.**

**Before live CT automation is ever turned on**, one of the following must
happen:
1. Retire the Cowork tool entirely once the real pipeline is trusted, so
   there's only one path again, or
2. Add a `po-drafted` tag check to `routeOrderToCT()` (or `claimOrder()`) that
   refuses/flags auto-PO for any order already carrying that tag, or
3. Have the Cowork tool write a lightweight marker row (even without full
   ledger integration) so the two systems can see each other.

**✅ RESOLVED 2026-08-26 — option 2 implemented and merged.** PR #75
(`fix/po-drafted-guard`), deployed to production the same day. `po-drafted`
is now checked as the very first thing `routeOrderToCT()` does — see the
guard at the top of that function and the `PO_DRAFTED_TAG` constant above.
Options 1 and 3 remain open as future simplifications (retiring the Cowork
tool once the real pipeline is trusted) but are no longer blocking.

---

## 13. Canary override — the mechanism for the FIRST real `submitOrder()` call

**No CT sandbox exists.** `submitOrder()` (the `createOrder` RESTlet) has
never been called in any environment — everything to date, including manual
PO `GCI-2026-447270`, has been either fully manual or `CT_DRY_RUN=true`. This
section is how the very first real call gets made safely: scoped to one
order, supervised, without flipping the global `CT_DRY_RUN` switch for every
order at once.

### How it works

Two env vars, both required, both checked in `ct-order-routing.ts`:

- `CT_CANARY_SOURCE_ORDER_NUMBER` — exact match against `sourceOrderNumber`
  (Shopify order name like `#1044`, or a Walmart `purchaseOrderId`).
- `CT_CANARY_CONFIRM` — must equal the literal string
  `I_UNDERSTAND_THIS_SUBMITS_A_REAL_CT_ORDER` exactly. A second, deliberately
  awkward value so one leftover/typo'd env var can't arm this by accident.

When both match, `routeOrderToCT()` still runs the **entire normal
pipeline** for that order — installer refusal, `po-drafted` guard,
`classifyLineItems()`, `claimOrder()` — nothing is skipped. Only the final
`submitOrder()` call is forced live (`forceLive: true`), overriding the
global `CT_DRY_RUN` for that one call only. `claimOrder()`'s own `dryRun`
field is also computed with the canary in mind, so the ledger reflects
reality from the moment of claim, not just after the fact.

Every step logs loudly and sends a dedicated, unmissable Telegram alert
(`🐤 CT CANARY MATCHED`, then `🐤 CANARY SUBMITTED LIVE` on success) — separate
from the routine per-outcome alerts, so this never blends into normal noise.

Both env vars require an explicit Vercel redeploy to take effect (see § 10's
🔴 callout) — that's a **feature**, not friction: arming the canary is a
deliberate two-step action, not a single click.

**🔴 Remove both vars and redeploy again immediately after the canary
order's outcome is confirmed.** Armed-and-forgotten is the actual failure
mode here — a leftover `CT_CANARY_SOURCE_ORDER_NUMBER` matching some future
order's number by coincidence would silently force a real submission.

### Triggering it against a real order

Shopify webhooks fire once, at order creation — by the time you've picked
which order to canary and armed the vars, that order's webhook already fired
(and, since CT isn't configured, almost certainly returned `not_configured`).
`api/admin-canary-ct-order.ts` (`POST`, `CRON_SECRET`-protected) re-fetches a
named order fresh from Shopify and re-runs it through the exact same
`routeOrderToCT()` — the "re-deliver the webhook" mechanism. It does NOT
decide live-vs-dry-run itself; that's still entirely the two env vars above.
It refuses ship-to-installer orders and Walmart-mirrored orders (recommend
picking a plain direct-to-customer order for the first test) — see the file
header for the full safety notes.

**Correction, verified 2026-08-27 (was stated wrong in an earlier draft of
this section): `claimOrder()` does NOT necessarily fire on every call.**
`classifyLineItems()` runs BEFORE `claimOrder()` in the step order (step 2,
before step 3) — if classification fails (e.g. `CTNotConfiguredError`), the
function returns early and no ledger row is ever written. **Confirmed live**:
running the rehearsal below against `#1003` produced `not_configured` and
`ct_orders` remained at 0 rows, verified directly via SQL immediately after.
So a dry-run rehearsal against an order that hits `not_configured` is a true
no-op on `ct_orders`. It would NOT be a no-op once CT is actually configured
and classification succeeds — at that point `claimOrder()` does run and does
write a real row (with `dry_run: true`) even without the canary armed. Keep
treating any rehearsal run AFTER CT is configured as a real action worth
confirming, even though this particular run wasn't.

### Recommended first real order

Given only 4 real orders have ever been placed and delivered — `#1003`,
`#1011` (direct), and the two Walmart-mirrored deliveries — `#1003` or
`#1011` are the natural candidates: real, already fulfilled, already known
to be correct (customer received their tires), so a canary run tests
`submitOrder()`'s real behavior without any risk of the *order itself* being
wrong. A dry-run rehearsal against real historical data is safe to run
freely **while CT remains unconfigured** (per the correction above) — but
re-run it again after § 10's credential fix lands, since the outcome (and
whether it writes to `ct_orders`) will be different once classification can
actually succeed.

---

## 14. 🔴 `order-router.ts`'s TIRE_PREFIX filter is stale against the live catalog

**Discovered 2026-08-27**, while building § 13's canary tooling. Real,
current Shopify line-item SKUs are **bare** — no prefix. Confirmed against 4
real orders pulled live: `#1011` → `200E2108`, `#1010` → `200E2108`, `#1003`
→ `200E2096`/`200E2101`, `#1001` → `MV688`. None carry the `TIRE-` prefix
`order-router.ts`'s webhook handler requires to build a PO / send a
notification.

**What this means:** any line item on a direct Shopify checkout order
(`orders/paid` webhook → `order-router.ts`) falls into `unknownItems`, which
gets `console.warn()`'d and **nothing else** — no Telegram, no email. The
module header comment even documents this as intentional design: *"(anything
else → unknownItems, logged, not auto-processed)"* — it just predates the
catalog's current bare-SKU convention.

**Confirmed with Pat (2026-08-27): no orders were actually missed.** All 4
real direct/Walmart orders to date (`#1013`, `#1012`, `#1011`, `#1003`)
predate this automation being built or activated — Pat found and processed
every one of them by manually checking the Shopify/Walmart dashboards
directly, not via any alert from this system. So this is a real, live latent
bug, not an active incident — but it means **the direct-Shopify-order path
has never actually alerted on a real order**, and won't, until fixed.

**Not yet fixed.** § 13's `admin-canary-ct-order.ts` deliberately does NOT
repeat this mistake — it hands every line item to `classifyLineItems()` (CT's
real product-search RESTlet) rather than filtering by a local prefix
heuristic, matching how `maybeRouteToCT()` (the Walmart path, which has
always worked correctly) already does it. `order-router.ts` itself is the
one place this is still broken and needs the same fix before the direct
Shopify order path can be trusted.

---

## 15. ✅ Auth to CT's real production server now works — and 🔴 a new bug found because of it

**2026-08-27/28, in order:**

1. § 10's fix (copying `CT_*` creds from `gci-brain`) landed, but the first
   retest still failed: `CTServerError ... INVALID_LOGIN_ATTEMPT`.
   Root cause: `CT_ENVIRONMENT` still defaulted to `sandbox`
   (targets `CT_ACCOUNT_ID_SANDBOX = 8031691_SB1`), while the copied
   creds are scoped to production (`CT_ACCOUNT_ID_PROD = 8031691`) — right
   key, wrong account/realm.
2. Pat set `CT_ENVIRONMENT=production` in `gci-order-hub` to match
   `gci-brain`. **This worked** — `#1003`'s rehearsal got a real,
   authenticated response from CT's live `productSearch` RESTlet for the
   first time ever (`no_ct_items` — CT's catalog doesn't recognize
   `200E2096`/`200E2101` under this account; a real data question, not a
   bug — worth checking with CT directly if that persists for currently
   sellable SKUs).
3. Retesting against `#1011` (SKU `200E2108`) went further than any order
   ever has: it passed classification, claimed a **real PO number for the
   first time ever** — `GCI-2026-447300` — and reached `submitOrder()`.

**🔴 New bug found, exposed only because #1011 was the first order to ever
reach this code path:** `submitOrder()`'s dry-run stub deliberately returns
`id: ''` (empty) — correct, nothing should get a fake CT tracking ID. But
`markSubmitted()` (`ct-order-ledger.ts`) requires a non-empty `ctInternalId`
and throws if it's blank, with the exact message *"A success response
without an id is INDETERMINATE."* That throw gets caught by
`routeOrderToCT()`'s outer catch-all, which calls `markIndeterminate()` —
**the same path reserved for "CT may have silently committed this order for
real, do not auto-retry, human must check CT manually."** A dedicated,
scary Telegram alert fires for this outcome by design.

**Net effect: every dry-run "success," forever, has been silently destined
to report as this maximum-severity ambiguous-outcome alarm instead of the
intended `submitted (DRY RUN)`** — because nothing had ever reached step 4
before `#1011`, this was structurally impossible to catch until today.
Confirmed via direct query: `GCI-2026-447300`'s row shows `dry_run: true`,
`ct_internal_id: null` — nothing was actually transmitted to CT, the alarm
was a false positive caused by the dry-run stub shape, not a real ambiguous
CT interaction.

**Consequence for `#1011` specifically: harmless.** It was already fulfilled
and delivered manually, long before this automation existed — it will never
need to be resubmitted through this system, so its permanent
no-auto-retry lock doesn't matter in practice. But the same false alarm
would fire on any future dry-run test, and — more importantly — could
plausibly fire on a genuine first real submission too, depending on whether
a real CT success response could ever come back without a usable id field
(untested, unknown).

**Not yet fixed.** Two reasonable approaches, not yet decided between:
1. `submitOrder()`'s dry-run stub returns a synthetic non-empty id (e.g.
   `id: 'DRY-RUN'`, matching the existing `orderNumber: 'DRY-RUN'` pattern)
   so `markSubmitted()`'s validation passes and the ledger correctly shows
   `submitted` with `dry_run: true`, matching the alert text that was
   always written assuming this would work.
2. `routeOrderToCT()`'s step 4 special-cases `result.dryRun === true` and
   calls a distinct dry-run-aware ledger transition instead of
   `markSubmitted()`, so real vs. dry-run success paths are never
   conflated even if their response shapes differ in the future.

Do not run further dry-run rehearsals against real orders that have
CT-recognized SKUs until one of these is fixed — each one will currently
burn a real PO number, permanently lock that order out of auto-retry, and
fire an unnecessary maximum-severity Telegram alarm.

**✅ Fix implemented — PR #77 (`fix/dryrun-indeterminate-false-alarm`),
option 1 above.** Not yet merged as of this writing; review before merging,
since it changes ledger success-reporting behavior. New
`ct-client-dryrun.unit.test.ts` (3/3) exercises the real dry-run branch
directly, no mocks. Once merged and redeployed, re-run the `#1003`/`#1011`
rehearsal once more to confirm it now reports `submitted (DRY RUN)` instead
of `indeterminate` — that live confirmation is the real proof, not just the
unit test passing.

**Extra precaution taken 2026-08-28: Pat contacted CT staff directly**,
asking them not to process PO `GCI-2026-447300` or orders `#1003`/`#1011`,
given ongoing integration testing. Sensible belt-and-suspenders move —
our own ledger data (confirmed via direct SQL: `dry_run: true`,
`ct_internal_id: null` on the `GCI-2026-447300` row) is strong evidence
nothing was ever transmitted to CT from our side, and both orders were
already fulfilled/delivered independently before any of this testing
existed — but this system genuinely cannot see CT's side directly, so a
human-to-human confirmation is worthwhile insurance the `indeterminate`
ledger state can't provide by itself.

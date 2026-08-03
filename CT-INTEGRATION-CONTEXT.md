# Canada Tire (CT) Order Automation — Working Context

**Repo:** `gci-order-hub`
**Last updated:** 2026-07-31
**Status:** Client + ledger merged. Routing NOT yet wired. Verification gap #1 (ledger concurrency, § 6) CLOSED 2026-07-31 — all other safety gates unchanged.
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
routing function in-process**. It does *not* wait for a Shopify webhook.

Rejected alternative ("Option 1"): let the mirrored order's `orders/paid`
webhook drive routing. Rejected because:

- It is **unverified** whether Shopify fires `orders/paid` for an order created
  via Admin API and marked paid *without a processed transaction* (Walmart
  collects payment, so Shopify processes none). If it does not fire, Walmart
  orders silently never reach CT.
- It adds an async hop of unpredictable latency against Walmart's 4-hour
  acknowledgment SLA.

Option 1 becomes attractive only if orders hand-created in Shopify Admin should
also route automatically. That is not a current requirement.

### Three independent duplicate-order defences

| Layer | Guarantees | Key |
|---|---|---|
| Mirror idempotency | one Walmart PO → at most one Shopify order | Walmart PO# |
| `walmart-import` webhook guard | one router invocation per order | Shopify tag |
| `ct_orders` claim | one CT submission per Shopify order | Shopify order id |

Any one layer can fail and two remain.

### 🔴 The `walmart-import` guard — do not "fix" this

`order-router.ts` returns 200 early, without supplier routing, for any Shopify
order tagged `walmart-import`.

**This looks like a bug and is not.** The mirror calls the routing function
*directly*; if the webhook were also allowed to route the same order, the tire
would be submitted to Canada Tire **twice against a live credit line**.

The guard's rationale inverted mid-design (it originally existed to stop a
passive bookkeeping copy from ordering at all). The code is identical either
way. Removing it causes duplicate real orders.

---

## 2. Safety gates — current state

| Variable | Vercel state | Default if unset | Effect |
|---|---|---|---|
| `CT_AUTO_PO_ENABLED` | **UNSET** (confirmed 2026-07-27) | `false` | no auto-PO |
| `CT_DRY_RUN` | unset | `true` | nothing transmitted |
| `CT_ENVIRONMENT` | unset | `sandbox` | non-production realm |

`CT_DRY_RUN` requires the exact string `'false'` to transmit. Any other value,
including unset, means dry-run.

**Deploying current `main` is behaviourally identical to before this work
began.** No real order can be placed. Do not set any of these three without an
explicit decision recorded in a PR.

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

**✅ CLOSED 2026-07-31 (Prompt B, Shopify side only — see item below).**
`order-router.ts`'s dormant `CT_AUTO_PO_ENABLED` branch used to call
`submitPurchaseOrder()` → `submitOrder({ poNumber: po.gciOrderNumber, ... })`
directly, bypassing `claimOrder()`/`buildPoNumber()` entirely. It now calls
`routeOrderToCT()` (new: `api/lib/ct-order-routing.ts`), which runs
`classifyLineItems()` → `claimOrder()` → `submitOrder()` and always gets a
real `GCI-<year>-<seq>` PO number from the ledger. `submitPurchaseOrder()` is
unused dead code now, kept only as a shim (see its header comment in
`ct-client.ts`). **Still only reachable via the Shopify webhook path** —
see §6 item 2 and §7 for the Walmart-side gap this does not close.

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

2. **Partially closed 2026-07-31.** `ct-order-ledger.ts` is now imported and
   called — by `api/lib/ct-order-routing.ts`, wired into `order-router.ts`'s
   Shopify `orders/paid` webhook. `ct_orders` will start getting rows the
   moment `CT_AUTO_PO_ENABLED=true` (still unset today). **The ledger is
   still never reached for Walmart orders** — no code anywhere mirrors a
   Walmart order into Shopify or calls `routeOrderToCT()` for one; the
   `walmart-import` guard described in §1 and the "mirror is CRITICAL PATH"
   decision in §7 were never actually implemented despite `CT-SESSION-PROMPTS.md`
   listing Prompt A as a precondition for this work. Wiring a Walmart caller
   is still open — needs either the mirror built or a deliberate
   architecture change (routing directly off Walmart data without a Shopify
   mirror in between).

3. **Submit Order has never been called** in any environment.
   `customerId 19997` is unconfirmed for that endpoint specifically.

4. **Shopify webhook behaviour for Admin-API-created paid orders is unknown.**
   Whether `orders/paid`, `orders/create`, both, or neither fires is untested.
   Option 2 was chosen partly to avoid depending on this, but the
   `walmart-import` guard's necessity depends on it — if no webhook fires, the
   guard is harmless belt-and-braces; if one does, it is load-bearing.
   **Assume it is load-bearing.**

5. ✅ **CLOSED 2026-07-31.** `scratchpad/ledger-race-test.mjs` rebuilt and
   committed (PR #63). Compiles the real ct-order-ledger.ts via tsc rather
   than reimplementing it; self-cleaning; documented recompile step if the
   source changes. See item 1 for the run result.

---

## 7. Walmart channel

### Telegram has NEVER fired for a Walmart order

This is an **unbuilt feature, not a regression.** Do not go bug-hunting.

`/api/walmart-order-sync` runs every 15 min (96 runs/24h, zero errors over 7
days). `/api/ct-tracking-parser` runs 48×/day, zero errors — **its actual
behaviour is not yet documented and contradicts an earlier assumption that
tracking was fully manual. Read it before assuming anything.**

### Known missed order

Walmart PO# `309120965612142`, order# `600000112174518`, 2026-07-26,
SKU `200E1059`, $194.99, Acknowledged/Unshipped, ship-by 07/27,
deliver-by 07/30. Found by manually checking the dashboard. Acknowledged
manually. Nothing alerted.

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

**Implemented 2026-07-31** as `buildCtRoutingAlert()` /
`sendCtRoutingAlert()` in `api/lib/ct-order-routing.ts` — this exact field
list, rendered generically so any field a caller doesn't supply (all the
Walmart-only ones, today) is simply omitted rather than shown blank. It only
fires when `routeOrderToCT()` runs, which today means Shopify orders only
(see §6 item 2). The pre-existing per-order alert in
`walmart-order-sync.ts`'s `buildTelegramMessage()` — sent at ingestion time,
before any CT routing would happen — still has its
`CT cost / warehouse / stock: placeholder, filled by a later PR` line
unfilled, deliberately: filling it in would mean fabricating a CT routing
result that never actually ran for that order.

### 🔴 `gci-walmart-sync` is NOT this pipeline

`gci-walmart-sync` is a **separate commercial Shopify app**, intentionally in
test mode against `gci-walmart-test.myshopify.com`. It has nothing to do with
GCI's own Walmart orders. Ignore it entirely when working on this.

---

## 8. Error mapping (✅ implemented 2026-07-31 — `api/lib/ct-order-routing.ts`)

| Outcome | Ledger action | Notes |
|---|---|---|
| success | `markSubmitted` | |
| `CTInsufficientStockError` | `markManualRequired` | **Routine, not an error.** Telegram with per-location stock detail, return 200. Expect this often — stock is thin. |
| `CTValidationError` | `markFailed` | Safe to fix and resubmit |
| `CTAuthError` | `markFailed` | |
| `CTServerError` / timeout | `markIndeterminate` | 🔴 **LOUD alert. NEVER auto-retry.** CT may have committed the order. |
| `CTNotConfiguredError` | *(none — no claim taken)* | Surfaces from `classifyLineItems()`, before any `claimOrder()` call, so a config problem never occupies a ledger row. Not in the original table above; added because `classifyLineItems()`, like `submitOrder()`, calls a CT RESTlet. |
| `ship_to_installer` | *(none — no claim taken)* | Explicit refusal before `classifyLineItems()`/`claimOrder()` — see §9. |
| 100% unknown/excluded line items | *(none — no claim taken)* | Nothing CT-eligible to submit; unknown SKUs still alert per §4. |
| already claimed (`claimed:false`) | *(none — existing row untouched)* | Idempotent replay (e.g. a retried webhook) — not resubmitted. |

---

## 9. Open bugs

- **✅ CLOSED 2026-07-31.** `order-router.ts` `ship_to_installer` branch used
  to send empty `address1`/`city`/`province`/`postalCode` into
  `submitPurchaseOrder()`, throwing `CTValidationError` deep inside — AFTER a
  ledger row would already have been claimed for it, once that path was
  wired. `routeOrderToCT()` now checks `shipToInstaller` first and refuses
  explicitly (`manual_required`, no CT call, **no ledger claim at all** —
  confirmed by code order: the check runs before `classifyLineItems()`/
  `claimOrder()`) instead of synthesizing empty address fields. Installer
  drop-ship shipping is still deferred until a real installer address list
  exists.
- **~10 Walmart SKUs** get a persistent 400 "Data error" on price/inventory
  updates via `/api/walmart-sync-cursor` (43 error groups; also transient
  520s). Likely invalid or delisted SKUs. **Separate issue from order sync** —
  do not conflate.

---

## 10. Environment variables

| Variable | Value / default | Notes |
|---|---|---|
| `CT_CONSUMER_KEY` | set in Vercel | |
| `CT_CONSUMER_SECRET` | set in Vercel | |
| `CT_TOKEN_ID` | set in Vercel | |
| `CT_TOKEN_SECRET` | set in Vercel | |
| `CT_CUSTOMER_API_TOKEN` | set in Vercel | the `d!U3^…` value; pairs with 19997 |
| `CT_CUSTOMER_ID` | `19997` | defaults to 19997 with warning if unset |
| `CT_ENVIRONMENT` | default `sandbox` | `production` to activate |
| `CT_AUTO_PO_ENABLED` | **UNSET** | `true` to enable |
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

---

## 11. Where this left off — 2026-07-27

### Blocked
- **CT sandbox credentials.** Requested from the CT rep by email (informal
  French). Awaiting reply, expected 2026-07-28. Required to exercise Submit
  Order without creating a real billable order.

### Ready to do
- **Rebuild and run the ledger race test** (see § 6, item 5). Blocking for
  `CT_DRY_RUN=false`.
- **Prompt A** — Walmart → Shopify: acknowledge, mirror, notify, webhook
  guard. Ships independently of CT; ends the manual-dashboard-checking problem
  and protects the acknowledgment metric. **Do this first.**
- **Prompt B** — extract shared routing fn, wire `classifyLineItems()` +
  `claimOrder()`, error mapping, installer refusal, enrich Telegram. Requires
  Prompt A merged **and** the ledger race test passed.

Both prompts are recorded in `CT-SESSION-PROMPTS.md`.

### Standing questions to CT rep
- ✅ Credit line active — confirmed
- ✅ Blind drop-ship configured account-level — confirmed
- ⏳ Sandbox credentials — pending
- ⏳ Confirm `customerId 19997` is correct for **Submit Order** specifically

### Do not touch
- `gci-brain/api/shopifySync.ts` — live catalog integration.
- `gci-walmart-sync` — unrelated commercial app in intentional test mode.

---

## 12. Prompt B — 2026-07-31 (draft PR, not merged)

Built `api/lib/ct-order-routing.ts` (`routeOrderToCT()`): classify → claim →
submit → ledger-status-write per §8's error mapping, `ship_to_installer`
refusal before any claim (§9), the `buildCtRoutingAlert()` Telegram format
from §7, and a Sheet column-N PO writer (`writePoNumberByOrderId()` in
`sheets-client.ts`) that only fires on a confirmed `markSubmitted`.
`order-router.ts`'s dormant `CT_AUTO_PO_ENABLED` branch now calls it instead
of `submitPurchaseOrder()` directly (§5, §6 item 2, §8, §9 above all updated
in this same PR).

**What this PR found, and did NOT build:** the premise that Prompt A shipped
a Walmart-order → Shopify mirror plus a `walmart-import` webhook-guard tag
(§1, §7 "Mirror into Shopify is CRITICAL PATH") turned out not to match the
actual code — `api/walmart-order-sync.ts` has zero Shopify API calls, and a
repo-wide search for `walmart-import` found nothing. `CT-SESSION-PROMPTS.md`
frames Prompt B as depending on that mirror; it does not exist. Rather than
build it as an assumption or invent a different trigger unasked, this PR
routes only the one real, already-existing call site that has a real Shopify
order to work with (the Shopify webhook itself) and leaves the Walmart side
unwired. **`walmart-order-sync.ts` still never calls `routeOrderToCT()`.**
Building the mirror, or deciding to route Walmart orders to CT some other
way, is unstarted work — not a subtle gap, a whole missing piece.

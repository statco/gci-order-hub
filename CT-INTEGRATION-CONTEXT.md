# Canada Tire (CT) Order Automation — Working Context

**Repo:** `gci-order-hub`
**Last updated:** 2026-07-31
**Status:** Client + ledger merged. Routing wired on draft branches (PR #65 + #66 — see § 5a), held pending review, not yet on `main`. Verification gaps #1 (ledger concurrency) and #4 (orders/paid webhook behavior) in § 6 both CLOSED 2026-07-31 — remaining gaps unchanged.

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

`order-router.ts` (PR #65/#66, currently draft — not yet on `main`) returns
200 early, without supplier routing, for any Shopify order tagged
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

## 5a. Drafted, not yet merged — PR #65 and #66 (2026-07-31)

Both held pending review; neither is on `main`. `CT_AUTO_PO_ENABLED` remains
unset regardless, so neither changes live behavior yet.

### PR #65 — `claude/ct-order-routing` — CT order routing (Shopify path)

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

### PR #66 — `claude/walmart-shopify-mirror` (stacks on #65) — Walmart mirror

New table `walmart_shopify_mirror` (migration checked in, **not applied
live**). Guard tag `gci-walmart-mirror` (see the guard section above — not
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

**Three open items, not resolved, block merge:**
1. Inventory decrement on the mirrored order — Pat's decision, two real
   options with consequences documented in the PR body, still open.
2. QST marketplace-facilitator status for Quebec Walmart orders — GST/HST is
   confirmed (Walmart CA is marketplace facilitator, GCI never holds tax
   liability, $0 tax on the mirror is correct), but Quebec specifically has
   not been separately confirmed. Do not let a Quebec order flow through the
   mirror until this is checked.
3. `walmart_shopify_mirror` migration is checked in but not applied to the
   live Supabase project — deliberate, gated on the above two decisions plus
   at least one day's review before merge, given the stakes (a live credit
   line and duplicate-order risk).

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
2. **`ct_orders` is empty; the ledger is wired on draft branches, not yet
   live.** `claimOrder()`/`buildPoNumber()` are now called from
   `routeOrderToCT()` (PR #65) and, for the mirror path, from
   `maybeRouteToCT()` (PR #66) — see § 5a. Neither PR is merged to `main`,
   and `CT_AUTO_PO_ENABLED` is unset regardless, so the ledger remains
   unexercised in production until both merge and that gate is explicitly
   flipped on.
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

### Telegram has NEVER fired for a Walmart order in production

Was an **unbuilt feature, not a regression**, through 2026-07-30. **Built on
PR #66 (draft, not merged)** as of 2026-07-31 — notification is wired into
the mirror flow described in § 5a. Still does not fire in production until
#66 merges.

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
  `CTValidationError` when auto-PO is attempted. **Fixed 2026-07-31 by PR #65**
  (draft, not merged) — explicitly refuses auto-PO on that branch, confirmed
  refused **before** `classifyLineItems()`/`claimOrder()` run, routes to
  manual notify. Installer drop-ship remains deferred until a real installer
  list exists — the fields themselves are still never populated.
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

## 11. Where this left off — 2026-07-31

### Blocked

- **CT sandbox credentials.** Requested from the CT rep 2026-07-27, still
  pending. Required to exercise Submit Order without creating a real
  billable order.

### Held for explicit decision (not blocked, just not decided)

- **PR #65** (CT order routing, Shopify path) and **PR #66** (Walmart
  mirror, stacks on #65) — both draft, both mergeable, both hold no live
  effect since `CT_AUTO_PO_ENABLED` is unset. See § 5a for full detail.
  Do not merge either until:
  - Inventory decrement decision made (Pat's call, PR #66 body)
  - QST marketplace-facilitator status confirmed for Quebec orders
  - At least one day's sit/review time given the stakes (live credit line)

  Merge order: #65 first, then #66 (or squash both together).

### Ready to do

- Nothing currently blocked on this repo's own code — the remaining open
  items are either external (CT sandbox creds) or deliberate holds (above).

### Standing questions to CT rep

- ✅ Credit line active — confirmed
- ✅ Blind drop-ship configured account-level — confirmed
- ⏳ Sandbox credentials — pending
- ⏳ Confirm `customerId 19997` is correct for **Submit Order** specifically

### Do not touch

- `gci-brain/api/shopifySync.ts` — live catalog integration.
- `gci-walmart-sync` — unrelated commercial app in intentional test mode.

# CT / Walmart — Implementation Prompts

**Repo:** `gci-order-hub`
**Drafted:** 2026-07-27
**Read `CT-INTEGRATION-CONTEXT.md` first.** These prompts assume that
document's architecture decisions and encode them; changing one without the
other will produce duplicate real orders.

Prompt A ships independently. Prompt B requires A merged **and** the ledger race
test passed against a real database.

---

## Prompt A — Walmart → Shopify (ship first)

```
TASK: Walmart orders must land in Shopify, be acknowledged on Walmart, and
alert via Telegram. New branch off main, draft PR. NO Canada Tire work here.

REPO: gci-order-hub. (gci-walmart-sync is a separate commercial app in
intentional test mode — ignore it entirely.)

ARCHITECTURE — Shopify is the hub. Two channels, one pipeline:
  Walmart order → mirrored into Shopify → Shopify order triggers CT
  Direct order  → lands in Shopify      → Shopify order triggers CT
CT is called from exactly ONE place, off a Shopify order. This PR builds
everything up to (not including) the CT call.

CONTEXT
- /api/walmart-order-sync already runs every 15 min, 96x/day, zero errors.
  Telegram has NEVER fired for a Walmart order — UNBUILT feature, not a
  regression. Read that route and extend it; do not create a new one.
- Reference order: Walmart PO# 309120965612142, order# 600000112174518,
  2026-07-26, SKU 200E1059, qty 1, $194.99, ship-by 07/27, deliver-by 07/30.
  Found manually. Nothing alerted.
- Walmart SKUs are MIXED: bare CT part numbers (200E1059) and legacy
  TIRE- prefixed (TIRE-166028008). Carry SKUs through verbatim — do not
  normalize or strip prefixes in this PR.

BUILD, in this order per new Walmart order:

1. ACKNOWLEDGE on Walmart. Currently manual; Walmart expects it within 4 hours
   and scores sellers on it. This is a WRITE — make it idempotent, never
   acknowledge twice, log every call. Failure here must NOT block steps 2-3.

2. MIRROR INTO SHOPIFY. *** THIS STEP IS CRITICAL PATH, NOT BEST-EFFORT. ***
   Under this architecture the Shopify order is what will later trigger CT, so
   a failed mirror means the order never ships. On failure: loud Telegram
   alert naming the Walmart PO#, and leave the order unmarked so the next cron
   run retries it. Never swallow this error.
   Requirements:
     a. Idempotent on Walmart PO#. One PO → at most one Shopify order, across
        overlapping cron runs. Check before create.
     b. Tag 'walmart-import' AND set note_attribute
        walmart_purchase_order_id = <Walmart PO#>. Both are load-bearing later.
     c. send_receipt:false and send_fulfillment_receipt:false — Walmart
        customers must never receive Shopify email.
     d. Do NOT create a Shopify Customer record. Walmart's Marketplace
        agreement restricts using their customer data for marketing.
     e. Mark the order paid without processing a payment — Walmart already
        collected. Report exactly how you did this in the PR description.

3. TELEGRAM NOTIFICATION. Reuse the existing notify path in api/lib/notify.ts —
   do not write a second Telegram client. Include: Walmart PO#, Walmart order#,
   resulting Shopify order#, SKU + qty, customer city/province, ship-by AND
   deliver-by dates, revenue. Leave a clearly-marked placeholder for
   CT cost / warehouse / stock — Prompt B fills it.

4. WEBHOOK GUARD in order-router.ts. Add an early return at the top of the
   orders/paid handler: if the order carries the 'walmart-import' tag, log and
   return 200 without supplier routing. In Prompt B the mirror will invoke the
   router directly, so allowing the webhook to also fire would double-submit to
   Canada Tire on a live credit line. Add a comment stating exactly that.

5. EMPIRICAL CHECK (report only, no code): after mirroring a test order,
   determine whether Shopify fires orders/paid, orders/create, both, or neither
   for an Admin-API-created order marked paid without a transaction. Report the
   observed behavior in the PR. Do not build anything that depends on it.

IDEMPOTENCY
Each Walmart order processed exactly once across all steps, surviving
overlapping cron runs. Determine how the route tracks seen orders today — if
there is no such mechanism, propose one and ASK ME before building it. Do NOT
reuse ct_orders; that table is for CT submissions only.

CONSTRAINTS
- No Canada Tire calls. Do not import ct-client.ts or ct-order-ledger.ts.
- Do not set CT_AUTO_PO_ENABLED, CT_DRY_RUN, or CT_ENVIRONMENT.
- npx tsc --noEmit must pass. Draft PR, do not merge.
- BEFORE writing code, report what api/walmart-order-sync.ts and
  api/ct-tracking-parser.ts actually do today. I need that to review.
```

---

## Prompt B — CT routing

**Do not start until:** Prompt A is merged, and `claimOrder()`'s race-loss path
has been proven against real Supabase.

```
TASK: Wire Canada Tire submission behind a single shared routing function
serving both channels. New branch off main after Prompt A merges. Draft PR.

PREREQUISITES — verify first, stop if unmet:
- Prompt A merged: walmart-import tag, note_attribute, webhook guard all exist.
- ledger-race-test.mjs PASSED against real Supabase. claimOrder()'s race-loss
  path must be proven, not assumed.

ARCHITECTURE
Shopify is the hub; CT has exactly one implementation. Extract the supplier
routing logic in order-router.ts into a single exported function taking a
Shopify order. Two callers:
  - orders/paid webhook  (direct Shopify sales)
  - walmart-order-sync   (called in-process right after a successful mirror)
Do NOT let walmart-order-sync call CT itself. Keep the Prompt A webhook guard
intact — the mirror invokes the router directly, so the webhook must not.

BUILD
1. Replace the TIRE- prefix gate with classifyLineItems() from ct-client.ts.
   SKUs are mixed and CT part numbers follow no pattern — the catalog is the
   only source of truth. INSTALL-FEE-* is already excluded there. Route
   unknownItems to Telegram; never silently drop.

2. claimOrder() BEFORE any CT call, in the shared function:
     sourceOrderId = Shopify order id  (BOTH channels — Shopify is the hub)
     sourceChannel = 'shopify' | 'walmart', from the walmart-import tag
     Walmart PO# from the note_attribute, stored as metadata
   PO number: let claimOrder() call buildPoNumber() — do NOT pass an explicit
   poNumber for shopify/walmart. As of the canonical-PO-number-format PR,
   buildPoNumber() emits GCI-<year>-<seq> (atomic Postgres sequence) for
   BOTH channels; channel is not encoded in the PO number, it lives in
   ct_orders.source_channel, which is the reconciliation join key against
   Walmart payouts. Do not reintroduce GCI-W-/GCI-S- prefixes — CT does not
   recognise them.
   If claimOrder returns claimed:false → do not submit, log, stop.

3. CTInsufficientStockError is a ROUTINE outcome, not an error:
   markManualRequired(), Telegram with per-location stock detail, return 200.
   Stock is thin (200E1059: Toronto 1, Montreal 7, Mount Pearl 11, rest zero) —
   this will happen often.

4. Error mapping, exactly:
     success               → markSubmitted
     CTValidationError     → markFailed (safe to fix and resubmit)
     CTAuthError           → markFailed
     CTServerError/timeout → markIndeterminate + LOUD Telegram.
       NEVER auto-retry. CT may have created the order.

5. ship-to-installer branch sends empty address fields and installer
   drop-ship is not in scope. Make it explicitly refuse auto-PO and route to
   manual notify, with a comment saying why. Do not populate those fields.

6. Fill the Prompt A Telegram placeholder: CT cost, chosen warehouse, stock
   status, and either "✅ CT order SO###### placed" or
   "⚠️ manual PO required — <reason>".

CONSTRAINTS
- CT_AUTO_PO_ENABLED stays UNSET, CT_DRY_RUN default true, CT_ENVIRONMENT
  default sandbox. Do not set any in Vercel.
- submitOrder() must never be reached with dry-run off in this PR.
- Do not remove the Prompt A webhook guard.
- npx tsc --noEmit must pass. Draft PR, do not merge.
```

---

## Prompt C — rebuild the ledger race test

The original `scratchpad/ledger-race-test.mjs` was lost to container reclaim.
It must be rebuilt to close verification gap #1 in `CT-INTEGRATION-CONTEXT.md`.

```
TASK: Rebuild the ct_orders ledger race test as a standalone script at
scratchpad/ledger-race-test.mjs. Run it against real Supabase.

WHY: claimOrder() in api/lib/ct-order-ledger.ts has NEVER executed against a
real database. The DB constraints are already proven under concurrency
(5 parallel INSERTs → exactly 1 winner, 4 rejected with 23505). What is NOT
proven is the CODE path: PostgREST returns 409 on unique-constraint conflict,
and claimOrder() must translate that into a clean { claimed: false } return
rather than throwing. That is currently verified by code inspection only, and
it gates CT_DRY_RUN=false.

The script must:
1. Claim a synthetic order — expect claimed:true.
2. Claim the SAME order again sequentially — expect claimed:false, no throw.
3. Fire N concurrent claims of a fresh synthetic order via Promise.all —
   expect EXACTLY ONE claimed:true and N-1 clean claimed:false. This step is
   the actual test; 1 and 2 are warm-up.
4. Self-clean: delete every row it created, including on failure.
5. Exit non-zero on any unexpected result, and print a clear pass/fail summary.

Use obviously-synthetic source_order_id values that cannot collide with real
Shopify order ids. Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
(Supabase dashboard → project enhbckomwdelktdhnuzq → Settings → API).
Never commit the key.

Report the raw output. Do not mark the verification gap closed in
docs/CT-INTEGRATION-CONTEXT.md unless step 3 passes.
```

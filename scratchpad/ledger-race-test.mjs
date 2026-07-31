// scratchpad/ledger-race-test.mjs
// ─────────────────────────────────────────────────────────────
// Verifies CT-INTEGRATION-CONTEXT.md § 6 gap #1: does the REAL claimOrder()
// (api/lib/ct-order-ledger.ts), going through PostgREST, correctly turn a
// concurrent unique-constraint race into exactly one {claimed:true} and the
// rest {claimed:false} — not a thrown exception, a hang, or a double-claim.
//
// This imports the COMPILED output of the actual source file — it does NOT
// reimplement or approximate claimOrder(). Compile first (same manual
// tsc-then-node convention as api/tests/*.unit.test.ts), from the repo root:
//
//   npx tsc api/lib/ct-order-ledger.ts \
//     --outDir scratchpad/compiled --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scratchpad/ledger-race-test.mjs
//
// (scratchpad/compiled/ is gitignored — a build artifact, not source; if
// ct-order-ledger.ts changes, recompile before re-running this.)
//
// Uses channel:'manual' with an explicit, synthetic poNumber — NOT
// channel:'test'. Confirmed live against pg_constraint:
// ct_orders_source_channel_check only allows 'shopify' | 'walmart' |
// 'manual' (matches the TS type CTSourceChannel exactly); 'test' would fail
// that CHECK before ever reaching the unique-constraint race this script
// exists to test. 'manual' is also the one channel claimOrder() accepts an
// explicit poNumber for (required — buildPoNumber() refuses to mint one for
// 'manual'), which is what's needed anyway: all 5 calls must share
// IDENTICAL params to actually race on the same unique constraint(s).
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment —
// the same ones ct-order-ledger.ts itself reads. This table has RLS on with
// zero policies (service-role only), so the anon/publishable key cannot be
// substituted; nothing in this script will work without the real
// service-role key.
//
// Self-cleaning: deletes the synthetic row(s) at the end regardless of
// outcome (unless SKIP_CLEANUP=1 is set, e.g. to inspect a failure by hand).
//
// Never touches Canada Tire. Does not set CT_AUTO_PO_ENABLED, CT_DRY_RUN, or
// CT_ENVIRONMENT — claimOrder() itself never calls CT; only submitOrder()
// (ct-client.ts, not exercised here) does.
// ─────────────────────────────────────────────────────────────

import { claimOrder } from './compiled/ct-order-ledger.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    '❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in this shell.\n' +
    '   This script must run somewhere those are already available (e.g. after\n' +
    '   `vercel env pull` in the gci-order-hub project, or your existing .env.local).'
  );
  process.exit(1);
}

function restHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// Independent of claimOrder()'s own read helpers — a plain count query
// against the real table, so the row-count check doesn't rely on the same
// module's internals it's meant to be verifying.
async function countRowsForPoNumber(poNumber) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/ct_orders?po_number=eq.${encodeURIComponent(poNumber)}&select=id,source_channel,source_order_id,po_number,status`,
    { headers: restHeaders() }
  );
  if (!res.ok) {
    throw new Error(`count query failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function deleteRowsForPoNumber(poNumber) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/ct_orders?po_number=eq.${encodeURIComponent(poNumber)}`,
    { method: 'DELETE', headers: { ...restHeaders(), Prefer: 'return=representation' } }
  );
  if (!res.ok) {
    throw new Error(`cleanup delete failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const ts = Date.now();
  // Synthetic and non-colliding: 'manual' channel + a source_order_id no
  // real manual order would ever use, and a po_number using an implausible
  // year (1999) so it can never match a real GCI-<year>-<seq> sequence
  // value, and is unique per test run via the same timestamp.
  const sourceOrderId = `race-test-${ts}`;
  const poNumber = `GCI-1999-${ts}`;

  const claimInput = {
    channel: 'manual',
    sourceOrderId,
    poNumber,
    dryRun: true,
    requestPayload: { note: 'ledger-race-test.mjs synthetic claim, safe to ignore' },
  };

  console.log('Synthetic claim key:');
  console.log(`  source_channel  = manual`);
  console.log(`  source_order_id = ${sourceOrderId}`);
  console.log(`  po_number       = ${poNumber}`);
  console.log('\nFiring 5 concurrent claimOrder() calls with IDENTICAL params via Promise.all-style concurrency...\n');

  // allSettled (not bare Promise.all) so a thrown exception on any of the 5
  // is captured and reported explicitly, per the task's own instruction —
  // NOT caught-and-ignored, and NOT allowed to hide the other 4 results by
  // short-circuiting.
  const settled = await Promise.allSettled(
    Array.from({ length: 5 }, () => claimOrder(claimInput))
  );

  let trueCount = 0;
  let falseCount = 0;
  let threwCount = 0;

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`Call ${i + 1}: claimed=${r.value.claimed}  (row.status=${r.value.row.status})`);
      if (r.value.claimed) trueCount++; else falseCount++;
    } else {
      threwCount++;
      console.log(`Call ${i + 1}: THREW —`, r.reason);
    }
  });

  console.log(`\nSummary: claimed=true × ${trueCount}, claimed=false × ${falseCount}, threw × ${threwCount}`);

  console.log('\nQuerying ct_orders directly for the synthetic po_number...');
  const rows = await countRowsForPoNumber(poNumber);
  console.log(`Row count for po_number='${poNumber}': ${rows.length}`);
  rows.forEach(r => console.log(' ', JSON.stringify(r)));

  const gapClosed = trueCount === 1 && falseCount === 4 && threwCount === 0 && rows.length === 1;

  console.log(`\n${gapClosed ? '✅ GAP #1 CLOSED' : '❌ GAP #1 NOT CLOSED — unexpected result, see above'}`);

  if (process.env.SKIP_CLEANUP === '1') {
    console.log('\nSKIP_CLEANUP=1 set — leaving synthetic row(s) in place for inspection.');
    console.log(`Clean up later by re-running with SKIP_CLEANUP unset, or via deleteRowsForPoNumber('${poNumber}').`);
  } else {
    console.log('\nCleaning up synthetic row(s)...');
    const deleted = await deleteRowsForPoNumber(poNumber);
    console.log(`Deleted ${deleted.length} row(s).`);
    const after = await countRowsForPoNumber(poNumber);
    console.log(`Row count after cleanup: ${after.length} (expected 0)`);
  }

  process.exit(gapClosed ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ Script itself threw (outside the 5 claim calls):', err);
  process.exit(1);
});

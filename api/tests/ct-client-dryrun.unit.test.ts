// api/tests/ct-client-dryrun.unit.test.ts
//
// Regression test for CT-INTEGRATION-CONTEXT.md §15: submitOrder()'s
// dry-run stub previously returned id:'' (empty), which made
// markSubmitted() throw (it requires a non-empty ctInternalId) and
// routeOrderToCT()'s catch-all misinterpret that as "CT may have silently
// committed this order" — the maximum-severity indeterminate alarm — on
// EVERY dry-run success, discovered only when order #1011 became the first
// order ever to reach this code path (2026-08-27/28).
//
// This test exercises submitOrder()'s real dry-run branch (not a mock of
// it) but avoids the two things that would otherwise force a real network
// call even under dry-run: assertConfigured() needs non-empty (fake is
// fine — dry-run never uses them for a real request) credential env vars,
// and passing `location` directly skips resolveLocation()'s call to
// searchProducts() (see ct-client.ts: `input.location || await
// resolveLocation(...)`). creds() re-reads process.env on every call
// (unlike CT_DRY_RUN/CT_ENVIRONMENT, which are frozen at module load), so
// setting these here — in the same process, after import — is sufficient;
// no isolated-process trick needed like the CT_CANARY_* tests.
//
// Run:
//   npx tsc api/tests/ct-client-dryrun.unit.test.ts api/lib/ct-client.ts \
//     --outDir /tmp/test-ct-client --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   NODE_PATH="$PWD/node_modules" node /tmp/test-ct-client/tests/ct-client-dryrun.unit.test.js

import assert from 'node:assert/strict';
import { submitOrder, CT_DRY_RUN } from '../lib/ct-client.js';

// Fake, non-functional values — only need to be non-empty so
// assertConfigured() passes. Dry-run mode never uses them for a real
// request (it returns before any fetch/ctPost call).
process.env.CT_CONSUMER_KEY      ||= 'test-fake-consumer-key';
process.env.CT_CONSUMER_SECRET   ||= 'test-fake-consumer-secret';
process.env.CT_TOKEN_ID          ||= 'test-fake-token-id';
process.env.CT_TOKEN_SECRET      ||= 'test-fake-token-secret';
process.env.CT_CUSTOMER_API_TOKEN ||= 'test-fake-customer-token';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('\nsubmitOrder() dry-run stub (§15 — see CT-INTEGRATION-CONTEXT.md)');

  await test('dry-run precondition: CT_DRY_RUN is true in this test run (no forceLive passed below)', () => {
    // If this ever fails, the rest of this file is silently testing the
    // wrong branch — see the module comment for why CT_DRY_RUN can't be
    // forced true here (it's a frozen module-load constant, unlike creds()).
    assert.equal(CT_DRY_RUN, true);
  });

  await test('dry-run id is a non-empty sentinel, not empty string — the actual §15 fix', async () => {
    const result = await submitOrder({
      poNumber: 'TEST-PO-0001',
      location: 'TEST_WH', // skips resolveLocation()'s real network call
      items: [{ partNumber: '200E1059', quantity: 1 }],
      shipping: {
        addr1: '123 Test St', city: 'Toronto', province: 'ON',
        postalCode: 'M1M1M1', country: 'CA',
      },
    });
    assert.equal(result.dryRun, true);
    assert.notEqual(result.id, '');
    assert.equal(result.id, 'DRY-RUN');
  });

  await test('dry-run id would have passed markSubmitted()\'s non-empty check (the actual regression)', async () => {
    const result = await submitOrder({
      poNumber: 'TEST-PO-0002',
      location: 'TEST_WH',
      items: [{ partNumber: '200E1059', quantity: 1 }],
      shipping: {
        addr1: '123 Test St', city: 'Toronto', province: 'ON',
        postalCode: 'M1M1M1', country: 'CA',
      },
    });
    // Mirrors markSubmitted()'s own validation (ct-order-ledger.ts) without
    // importing it directly — that module needs real Supabase env vars this
    // test deliberately doesn't set up. The check itself is one line and
    // stable; duplicating it here keeps this test's network/dependency
    // footprint at zero.
    assert.ok(result.id?.trim(), 'ctInternalId must be non-empty, or markSubmitted() throws');
  });

  console.log(`\n✅ ${passed} assertions passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

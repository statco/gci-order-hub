// api/tests/ct-order-routing-canary-partial.unit.test.ts
//
// The one safety property that matters most for the canary override: a
// leftover or fat-fingered CT_CANARY_SOURCE_ORDER_NUMBER, on its own,
// must NEVER arm live submission. CT_CANARY_CONFIRM must also be set to
// the exact phrase. Isolated into its own process for the same
// module-load-time-constant reason as ct-order-routing-canary.unit.test.ts.
//
// Run:
//   CT_CANARY_SOURCE_ORDER_NUMBER=#9999 \
//   npx tsc api/tests/ct-order-routing-canary-partial.unit.test.ts api/lib/ct-order-routing.ts \
//     --outDir /tmp/test-canary-partial --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   CT_CANARY_SOURCE_ORDER_NUMBER=#9999 \
//   NODE_PATH="$PWD/node_modules" node /tmp/test-canary-partial/tests/ct-order-routing-canary-partial.unit.test.js

process.env.CT_CANARY_SOURCE_ORDER_NUMBER = process.env.CT_CANARY_SOURCE_ORDER_NUMBER || '#9999';
// Deliberately NOT setting CT_CANARY_CONFIRM at all — this is the exact
// "someone left the order number set from last time" scenario.
delete process.env.CT_CANARY_CONFIRM;

import assert from 'node:assert/strict';
import { isCanaryMatch, CT_CANARY_ARMED } from '../lib/ct-order-routing.js';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\ncanary override — PARTIAL state (order number set, confirm phrase missing)');

test('a leftover CT_CANARY_SOURCE_ORDER_NUMBER alone does NOT arm the canary', () => {
  assert.equal(CT_CANARY_ARMED, false);
});

test('isCanaryMatch() refuses to match even the exact configured order number when unarmed', () => {
  assert.equal(isCanaryMatch(process.env.CT_CANARY_SOURCE_ORDER_NUMBER!), false);
});

console.log(`\n✅ ${passed} assertions passed\n`);

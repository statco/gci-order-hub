// api/tests/ct-order-routing-canary.unit.test.ts
//
// Isolated from ct-order-routing.unit.test.ts on purpose: CT_CANARY_ARMED
// is a module-load-time constant derived from process.env, same pattern as
// CT_DRY_RUN elsewhere in this codebase. To test the ARMED state, the env
// vars must be set before ct-order-routing.js is ever imported in this
// process — sharing a process with the "unarmed by default" test would
// make one or the other order-dependent and fragile. Kept as its own file,
// run standalone.
//
// Run:
//   CT_CANARY_SOURCE_ORDER_NUMBER=#9999 CT_CANARY_CONFIRM=I_UNDERSTAND_THIS_SUBMITS_A_REAL_CT_ORDER \
//   npx tsc api/tests/ct-order-routing-canary.unit.test.ts api/lib/ct-order-routing.ts \
//     --outDir /tmp/test-canary --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   CT_CANARY_SOURCE_ORDER_NUMBER=#9999 CT_CANARY_CONFIRM=I_UNDERSTAND_THIS_SUBMITS_A_REAL_CT_ORDER \
//   NODE_PATH="$PWD/node_modules" node /tmp/test-canary/tests/ct-order-routing-canary.unit.test.js

process.env.CT_CANARY_SOURCE_ORDER_NUMBER = process.env.CT_CANARY_SOURCE_ORDER_NUMBER || '#9999';
process.env.CT_CANARY_CONFIRM = process.env.CT_CANARY_CONFIRM || 'I_UNDERSTAND_THIS_SUBMITS_A_REAL_CT_ORDER';

import assert from 'node:assert/strict';
import { isCanaryMatch, CT_CANARY_ARMED, CT_CANARY_SOURCE_ORDER_NUMBER } from '../lib/ct-order-routing.js';

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

console.log('\ncanary override — ARMED state (both env vars set correctly)');

test('CT_CANARY_ARMED is true when both env vars are set and CONFIRM matches exactly', () => {
  assert.equal(CT_CANARY_ARMED, true);
  assert.equal(CT_CANARY_SOURCE_ORDER_NUMBER, process.env.CT_CANARY_SOURCE_ORDER_NUMBER);
});

test('isCanaryMatch() matches ONLY the exact configured order number', () => {
  assert.equal(isCanaryMatch(process.env.CT_CANARY_SOURCE_ORDER_NUMBER!), true);
  assert.equal(isCanaryMatch('#1044'), false);
  assert.equal(isCanaryMatch(''), false);
});

test('isCanaryMatch() does not do prefix or substring matching', () => {
  const armed = process.env.CT_CANARY_SOURCE_ORDER_NUMBER!;
  assert.equal(isCanaryMatch(armed + '0'), false);   // superstring
  assert.equal(isCanaryMatch(armed.slice(0, -1)), false); // substring
});

console.log(`\n✅ ${passed} assertions passed\n`);

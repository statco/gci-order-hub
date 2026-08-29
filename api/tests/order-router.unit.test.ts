// api/tests/order-router.unit.test.ts
//
// Regression test for CT-INTEGRATION-CONTEXT.md §14: order-router.ts used
// to split line items by a 'TIRE-' SKU prefix the live catalog has never
// actually used, silently dropping every real order's items into
// unknownItems (console.warn() only, no alert). Fixed 2026-08-28 by
// removing local classification entirely -- classifyLineItems() (called
// inside routeOrderToCT()) now does real classification against CT's live
// catalog for every item, no local filtering.
//
// This test only covers normalizeLineItems() -- the handler itself isn't
// structured for HTTP-level testing (no injectable routeFn, unlike
// walmart-order-sync.ts's maybeRouteToCT()), and a full refactor for that
// is out of scope for this fix. normalizeLineItems() is the actual piece
// that changed: it now passes bare SKUs through untouched instead of the
// old handler dropping them into unknownItems.
//
// Run:
//   npx tsc api/tests/order-router.unit.test.ts api/order-router.ts \
//     --outDir /tmp/test-order-router --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   NODE_PATH="$PWD/node_modules" node /tmp/test-order-router/tests/order-router.unit.test.js

import assert from 'node:assert/strict';
import { normalizeLineItems, type ShopifyLineItem } from '../order-router.js';

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

function item(sku: string, overrides: Partial<ShopifyLineItem> = {}): ShopifyLineItem {
  return { id: 1, sku, title: 'Test Tire', quantity: 1, price: '150.00', variant_id: 1, ...overrides };
}

console.log('\nnormalizeLineItems (§14 — see CT-INTEGRATION-CONTEXT.md)');

test('real bare SKUs (no prefix) pass through untouched, uppercased — the actual §14 regression', () => {
  // These are real SKUs pulled live from real orders during this session's
  // investigation: #1011 -> 200E2108, #1001 -> MV688. The old TIRE_PREFIX
  // filter would have silently dropped every one of these into
  // unknownItems (console.warn() only). They must now survive normalization
  // unchanged in content, just uppercased.
  const result = normalizeLineItems([item('200e2108'), item('mv688'), item('200E2096')]);
  assert.deepEqual(result.map(i => i.sku), ['200E2108', 'MV688', '200E2096']);
});

test('a stray legacy TIRE- prefix is still stripped defensively, not required', () => {
  const result = normalizeLineItems([item('TIRE-200E2108'), item('tire-mv688')]);
  assert.deepEqual(result.map(i => i.sku), ['200E2108', 'MV688']);
});

test('items with no SKU at all are dropped (nothing for CT to classify)', () => {
  const result = normalizeLineItems([item('200E2108'), item('')]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, '200E2108');
});

test('quantity and other fields are preserved untouched', () => {
  const result = normalizeLineItems([item('200E2108', { quantity: 4, title: 'Winter Tire 225/65R17' })]);
  assert.equal(result[0].quantity, 4);
  assert.equal(result[0].title, 'Winter Tire 225/65R17');
});

console.log(`\n✅ ${passed} assertions passed\n`);

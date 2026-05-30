// api/lib/pricing.test.ts
// Run: npx tsc api/lib/pricing.ts api/lib/pricing.test.ts --outDir /tmp/ptest \
//        --module nodenext --target es2022 && node /tmp/ptest/api/lib/pricing.test.js
//
// Verifies the Layer 1 invariant: no computed price can land below cost,
// and the assertion backstop throws on a deliberate below-cost amount.

import assert from 'node:assert';
import { safeWalmartPrice, assertAboveCost, PRICE_FLOOR_MULTIPLIER } from './pricing.js';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// Floor applies when Shopify price is below cost*multiplier.
check('floors a below-cost Shopify price up to cost × multiplier', () => {
  const p = safeWalmartPrice({ shopifyPrice: 285, cost: 330 })!;
  assert.ok(p >= 330, `expected >= cost 330, got ${p}`);
  assert.ok(p >= 330 * PRICE_FLOOR_MULTIPLIER - 1, `expected near floor, got ${p}`);
});

// Uses Shopify price when it is above the floor.
check('keeps Shopify price when above floor', () => {
  const p = safeWalmartPrice({ shopifyPrice: 537.99, cost: 330 })!;
  assert.strictEqual(p, 537.99);
});

// Missing cost → null (caller must skip).
check('returns null when cost is missing', () => {
  assert.strictEqual(safeWalmartPrice({ shopifyPrice: 285, cost: null }), null);
  assert.strictEqual(safeWalmartPrice({ shopifyPrice: 285, cost: 0 }), null);
});

// No Shopify price but valid cost → floor (never below cost).
check('falls back to floor when Shopify price is missing', () => {
  const p = safeWalmartPrice({ shopifyPrice: null, cost: 100 })!;
  assert.ok(p >= 100, `expected >= cost 100, got ${p}`);
});

// The real cancelled-order SKU: never below CT cost.
check('TIRE-170034002 case never prices below cost', () => {
  const p = safeWalmartPrice({ shopifyPrice: 285, cost: 330 })!;
  assert.ok(p >= 330);
});

// Assertion backstop throws on a deliberate below-cost amount.
check('assertAboveCost throws on below-cost amount', () => {
  assert.throws(() => assertAboveCost('TIRE-X', 285, 330), /BLOCKED/);
});

check('assertAboveCost passes when amount >= cost', () => {
  assert.doesNotThrow(() => assertAboveCost('TIRE-X', 379.99, 330));
});

console.log(`\n${passed} pricing tests passed.`);

// api/lib/pricing.test.ts
// Run: npx tsc api/lib/pricing.ts api/lib/pricing.test.ts --outDir /tmp/ptest \
//        --module nodenext --target es2022 && node /tmp/ptest/api/lib/pricing.test.js
//
// Verifies the Layer 1 invariant: no computed price can land below the real
// landed-cost floor, and the assertion backstop throws on a deliberate
// below-cost amount.
//
// UPDATED 2026-08-22: floor is now (cost x tax-uplift + freight) / (1 - fee
// - margin), not a flat cost x 1.15 multiplier. See pricing.ts and
// pricing/landedCost.ts for the full formula. Test expectations below are
// derived from that formula, not restated as hardcoded magic numbers -
// changing the formula's constants should make these fail loudly.

import assert from 'node:assert';
import { safeWalmartPrice, assertAboveCost } from './pricing.js';
import { computePriceFloor, nonRecoverableTaxRateFor, worstCaseNonRecoverableTaxRate } from './pricing/landedCost.js';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  [OK] ${name}`);
}

// Floor applies when Shopify price is below the real landed-cost floor.
check('floors a below-cost Shopify price up to the landed-cost floor', () => {
  const p = safeWalmartPrice({ shopifyPrice: 285, cost: 330, tireType: 'Passenger', rimSize: 15 })!;
  const expected = computePriceFloor({ productCost: 330, tireType: 'Passenger', rimSize: 15 }, 0.10, 0.20, 'typical-zone').floor;
  assert.ok(p >= expected - 0.02, `expected >= floor ${expected}, got ${p}`);
});

// Uses Shopify price when it is comfortably above the floor.
check('keeps Shopify price when above floor', () => {
  const p = safeWalmartPrice({ shopifyPrice: 999, cost: 24.97, tireType: 'Passenger', rimSize: 15 })!;
  assert.strictEqual(p, roundedNear99(999));
});

// Missing cost -> null (caller must skip).
check('returns null when cost is missing', () => {
  assert.strictEqual(safeWalmartPrice({ shopifyPrice: 285, cost: null }), null);
  assert.strictEqual(safeWalmartPrice({ shopifyPrice: 285, cost: 0 }), null);
});

// No Shopify price but valid cost -> floor (never below floor).
check('falls back to floor when Shopify price is missing', () => {
  const p = safeWalmartPrice({ shopifyPrice: null, cost: 100, tireType: 'Passenger', rimSize: 15 })!;
  const expected = computePriceFloor({ productCost: 100, tireType: 'Passenger', rimSize: 15 }, 0.10, 0.20, 'typical-zone').floor;
  assert.ok(p >= expected - 0.02, `expected >= floor ${expected}, got ${p}`);
});

// The real cancelled-order SKU (TIRE-170034002, cost $330, sold at $285 -
// the stuck-price bug walmart-price-correct.ts exists to fix): must never
// price below the real floor, not just above raw cost.
check('TIRE-170034002 case never prices below the real landed-cost floor', () => {
  const p = safeWalmartPrice({ shopifyPrice: 285, cost: 330, tireType: 'Passenger', rimSize: 15 })!;
  const expected = computePriceFloor({ productCost: 330, tireType: 'Passenger', rimSize: 15 }, 0.10, 0.20, 'typical-zone').floor;
  assert.ok(p >= expected - 0.02);
});

// Regression anchor: MV864, a real historical underwater listing. Confirms
// the new floor would have caught it (old formula did not).
check('MV864 regression: real historical underwater SKU is now correctly floored', () => {
  const p = safeWalmartPrice({ shopifyPrice: 78.99, cost: 24.97, ecoFee: 6.00, tireType: 'Passenger', rimSize: 15 })!;
  assert.ok(p > 78.99, `floor should have raised the $78.99 listing, got ${p}`);
  assert.ok(p >= 100, `expected a floor comfortably above $100 for this SKU, got ${p}`);
});

// Unknown tireType/rimSize (caller hasn't been updated to pass real specs
// yet) must fail SAFE - i.e. floor at least as high as the most
// conservative real SKU we've measured, never silently skip the floor.
check('missing tireType/rimSize falls back to the conservative default, never skips the floor', () => {
  const p = safeWalmartPrice({ shopifyPrice: 50, cost: 100 })!;
  assert.ok(p > 100, `expected fallback floor to exceed raw cost, got ${p}`);
});

// Regression anchor: SKU 300E3009 (Ovation W-686 Ecovision 185/65R15,
// Passenger/rim 15, cost $72.54). Every safeWalmartPrice() caller in the repo
// omitted tireType/rimSize, so this SKU silently got the LT/rim-22 fallback
// freight class ($103 typical-zone) instead of its real Passenger/15 class
// ($43) — inflating its floor to $261.99 versus a real Shopify price of
// $174.99, an $87 gap Walmart's own pricing algorithm read as "listed too
// high" (the same failure mode that produced the account's "Unpublished —
// due to its high price" listings). With the real tireType/rimSize now
// threaded through, the floor must land close to the real Shopify price,
// not the wildly-padded LT/22 figure.
check('SKU 300E3009 no longer inflated to the LT/rim-22 fallback floor', () => {
  const wrongFallback = safeWalmartPrice({ shopifyPrice: 174.99, cost: 72.54 })!;
  assert.strictEqual(wrongFallback, 261.99, `sanity check on the bug itself: expected the old $261.99, got ${wrongFallback}`);

  const fixed = safeWalmartPrice({ shopifyPrice: 174.99, cost: 72.54, tireType: 'Passenger', rimSize: 15 })!;
  assert.ok(fixed < 180, `expected a floor near the real $174.99 Shopify price, got ${fixed}`);
});

// Assertion backstop throws on a deliberate below-cost amount.
check('assertAboveCost throws on below-cost amount', () => {
  assert.throws(() => assertAboveCost('TIRE-X', 285, 330), /BLOCKED/);
});

check('assertAboveCost passes when amount >= cost', () => {
  assert.doesNotThrow(() => assertAboveCost('TIRE-X', 379.99, 330));
});

// Confirmed with Pat 2026-08-22: GST/HST registered, PST/QST not registered.
// HST provinces must show ZERO non-recoverable tax (fully recoverable via
// ITC) — the old flat-12% guess was silently over-taxing these, which is
// most of Canada's population (ON/NS/NB/PE/NL + AB/territories GST-only).
check('HST/GST-only provinces have zero non-recoverable tax', () => {
  assert.strictEqual(nonRecoverableTaxRateFor('ON'), 0);
  assert.strictEqual(nonRecoverableTaxRateFor('AB'), 0);
});

// QC/BC/SK/MB are the only provinces GCI can't recover tax in (not
// registered for QST/PST). QC is highest at 9.975% and is GCI's own home
// province — the worst-case default the price floor should protect against.
check('QC/BC/SK/MB have the expected non-recoverable rates, QC is worst-case', () => {
  assert.strictEqual(nonRecoverableTaxRateFor('QC'), 0.09975);
  assert.strictEqual(nonRecoverableTaxRateFor('BC'), 0.07);
  assert.strictEqual(nonRecoverableTaxRateFor('SK'), 0.06);
  assert.strictEqual(nonRecoverableTaxRateFor('MB'), 0.07);
  assert.strictEqual(worstCaseNonRecoverableTaxRate(), 0.09975);
});

function roundedNear99(n: number): number {
  return Math.ceil(n) - 0.01;
}

console.log(`\n${passed} pricing tests passed.`);

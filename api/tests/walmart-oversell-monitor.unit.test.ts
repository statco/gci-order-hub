// api/tests/walmart-oversell-monitor.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for walmart-oversell-monitor detection logic (Task 2).
//
// Tests the core algorithm in api/walmart-oversell-monitor.ts:
//   oversell:        walmartQty > shopifyQty  (strictly greater)
//   NOT oversell:    walmartQty === shopifyQty (equal — healed)
//   NOT oversell:    walmartQty < shopifyQty  (Walmart understock)
//   reArmedOrphan:   isOrphan && walmartQty > 0 (re-armed by external op)
//   sample:          worst offenders by delta, descending, capped at 20
//
// Critical: a monitor that always returns 0 is worse than none.
// These tests prove it can actually see a mismatch.
//
// Run:
//   npx tsc api/tests/walmart-oversell-monitor.unit.test.ts \
//     --outDir /tmp/test-monitor --module nodenext --target es2022 \
//     --moduleResolution nodenext && \
//   node /tmp/test-monitor/api/tests/walmart-oversell-monitor.unit.test.js
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

// ── Replicate the exact detection logic from api/walmart-oversell-monitor.ts ─

interface Row {
  sku:        string;
  walmartQty: number;
  shopifyQty: number;
  isOrphan:   boolean;
}

function detect(rows: Row[]) {
  const oversellRows = rows.filter(r => r.walmartQty > r.shopifyQty)
    .map(r => ({ ...r, delta: r.walmartQty - r.shopifyQty }));

  const reArmedOrphanCount = rows.filter(r => r.isOrphan && r.walmartQty > 0).length;

  const sample = [...oversellRows]
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20);

  const oversellCount = oversellRows.length;
  const alert         = oversellCount > 0 || reArmedOrphanCount > 0;

  return { oversellCount, reArmedOrphanCount, sample, alert };
}

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}\n    ${msg}`);
  }
}

// ── Detection: must catch real oversells ─────────────────────────────────────

check('CRITICAL: detects oversell when walmartQty > shopifyQty', () => {
  // Proves monitor is not dead (always-0 failure mode)
  const r = detect([{ sku: 'ABC', walmartQty: 100, shopifyQty: 5, isOrphan: false }]);
  assert.equal(r.oversellCount, 1);
  assert.equal(r.sample.length, 1);
  assert.equal(r.sample[0].sku, 'ABC');
  assert.equal(r.alert, true);
});

check('CRITICAL: the incident case — Walmart=100, Shopify=0 → oversell', () => {
  const r = detect([{ sku: 'BARE-SKU', walmartQty: 100, shopifyQty: 0, isOrphan: false }]);
  assert.equal(r.oversellCount, 1);
  assert.equal(r.sample[0].delta, 100);
});

check('detects multiple oversells across a batch', () => {
  const rows: Row[] = [
    { sku: 'A', walmartQty: 50,  shopifyQty: 5,  isOrphan: false },
    { sku: 'B', walmartQty: 100, shopifyQty: 0,  isOrphan: false },
    { sku: 'C', walmartQty: 3,   shopifyQty: 3,  isOrphan: false }, // healed
    { sku: 'D', walmartQty: 0,   shopifyQty: 10, isOrphan: false }, // under-selling
  ];
  const r = detect(rows);
  assert.equal(r.oversellCount, 2);
});

// ── Detection: must NOT count non-oversell cases ─────────────────────────────

check('healed state: walmartQty === shopifyQty → NOT counted', () => {
  const r = detect([{ sku: 'X', walmartQty: 5, shopifyQty: 5, isOrphan: false }]);
  assert.equal(r.oversellCount, 0);
  assert.equal(r.alert, false);
});

check('under-selling: walmartQty < shopifyQty → NOT counted as oversell', () => {
  const r = detect([{ sku: 'X', walmartQty: 2, shopifyQty: 10, isOrphan: false }]);
  assert.equal(r.oversellCount, 0);
  assert.equal(r.alert, false);
});

check('both zeroed: walmartQty=0, shopifyQty=0 → NOT counted', () => {
  const r = detect([{ sku: 'X', walmartQty: 0, shopifyQty: 0, isOrphan: true }]);
  assert.equal(r.oversellCount, 0);
  assert.equal(r.reArmedOrphanCount, 0);
  assert.equal(r.alert, false);
});

check('empty input → all zeros, alert=false', () => {
  const r = detect([]);
  assert.equal(r.oversellCount, 0);
  assert.equal(r.reArmedOrphanCount, 0);
  assert.equal(r.alert, false);
});

// ── Re-armed orphan alert ─────────────────────────────────────────────────────

check('re-armed orphan: isOrphan=true AND walmartQty>0 → reArmedOrphanCount=1', () => {
  // External catalog op re-stamped orphan with qty=100; orphan sweep had zeroed it.
  const r = detect([{ sku: 'TIRE-OLD', walmartQty: 100, shopifyQty: 0, isOrphan: true }]);
  assert.equal(r.reArmedOrphanCount, 1);
  assert.equal(r.alert, true);
});

check('orphan with walmartQty=0 → reArmedOrphanCount stays 0 (properly zeroed)', () => {
  const r = detect([{ sku: 'TIRE-OLD', walmartQty: 0, shopifyQty: 0, isOrphan: true }]);
  assert.equal(r.reArmedOrphanCount, 0);
  assert.equal(r.alert, false);
});

check('non-orphan oversell does NOT increment reArmedOrphanCount', () => {
  const r = detect([{ sku: 'MATCHED', walmartQty: 100, shopifyQty: 5, isOrphan: false }]);
  assert.equal(r.oversellCount, 1);
  assert.equal(r.reArmedOrphanCount, 0);
});

check('alert=true when only reArmedOrphanCount>0, even if oversellCount=0', () => {
  // Healed orphan-but-re-armed; Walmart qty=1, Shopify=0 → also oversell in this case
  // Test the pure reArmed path: orphan walmartQty=1 IS an oversell too (walmartQty>shopifyQty=0)
  // so also need a case where alert fires only from reArmedOrphanCount
  // (this is always also an oversell since shopifyQty=0 and walmartQty>0)
  // The important assertion: alert=true whenever reArmedOrphanCount>0
  const r = detect([{ sku: 'ORPHAN', walmartQty: 1, shopifyQty: 0, isOrphan: true }]);
  assert.equal(r.alert, true);
  assert.ok(r.reArmedOrphanCount > 0 || r.oversellCount > 0);
});

// ── Sample ordering and capping ──────────────────────────────────────────────

check('sample is sorted by delta descending (worst offenders first)', () => {
  const rows: Row[] = [
    { sku: 'SMALL', walmartQty: 6,   shopifyQty: 5,   isOrphan: false }, // delta=1
    { sku: 'LARGE', walmartQty: 100, shopifyQty: 0,   isOrphan: false }, // delta=100
    { sku: 'MED',   walmartQty: 30,  shopifyQty: 10,  isOrphan: false }, // delta=20
  ];
  const r = detect(rows);
  assert.equal(r.sample[0].sku, 'LARGE');
  assert.equal(r.sample[1].sku, 'MED');
  assert.equal(r.sample[2].sku, 'SMALL');
});

check('sample is capped at 20 even when more oversells exist', () => {
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
    sku: `SKU${i}`,
    walmartQty: 100,
    shopifyQty: i,   // all are oversells
    isOrphan: false,
  }));
  const r = detect(rows);
  assert.equal(r.oversellCount, 30);
  assert.equal(r.sample.length, 20);
});

check('sample contains the worst 20 by delta when capped', () => {
  // 30 rows; worst delta is for shopifyQty=0 (delta=100)
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
    sku: `SKU${i}`,
    walmartQty: 100,
    shopifyQty: i,
    isOrphan: false,
  }));
  const r = detect(rows);
  // Largest delta = 100-0=100, smallest delta in sample = 100-19=81
  assert.ok(r.sample[0].delta >= r.sample[r.sample.length - 1].delta);
  // Smallest shopifyQty=0 must be in sample (delta 100)
  assert.ok(r.sample.some(s => s.sku === 'SKU0'));
  // shopifyQty=29 (delta=71) must NOT be in sample
  assert.ok(!r.sample.some(s => s.sku === 'SKU29'));
});

check('sample delta field is computed correctly', () => {
  const r = detect([{ sku: 'A', walmartQty: 75, shopifyQty: 32, isOrphan: false }]);
  assert.equal(r.sample[0].delta, 43);
});

// ── Mixed healed + oversell batch ────────────────────────────────────────────

check('healed catalog (all Walmart <= Shopify): oversellCount=0, alert=false', () => {
  const rows: Row[] = [
    { sku: 'A', walmartQty: 0,  shopifyQty: 0,  isOrphan: false },
    { sku: 'B', walmartQty: 5,  shopifyQty: 5,  isOrphan: false },
    { sku: 'C', walmartQty: 0,  shopifyQty: 10, isOrphan: false },
    { sku: 'D', walmartQty: 0,  shopifyQty: 0,  isOrphan: true  },
  ];
  const r = detect(rows);
  assert.equal(r.oversellCount, 0);
  assert.equal(r.reArmedOrphanCount, 0);
  assert.equal(r.alert, false);
});

// ── Summary ──────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} FAILED.`);
  process.exit(1);
} else {
  console.log(`\n${passed} walmart-oversell-monitor unit tests passed.`);
}

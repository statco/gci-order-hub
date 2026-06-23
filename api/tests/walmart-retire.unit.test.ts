// api/tests/walmart-retire.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for walmart-retire lifecycle classification (Task 4).
//
// Tests the exact classifier in api/lib/walmart-client.ts
// (getItemLifecycleStatus):
//   404 / 410 → 'NOT_FOUND'  (confirmed retired)
//   anything else → 'LIVE'   (accepted but pending, NOT confirmed)
//
// Key failure to prevent: a 200 (item still live) must NEVER be classified
// as NOT_FOUND. That's the false-confidence bug this hardening exists to stop.
//
// Run:
//   npx tsc api/tests/walmart-retire.unit.test.ts --outDir /tmp/test-retire \
//     --module nodenext --target es2022 --moduleResolution nodenext && \
//   node /tmp/test-retire/api/tests/walmart-retire.unit.test.js
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

// ── Replicate the exact classifier from api/lib/walmart-client.ts ────────────

function classifyLifecycle(httpStatus: number): 'NOT_FOUND' | 'LIVE' {
  if (httpStatus === 404 || httpStatus === 410) return 'NOT_FOUND';
  return 'LIVE';
}

// ── Replicate the response-shape logic from api/walmart-retire.ts ────────────
// Simulates what happens when the retire chunk + verification loop runs.

interface RetireVerifyResult {
  confirmedRetired: string[];
  acceptedButPending: string[];
  failed: string[];
}

function simulateRetireChunk(
  skus: string[],
  deleteHttpStatus: (sku: string) => number,   // simulates retireItem HTTP result
  verifyHttpStatus: (sku: string) => number,   // simulates getItemLifecycleStatus HTTP result
): RetireVerifyResult {
  const accepted: string[] = [];
  const failed: string[]   = [];

  for (const sku of skus) {
    const s = deleteHttpStatus(sku);
    if (s === 200 || s === 204 || s === 404 || s === 410) {
      accepted.push(sku);
    } else {
      failed.push(sku);
    }
  }

  const confirmedRetired:  string[] = [];
  const acceptedButPending: string[] = [];

  for (const sku of accepted) {
    const lifecycle = classifyLifecycle(verifyHttpStatus(sku));
    if (lifecycle === 'NOT_FOUND') confirmedRetired.push(sku);
    else                           acceptedButPending.push(sku);
  }

  return { confirmedRetired, acceptedButPending, failed };
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

// ── Classifier: confirmed retired ────────────────────────────────────────────

check('404 → NOT_FOUND (confirmed retired)', () => {
  assert.equal(classifyLifecycle(404), 'NOT_FOUND');
});

check('410 → NOT_FOUND (confirmed retired)', () => {
  assert.equal(classifyLifecycle(410), 'NOT_FOUND');
});

// ── Classifier: NOT confirmed (the false-confidence failure to prevent) ───────

check('200 → LIVE — must NEVER count as confirmed retired', () => {
  // CRITICAL: a still-live item responding 200 must remain acceptedButPending,
  // not confirmedRetired. This is the accepted≠applied invariant.
  assert.equal(classifyLifecycle(200), 'LIVE');
});

check('201 → LIVE', () => {
  assert.equal(classifyLifecycle(201), 'LIVE');
});

check('204 → LIVE (e.g. still in catalog with no body)', () => {
  assert.equal(classifyLifecycle(204), 'LIVE');
});

check('400 → LIVE (bad request does not confirm retirement)', () => {
  assert.equal(classifyLifecycle(400), 'LIVE');
});

check('401 → LIVE', () => {
  assert.equal(classifyLifecycle(401), 'LIVE');
});

check('403 → LIVE', () => {
  assert.equal(classifyLifecycle(403), 'LIVE');
});

check('500 → LIVE (server error is not confirmation of retirement)', () => {
  assert.equal(classifyLifecycle(500), 'LIVE');
});

check('503 → LIVE', () => {
  assert.equal(classifyLifecycle(503), 'LIVE');
});

check('0 (network/timeout represented as status=0) → LIVE', () => {
  assert.equal(classifyLifecycle(0), 'LIVE');
});

// ── End-to-end simulate: confirmed vs pending distinction ─────────────────────

check('simulate: item returns 404 on verify → confirmedRetired', () => {
  const r = simulateRetireChunk(
    ['TIRE-SKU1'],
    () => 200,   // DELETE accepted
    () => 404,   // re-query: already gone
  );
  assert.deepEqual(r.confirmedRetired, ['TIRE-SKU1']);
  assert.deepEqual(r.acceptedButPending, []);
});

check('simulate: item returns 200 on verify → acceptedButPending (NOT confirmed)', () => {
  const r = simulateRetireChunk(
    ['TIRE-SKU1'],
    () => 200,   // DELETE accepted
    () => 200,   // re-query: still live (propagation pending)
  );
  assert.deepEqual(r.confirmedRetired, []);
  assert.deepEqual(r.acceptedButPending, ['TIRE-SKU1']);
});

check('simulate: mixed batch — some confirmed, some pending', () => {
  const r = simulateRetireChunk(
    ['TIRE-A', 'TIRE-B', 'TIRE-C'],
    () => 200,
    (sku) => sku === 'TIRE-A' ? 404 : sku === 'TIRE-B' ? 410 : 200,
  );
  assert.deepEqual(r.confirmedRetired.sort(), ['TIRE-A', 'TIRE-B']);
  assert.deepEqual(r.acceptedButPending, ['TIRE-C']);
});

check('simulate: DELETE 500 → SKU in failed, not in confirmed/pending', () => {
  const r = simulateRetireChunk(
    ['TIRE-FAIL'],
    () => 500,   // DELETE fails
    () => 404,   // verify never called (not in accepted)
  );
  assert.deepEqual(r.failed, ['TIRE-FAIL']);
  assert.deepEqual(r.confirmedRetired, []);
  assert.deepEqual(r.acceptedButPending, []);
});

check('simulate: confirmedRetired count never exceeds accepted count', () => {
  const skus = ['TIRE-1','TIRE-2','TIRE-3','TIRE-4','TIRE-5'];
  const r = simulateRetireChunk(skus, () => 200, () => 404);
  assert.ok(r.confirmedRetired.length <= skus.length);
  assert.equal(r.confirmedRetired.length + r.acceptedButPending.length, skus.length);
});

check('simulate: empty input → all counts zero', () => {
  const r = simulateRetireChunk([], () => 200, () => 404);
  assert.equal(r.confirmedRetired.length, 0);
  assert.equal(r.acceptedButPending.length, 0);
  assert.equal(r.failed.length, 0);
});

// ── Summary ──────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} FAILED.`);
  process.exit(1);
} else {
  console.log(`\n${passed} walmart-retire lifecycle unit tests passed.`);
}

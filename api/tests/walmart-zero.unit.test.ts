// api/tests/walmart-zero.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for walmart-zero server-side chunking logic (Task 3).
//
// Tests the exact algorithm in api/walmart-zero.ts:
//   chunkSkus  = uniqueMatched.slice(offset, offset + limit)
//   nextOffset = offset + limit < totalMatched ? offset + limit : null
//   done       = nextOffset === null
//
// Run:
//   npx tsc api/tests/walmart-zero.unit.test.ts --outDir /tmp/test-zero \
//     --module nodenext --target es2022 --moduleResolution nodenext && \
//   node /tmp/test-zero/api/tests/walmart-zero.unit.test.js
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

// ── Replicate the exact chunking algorithm from api/walmart-zero.ts ─────────

function applyChunk(uniqueMatched: string[], offset: number, limit: number) {
  const totalMatched = uniqueMatched.length;
  const chunkSkus    = uniqueMatched.slice(offset, offset + limit);
  const nextOffset   = offset + limit < totalMatched ? offset + limit : null;
  const done         = nextOffset === null;
  return { chunkSkus, nextOffset, done, totalMatched, processed: chunkSkus.length };
}

// Walk the full matched list chunk by chunk, collecting all processed SKUs.
function fullWalk(uniqueMatched: string[], limit: number): string[] {
  const collected: string[] = [];
  let offset = 0;
  let iterations = 0;
  const MAX_ITERS = uniqueMatched.length + 10; // guard against infinite loop

  while (iterations++ < MAX_ITERS) {
    const { chunkSkus, nextOffset, done } = applyChunk(uniqueMatched, offset, limit);
    collected.push(...chunkSkus);
    if (done) break;
    offset = nextOffset!;
  }
  return collected;
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

// ── Basic chunking ───────────────────────────────────────────────────────────

const SKUS10 = ['A','B','C','D','E','F','G','H','I','J'];

check('first chunk: correct slice and nextOffset', () => {
  const r = applyChunk(SKUS10, 0, 3);
  assert.deepEqual(r.chunkSkus, ['A','B','C']);
  assert.equal(r.nextOffset, 3);
  assert.equal(r.done, false);
});

check('middle chunk: correct slice and nextOffset', () => {
  const r = applyChunk(SKUS10, 6, 3);
  assert.deepEqual(r.chunkSkus, ['G','H','I']);
  assert.equal(r.nextOffset, 9);
  assert.equal(r.done, false);
});

check('last chunk (limit exactly divides set): done=true, nextOffset=null', () => {
  // 9 SKUs, limit=3, offset=6 → chunk=[G,H,I], that's positions 6,7,8 of a 9-item list
  const skus9 = SKUS10.slice(0, 9);
  const r = applyChunk(skus9, 6, 3);
  assert.deepEqual(r.chunkSkus, ['G','H','I']);
  assert.equal(r.nextOffset, null);
  assert.equal(r.done, true);
});

check('last chunk (partial, fewer items than limit): done=true', () => {
  // 7 SKUs, limit=3, offset=6 → only 1 item in last chunk
  const skus7 = SKUS10.slice(0, 7);
  const r = applyChunk(skus7, 6, 3);
  assert.deepEqual(r.chunkSkus, ['G']);
  assert.equal(r.nextOffset, null);
  assert.equal(r.done, true);
});

check('limit larger than set: single chunk, done=true immediately', () => {
  const r = applyChunk(['X','Y','Z'], 0, 50);
  assert.deepEqual(r.chunkSkus, ['X','Y','Z']);
  assert.equal(r.nextOffset, null);
  assert.equal(r.done, true);
});

check('offset exactly at set boundary: empty chunk, done=true', () => {
  const r = applyChunk(['X','Y','Z'], 3, 10);
  assert.deepEqual(r.chunkSkus, []);
  assert.equal(r.done, true);
});

check('offset past end: empty chunk, done=true', () => {
  const r = applyChunk(['X','Y','Z'], 100, 10);
  assert.deepEqual(r.chunkSkus, []);
  assert.equal(r.done, true);
});

check('empty input: empty chunk, done=true', () => {
  const r = applyChunk([], 0, 50);
  assert.deepEqual(r.chunkSkus, []);
  assert.equal(r.done, true);
});

// ── Off-by-one boundary cases ────────────────────────────────────────────────

check('off-by-one: limit exactly equals set size, offset=0 → done=true', () => {
  const r = applyChunk(['A','B','C'], 0, 3);
  assert.deepEqual(r.chunkSkus, ['A','B','C']);
  assert.equal(r.done, true);
});

check('off-by-one: last chunk starts at set.length-1 → single item, done=true', () => {
  const r = applyChunk(SKUS10, 9, 3); // only 'J' remains
  assert.deepEqual(r.chunkSkus, ['J']);
  assert.equal(r.done, true);
});

check('off-by-one: nextOffset lands exactly at set.length → done=true', () => {
  // 6 SKUs, limit=3, offset=3: chunkSkus=[D,E,F], nextOffset would be 6 = length → null
  const r = applyChunk(SKUS10.slice(0, 6), 3, 3);
  assert.deepEqual(r.chunkSkus, ['D','E','F']);
  assert.equal(r.nextOffset, null);
  assert.equal(r.done, true);
});

// ── Full-walk completeness invariants ────────────────────────────────────────

check('full walk: no SKU dropped (7 SKUs, limit=3)', () => {
  const skus = ['A','B','C','D','E','F','G'];
  const collected = fullWalk(skus, 3);
  assert.deepEqual(collected.sort(), skus.sort());
});

check('full walk: no SKU duplicated (7 SKUs, limit=3)', () => {
  const skus = ['A','B','C','D','E','F','G'];
  const collected = fullWalk(skus, 3);
  assert.equal(new Set(collected).size, collected.length, 'duplicates found');
});

check('full walk: exactly N SKUs returned for limit that does not divide evenly', () => {
  const skus = Array.from({ length: 17 }, (_, i) => `SKU${i}`);
  const collected = fullWalk(skus, 5);
  assert.equal(collected.length, 17);
});

check('full walk: exactly N SKUs returned when limit divides evenly', () => {
  const skus = Array.from({ length: 15 }, (_, i) => `SKU${i}`);
  const collected = fullWalk(skus, 5);
  assert.equal(collected.length, 15);
});

check('full walk: single item list terminates in one chunk', () => {
  const collected = fullWalk(['ONLY'], 50);
  assert.deepEqual(collected, ['ONLY']);
});

// ── Matching / dedup logic (replicates Set dedup in walmart-zero.ts) ─────────

check('dedup: bare + TIRE- same underlying SKU counts as one item per form', () => {
  // Source sends both bare AND TIRE- forms if both are listed; Set deduplicates.
  const matched = ['ABC', 'TIRE-ABC', 'ABC']; // 'ABC' appears twice
  const unique = [...new Set(matched)];
  assert.equal(unique.length, 2);
  assert.ok(unique.includes('ABC'));
  assert.ok(unique.includes('TIRE-ABC'));
});

check('dedup: identical bare SKUs collapsed to one', () => {
  const matched = ['SKU1', 'SKU1', 'SKU1'];
  const unique = [...new Set(matched)];
  assert.equal(unique.length, 1);
});

// ── Summary ──────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} FAILED.`);
  process.exit(1);
} else {
  console.log(`\n${passed} walmart-zero chunking unit tests passed.`);
}

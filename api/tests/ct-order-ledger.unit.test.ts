// api/tests/ct-order-ledger.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for the CT order idempotency ledger's pure logic:
// PO number construction, status transitions, and secret redaction.
//
// These tests never touch Canada Tire and never touch Supabase. Everything
// under test is a pure function; the transport paths are deliberately not
// exercised here.
//
// Run:
//   npx tsc api/tests/ct-order-ledger.unit.test.ts api/lib/ct-order-ledger.ts \
//     --outDir /tmp/test-ledger --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   node /tmp/test-ledger/tests/ct-order-ledger.unit.test.js
//
// (tsc infers rootDir=api/ from the two inputs, so the output lands in
//  tests/ and lib/ rather than under an api/ prefix.)
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import {
  buildPoNumber,
  canTransition,
  assertTransition,
  isTerminal,
  isAutoRetryable,
  requiresHumanReconciliation,
  redactSecrets,
  CTLedgerError,
  TERMINAL_STATUSES,
  type CTOrderStatus,
} from '../lib/ct-order-ledger.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const ALL_STATUSES: CTOrderStatus[] = [
  'claimed', 'submitted', 'indeterminate', 'failed', 'manual_required', 'cancelled',
];

// ── buildPoNumber ───────────────────────────────────────────────────────────

console.log('\nbuildPoNumber');

test('shopify strips the leading # from the order name', () => {
  assert.equal(buildPoNumber('shopify', '#1042'), 'GCI-S-1042');
});

test('shopify handles an order name with no #', () => {
  assert.equal(buildPoNumber('shopify', '1042'), 'GCI-S-1042');
});

test('walmart uses the purchase order id verbatim', () => {
  assert.equal(buildPoNumber('walmart', '1796277083022'), 'GCI-W-1796277083022');
});

test('is deterministic — same input always yields the same PO number', () => {
  const a = buildPoNumber('shopify', '#1042');
  const b = buildPoNumber('shopify', '#1042');
  assert.equal(a, b);
});

test('is stable across surrounding whitespace, so a replayed webhook collides', () => {
  assert.equal(buildPoNumber('shopify', '  #1042 '), 'GCI-S-1042');
  assert.equal(buildPoNumber('walmart', ' 1796277083022'), 'GCI-W-1796277083022');
});

test('shopify and walmart namespaces never collide on the same id', () => {
  assert.notEqual(buildPoNumber('shopify', '447268'), buildPoNumber('walmart', '447268'));
});

test('cannot collide with the human-assigned manual format GCI-2026-447268', () => {
  // The manual format is GCI-<4-digit year>-<seq>. Ours is GCI-<letter>-<id>.
  // A single letter is never a four-digit year, so the namespaces are disjoint
  // no matter what the ids are.
  const manual = 'GCI-2026-447268';
  assert.notEqual(buildPoNumber('shopify', '447268'), manual);
  assert.notEqual(buildPoNumber('walmart', '447268'), manual);
  assert.notEqual(buildPoNumber('shopify', '2026-447268'), manual);

  for (const po of [buildPoNumber('shopify', '447268'), buildPoNumber('walmart', '447268')]) {
    const segment = po.split('-')[1];
    assert.equal(segment.length, 1, `expected a single-letter segment, got '${segment}'`);
    assert.ok(!/^\d{4}$/.test(segment), 'segment must never look like a year');
  }
});

test('preserves case — folding it would merge two distinct order names', () => {
  assert.notEqual(buildPoNumber('shopify', 'abc'), buildPoNumber('shopify', 'ABC'));
});

test('sanitizes characters that would break a URL or CSV', () => {
  assert.equal(buildPoNumber('shopify', '10 42'), 'GCI-S-1042');
  assert.equal(buildPoNumber('shopify', 'A/B'), 'GCI-S-A-B');
});

test('refuses to invent a manual PO number', () => {
  assert.throws(() => buildPoNumber('manual', '447268'), CTLedgerError);
});

test('rejects an empty or unusable source order number', () => {
  assert.throws(() => buildPoNumber('shopify', ''), CTLedgerError);
  assert.throws(() => buildPoNumber('shopify', '   '), CTLedgerError);
  assert.throws(() => buildPoNumber('shopify', '#'), CTLedgerError);
  assert.throws(() => buildPoNumber('walmart', '///'), CTLedgerError);
});

// ── Status transitions ──────────────────────────────────────────────────────

console.log('\nstatus transitions');

test('a fresh claim can reach every outcome', () => {
  for (const to of ALL_STATUSES.filter(s => s !== 'claimed')) {
    assert.ok(canTransition('claimed', to), `claimed → ${to} should be allowed`);
  }
});

test('submitted is terminal apart from a manual void', () => {
  assert.ok(isTerminal('submitted'));
  assert.ok(canTransition('submitted', 'cancelled'));
  for (const to of ALL_STATUSES.filter(s => s !== 'cancelled')) {
    assert.ok(!canTransition('submitted', to), `submitted → ${to} must be rejected`);
  }
});

test('cancelled is fully terminal', () => {
  assert.ok(isTerminal('cancelled'));
  for (const to of ALL_STATUSES) {
    assert.ok(!canTransition('cancelled', to), `cancelled → ${to} must be rejected`);
  }
});

test('TERMINAL_STATUSES is exactly submitted and cancelled', () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['cancelled', 'submitted']);
});

test('failed is resubmittable — it is a definitive rejection, nothing was created', () => {
  assert.ok(canTransition('failed', 'claimed'));
  assert.ok(canTransition('failed', 'submitted'));
});

test('manual_required can be resolved by a human in either direction', () => {
  assert.ok(canTransition('manual_required', 'submitted'));
  assert.ok(canTransition('manual_required', 'cancelled'));
  assert.ok(canTransition('manual_required', 'claimed'));
});

test('indeterminate can be resolved, but never back to a bare claim', () => {
  assert.ok(canTransition('indeterminate', 'submitted'));
  assert.ok(canTransition('indeterminate', 'failed'));
  assert.ok(canTransition('indeterminate', 'cancelled'));
  // Returning it to 'claimed' would make it eligible for automated submission
  // again — that is precisely the double-order path.
  assert.ok(!canTransition('indeterminate', 'claimed'),
    'indeterminate → claimed must be rejected: it would re-arm auto-submission');
});

test('assertTransition throws on an illegal move', () => {
  assert.throws(() => assertTransition('cancelled', 'submitted'), CTLedgerError);
  assert.doesNotThrow(() => assertTransition('claimed', 'submitted'));
});

// ── The safety predicate ────────────────────────────────────────────────────

console.log('\nauto-retry safety');

test('indeterminate is NEVER auto-retryable — this is the whole point', () => {
  // CT may already hold the order. Retrying bills the credit line twice.
  assert.equal(isAutoRetryable('indeterminate'), false);
});

test('only claimed and failed are auto-retryable', () => {
  assert.ok(isAutoRetryable('claimed'));
  assert.ok(isAutoRetryable('failed'));
  for (const s of ['submitted', 'indeterminate', 'manual_required', 'cancelled'] as CTOrderStatus[]) {
    assert.equal(isAutoRetryable(s), false, `${s} must not be auto-retryable`);
  }
});

test('no terminal status is auto-retryable', () => {
  for (const s of TERMINAL_STATUSES) {
    assert.equal(isAutoRetryable(s), false);
  }
});

test('indeterminate and manual_required both need a human', () => {
  assert.ok(requiresHumanReconciliation('indeterminate'));
  assert.ok(requiresHumanReconciliation('manual_required'));
  for (const s of ['claimed', 'submitted', 'failed', 'cancelled'] as CTOrderStatus[]) {
    assert.equal(requiresHumanReconciliation(s), false);
  }
});

// ── Redaction ───────────────────────────────────────────────────────────────

console.log('\nsecret redaction');

test('strips customerToken at the top level', () => {
  const out = redactSecrets({ customerId: '19997', customerToken: 'super-secret' });
  assert.equal(out.customerToken, '***REDACTED***');
  assert.equal(out.customerId, '19997');
});

test('strips customerToken nested inside the payload', () => {
  const out = redactSecrets({ orderDetails: { poNumber: 'GCI-S-1042', customerToken: 'secret' } });
  assert.equal((out.orderDetails as any).customerToken, '***REDACTED***');
  assert.equal((out.orderDetails as any).poNumber, 'GCI-S-1042');
});

test('strips secrets inside arrays', () => {
  const out = redactSecrets({ attempts: [{ customerToken: 'a' }, { customerToken: 'b' }] });
  for (const a of out.attempts as any[]) assert.equal(a.customerToken, '***REDACTED***');
});

test('is case-insensitive about key names', () => {
  const out = redactSecrets({ CustomerToken: 'x', CONSUMERSECRET: 'y', Authorization: 'z' });
  assert.equal(out.CustomerToken, '***REDACTED***');
  assert.equal(out.CONSUMERSECRET, '***REDACTED***');
  assert.equal(out.Authorization, '***REDACTED***');
});

test('leaves the reconciliation-relevant fields intact', () => {
  const payload = {
    customerId: '19997',
    customerToken: 'secret',
    orderDetails: {
      poNumber: 'GCI-S-1042',
      location: 'Toronto, ON',
      items: [{ partNumber: '200E1059', quantity: 4 }],
    },
  };
  const out = redactSecrets(payload);
  assert.equal(out.orderDetails.location, 'Toronto, ON');
  assert.equal(out.orderDetails.items[0].partNumber, '200E1059');
  assert.equal(out.orderDetails.items[0].quantity, 4);
  assert.equal(out.customerToken, '***REDACTED***');
});

test('does not mutate the caller\'s object', () => {
  const payload = { customerToken: 'secret' };
  redactSecrets(payload);
  assert.equal(payload.customerToken, 'secret', 'the original must be left alone');
});

test('passes primitives and null through untouched', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets('plain'), 'plain');
  assert.equal(redactSecrets(42), 42);
});

test('survives a cyclic payload without hanging', () => {
  const cyclic: any = { customerToken: 'secret' };
  cyclic.self = cyclic;
  const out = redactSecrets(cyclic);
  assert.equal(out.customerToken, '***REDACTED***');
});

console.log(`\n✅ ${passed} assertions passed\n`);

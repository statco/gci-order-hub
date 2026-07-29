// api/tests/ct-order-ledger.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for the CT order idempotency ledger's pure logic:
// PO number formatting, status transitions, and secret redaction.
//
// These tests never touch Canada Tire and never touch Supabase. buildPoNumber()
// itself now calls Supabase (via nextPoSequence()) to mint the atomic sequence
// value, so only its validation guards are exercised here — both throw before
// any await, so no network call ever happens. The pure part of PO number
// construction, formatPoNumber(), is fully covered. The happy path (a real
// sequence value from the live ct_po_number_seq) is not unit-testable without
// a database and is left to integration testing.
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
  formatPoNumber,
  CANONICAL_PO_NUMBER_PATTERN,
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
function test(name: string, fn: () => void | Promise<void>): void {
  const result = fn();
  if (result instanceof Promise) {
    throw new Error(
      `test '${name}' returned a Promise — use asyncTest() instead so a forgotten ` +
      `'await' can't let a failing assertion pass silently.`
    );
  }
  passed++;
  console.log(`  ✓ ${name}`);
}

async function asyncTest(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const ALL_STATUSES: CTOrderStatus[] = [
  'claimed', 'submitted', 'indeterminate', 'failed', 'manual_required', 'cancelled',
];

async function main(): Promise<void> {

// ── formatPoNumber ───────────────────────────────────────────────────────────
// The pure half of PO number construction: the actual shape CT enforces.

console.log('\nformatPoNumber');

test('formats the canonical CT PO number shape', () => {
  assert.equal(formatPoNumber(447300, 2026), 'GCI-2026-447300');
});

test('defaults to the current calendar year when none is given', () => {
  const year = new Date().getFullYear();
  assert.equal(formatPoNumber(447300), `GCI-${year}-447300`);
});

test('matches CANONICAL_PO_NUMBER_PATTERN — the same shape the invoice parser looks for', () => {
  assert.ok(CANONICAL_PO_NUMBER_PATTERN.test(formatPoNumber(447300, 2026)));
  // Real, already-issued manual PO numbers must also satisfy this pattern —
  // it is CT's format, not a format this codebase invented.
  assert.ok(CANONICAL_PO_NUMBER_PATTERN.test('GCI-2026-447267'));
  assert.ok(CANONICAL_PO_NUMBER_PATTERN.test('GCI-2026-447269'));
});

test('two different sequence values never format to the same PO number', () => {
  assert.notEqual(formatPoNumber(447300, 2026), formatPoNumber(447301, 2026));
});

test('the year label changes across a rollover but the sequence keeps counting', () => {
  // GCI-2027-447301 continuing GCI-2026-447300 — the year is a label chosen
  // at generation time, not a partition of the sequence.
  assert.equal(formatPoNumber(447300, 2026), 'GCI-2026-447300');
  assert.equal(formatPoNumber(447301, 2027), 'GCI-2027-447301');
});

test('rejects a non-positive or non-integer sequence value', () => {
  assert.throws(() => formatPoNumber(0), CTLedgerError);
  assert.throws(() => formatPoNumber(-1), CTLedgerError);
  assert.throws(() => formatPoNumber(1.5), CTLedgerError);
});

// ── buildPoNumber ────────────────────────────────────────────────────────────
//
// Only the validation guards are exercised here — channel === 'manual' and an
// empty sourceOrderNumber. Both throw before buildPoNumber() ever awaits
// nextPoSequence(), so these stay true to this file's no-network contract.

console.log('\nbuildPoNumber (validation guards)');

await asyncTest('refuses to invent a manual PO number', async () => {
  await assert.rejects(buildPoNumber('manual', '447268'), CTLedgerError);
});

await asyncTest('rejects an empty or blank source order number', async () => {
  await assert.rejects(buildPoNumber('shopify', ''), CTLedgerError);
  await assert.rejects(buildPoNumber('shopify', '   '), CTLedgerError);
  await assert.rejects(buildPoNumber('shopify', '#'), CTLedgerError);
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
  const out = redactSecrets({ orderDetails: { poNumber: 'GCI-2026-447267', customerToken: 'secret' } });
  assert.equal((out.orderDetails as any).customerToken, '***REDACTED***');
  assert.equal((out.orderDetails as any).poNumber, 'GCI-2026-447267');
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
      poNumber: 'GCI-2026-447267',
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

}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

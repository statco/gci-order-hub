// api/tests/ct-tracking-parser.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for parseInvoicePdf()'s PO-number regex — the invoice-parsing
// half of the canonical GCI-<year>-<seq> PO number format (see
// CANONICAL_PO_NUMBER_SHAPE in ct-order-ledger.ts, which this file's regex
// is built from). Pure function, text in / parsed fields out — no Gmail,
// no Telegram, no network.
//
// Run (from the repo root):
//   npx tsc api/tests/ct-tracking-parser.unit.test.ts api/ct-tracking-parser.ts \
//     api/lib/ct-order-ledger.ts \
//     --outDir /tmp/test-parser --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   NODE_PATH="$PWD/node_modules" node /tmp/test-parser/tests/ct-tracking-parser.unit.test.js
//
// NODE_PATH is required here (unlike ct-order-ledger.unit.test.ts) because
// this file transitively imports ct-tracking-parser.ts, which imports
// 'googleapis' — outside the repo tree, /tmp/test-parser has no node_modules
// of its own to resolve it from.
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { parseInvoicePdf } from '../ct-tracking-parser.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('\nparseInvoicePdf — PO number');

test('matches the canonical GCI-<year>-<seq> format', () => {
  const text = 'Invoice CS-10234 PO #: GCI-2026-447269 Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, 'GCI-2026-447269');
});

test('matches a real live-accepted canonical PO number', () => {
  const text = 'PO #: GCI-2026-447267 Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, 'GCI-2026-447267');
});

test('matches the legacy GCI#### format still present in CT invoice history', () => {
  const text = 'PO # GCI0003 Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, 'GCI0003');
});

test('does not match a malformed value (too few trailing digits for either shape)', () => {
  const text = 'PO # GCI12 Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, null);
});

test('does not match a value with no letter prefix at all', () => {
  const text = 'PO # 123456 Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, null);
});

test('tolerates the pdf2json spacing artifact between the label and the value', () => {
  // The old regex ([ A-Z]{2,4}) smuggled a stray leading space from this
  // exact situation into its capture group instead of consuming it as
  // separator whitespace. Collapsed multi-space and a colon must both work.
  const text = 'PO   #:    GCI-2026-447269   Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, 'GCI-2026-447269');
});

test('tolerates newlines between the label and the value', () => {
  const text = 'PO #\n:\nGCI-2026-447269\nTracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, 'GCI-2026-447269');
});

test('uppercases a lowercase match', () => {
  const text = 'po #: gci-2026-447269 Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, 'GCI-2026-447269');
});

test('is null when there is no PO # label at all', () => {
  const text = 'Invoice CS-10234 Tracking Number: 1Z999AA10123456784';
  assert.equal(parseInvoicePdf(text).poNumber, null);
});

console.log(`\n✅ ${passed} assertions passed\n`);

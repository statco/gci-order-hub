// api/tests/ct-order-routing.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for ct-order-routing.ts's pure Telegram-alert formatting:
// lineItemsSummary(), buildUnknownItemsAlert(), buildCtRoutingAlert().
//
// These never touch Canada Tire, Supabase, Google Sheets, or Telegram —
// routeOrderToCT() itself (the classify → claim → submit orchestration) is
// all network calls end to end and is left to integration testing, same as
// buildPoNumber()'s happy path in ct-order-ledger.unit.test.ts. What's
// exercised here is the part that decides what a human reading the alert
// actually sees, and in particular: that Walmart-only fields (PO#, order#,
// ship-by/deliver-by) disappear cleanly when a Shopify-only caller doesn't
// supply them, rather than rendering as "undefined" or empty labels.
//
// Run:
//   npx tsc api/tests/ct-order-routing.unit.test.ts api/lib/ct-order-routing.ts \
//     --outDir /tmp/test-routing --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   NODE_PATH="$PWD/node_modules" node /tmp/test-routing/tests/ct-order-routing.unit.test.js
//
// NODE_PATH is required (like ct-tracking-parser.unit.test.ts) because this
// file transitively imports sheets-client.ts, which imports 'googleapis' —
// outside the repo tree, /tmp/test-routing has no node_modules of its own.
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import {
  lineItemsSummary,
  buildUnknownItemsAlert,
  buildCtRoutingAlert,
  PO_DRAFTED_TAG,
  isCanaryMatch,
  type RouteOrderToCTInput,
} from '../lib/ct-order-routing.js';
import type { CTClassification } from '../lib/ct-client.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function baseInput(overrides: Partial<RouteOrderToCTInput> = {}): RouteOrderToCTInput {
  return {
    channel:           'shopify',
    sourceOrderId:     '12345',
    sourceOrderNumber: '#1042',
    lineItems:         [{ sku: '200E1059', quantity: 2 }],
    shipTo:            { city: 'Toronto', province: 'ON' },
    shipToInstaller:   false,
    ...overrides,
  };
}

function classificationWith(ctItems: CTClassification['ctItems']): CTClassification {
  return { ctItems, excluded: [], unknownItems: [] };
}

const product = { partNumber: '200E1059', name: 'Test Tire', cost: '97.50', msrp: '150.00', inventory: [] };

console.log('\nlineItemsSummary');

test('formats each SKU × quantity on its own line', () => {
  const out = lineItemsSummary([{ sku: '200E1059', quantity: 2 }, { sku: 'MW015247', quantity: 1 }]);
  assert.ok(out.includes('<code>200E1059</code> × 2'));
  assert.ok(out.includes('<code>MW015247</code> × 1'));
});

test('renders a placeholder for an empty list rather than an empty string', () => {
  assert.equal(lineItemsSummary([]), '  (none)');
});

console.log('\nbuildUnknownItemsAlert');

test('lists every unknown SKU with its reason and never silently drops one', () => {
  const classification = {
    ctItems: [], excluded: [],
    unknownItems: [
      { sku: 'TIRE-999999', partNumber: '999999', quantity: 1, reason: 'not found in CT catalog' },
      { sku: 'ABC123', partNumber: 'ABC123', quantity: 3, reason: 'not found in CT catalog' },
    ],
  };
  const text = buildUnknownItemsAlert(baseInput(), classification);
  assert.ok(text.includes('999999'));
  assert.ok(text.includes('ABC123'));
  assert.ok(text.includes('not found in CT catalog'));
  assert.ok(text.includes('#1042'));
});

console.log('\nbuildCtRoutingAlert');

test('a Shopify-only submission shows the Shopify order# and omits Walmart-only fields entirely', () => {
  const classification = classificationWith([{ sku: '200E1059', partNumber: '200E1059', quantity: 2, product }]);
  const text = buildCtRoutingAlert(baseInput(), classification, {
    poNumber: 'GCI-2026-447300', ctCost: 195, location: 'Toronto, ON', stockStatus: 'OK',
    outcomeLine: '✅ CT order SO123456 placed',
  });
  assert.ok(text.includes('Shopify order: <code>#1042</code>'));
  assert.ok(!text.includes('Walmart PO'));
  assert.ok(!text.includes('Ship by'));
  assert.ok(text.includes('GCI-2026-447300'));
  assert.ok(text.includes('Toronto, ON'));
  assert.ok(text.includes('$195.00 CAD'));
  assert.ok(text.includes('✅ CT order SO123456 placed'));
});

test('a channel-agnostic caller supplying Walmart meta gets the full field set', () => {
  const classification = classificationWith([{ sku: '200E1059', partNumber: '200E1059', quantity: 1, product }]);
  const input = baseInput({
    channel: 'walmart',
    meta: {
      walmartPoNumber: 'WM-PO-1',
      walmartOrderNumber: 'WM-ORD-1',
      shipByDate: '2026-08-01',
      deliverByDate: '2026-08-05',
      revenue: 250,
    },
  });
  const text = buildCtRoutingAlert(input, classification, {
    poNumber: 'GCI-2026-447301', ctCost: 97.5,
    outcomeLine: '⚠️ manual PO required — insufficient stock',
  });
  assert.ok(text.includes('WM-PO-1'));
  assert.ok(text.includes('WM-ORD-1'));
  assert.ok(text.includes('Ship by 2026-08-01'));
  assert.ok(text.includes('Deliver by 2026-08-05'));
  assert.ok(text.includes('Revenue: $250.00 CAD'));
  assert.ok(!text.includes('Shopify order:'));
});

test('an installer refusal (no classification yet) still renders a usable alert', () => {
  const text = buildCtRoutingAlert(baseInput({ shipToInstaller: true, installerName: 'Joe' }), null, {
    outcomeLine: '⚠️ manual PO required — ship-to-installer',
  });
  assert.ok(text.includes('⚠️ manual PO required — ship-to-installer'));
  // Falls back to the raw lineItems (no classification to draw from yet).
  assert.ok(text.includes('200E1059'));
});

console.log('\npo-drafted guard (§12 — see CT-INTEGRATION-CONTEXT.md)');

test('PO_DRAFTED_TAG matches the literal tag the Cowork tool applies', () => {
  // Guards against silent drift between this constant and the tag documented
  // in CT-INTEGRATION-CONTEXT.md §12 / observed on real orders (#1013, #1014).
  assert.equal(PO_DRAFTED_TAG, 'po-drafted');
});

test('a po-drafted-skip outcome renders a clear, non-alarming alert with no classification', () => {
  // Mirrors the installer-refusal test above: routeOrderToCT() calls
  // sendCtRoutingAlert() with classification=null for this outcome too,
  // since it returns before classifyLineItems() ever runs (see step 0's
  // module-header comment).
  const text = buildCtRoutingAlert(baseInput({ tags: [PO_DRAFTED_TAG] }), null, {
    outcomeLine: `⏭️ Skipped auto-PO — already manually drafted/sent (tag: ${PO_DRAFTED_TAG})`,
  });
  assert.ok(text.includes('Skipped auto-PO'));
  assert.ok(text.includes(PO_DRAFTED_TAG));
  // Falls back to the raw lineItems, same as the installer-refusal case.
  assert.ok(text.includes('200E1059'));
});

console.log('\ncanary override (§13 — see CT-INTEGRATION-CONTEXT.md)');

test('isCanaryMatch() is false by default — no env vars set means no order can match', () => {
  assert.equal(isCanaryMatch(''), false);
  assert.equal(isCanaryMatch('#1044'), false);
  assert.equal(isCanaryMatch('309117859146786'), false);
});

console.log(`\n✅ ${passed} assertions passed\n`);

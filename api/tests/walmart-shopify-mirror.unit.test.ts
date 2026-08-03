// api/tests/walmart-shopify-mirror.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for api/lib/walmart-shopify-mirror.ts's pure payload builder:
// buildMirrorOrderPayload(). Never touches Supabase or Shopify — the
// ledger claim/attempt orchestration (mirrorWalmartOrderToShopify) is all
// network calls end to end and is left to integration testing, same as
// ct-order-routing.unit.test.ts's approach to routeOrderToCT() itself.
//
// What's exercised here is the part most likely to silently violate a real
// constraint: the Walmart marketing-data compliance requirement (no
// Customer record — see CT-INTEGRATION-CONTEXT.md §7) and the
// paid-at-creation requirement (financial_status: 'paid', never a live
// checkout).
//
// Run:
//   npx tsc api/tests/walmart-shopify-mirror.unit.test.ts api/lib/walmart-shopify-mirror.ts \
//     --outDir /tmp/test-mirror --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   node /tmp/test-mirror/tests/walmart-shopify-mirror.unit.test.js
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { buildMirrorOrderPayload, MIRROR_GUARD_TAG } from '../lib/walmart-shopify-mirror.js';
import type { WalmartOrder } from '../walmart-order-sync.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function sampleOrder(overrides: Partial<WalmartOrder> = {}): WalmartOrder {
  return {
    purchaseOrderId: '309117859146786',
    customerOrderId: '600000102653105',
    orderDate: Date.parse('2026-07-26T12:00:00Z'),
    shippingInfo: {
      postalAddress: {
        name: 'Jane Doe',
        address1: '123 Main St',
        city: 'Toronto',
        state: 'ON',
        postalCode: 'M5V 2T6',
        country: 'CA',
      },
      estimatedShipDate: Date.parse('2026-07-27T00:00:00Z'),
      estimatedDeliveryDate: Date.parse('2026-07-30T00:00:00Z'),
    },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: '200E1059', productName: 'Test Tire 205/55R16' },
          charges: { charge: [{ chargeType: 'PRODUCT', chargeAmount: { currency: 'CAD', amount: 194.99 } }] },
          orderLineQuantity: { amount: '2' },
        },
      ],
    },
    ...overrides,
  };
}

console.log('\nbuildMirrorOrderPayload');

test('creates the order already paid — never a live checkout', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  assert.equal(payload.financial_status, 'paid');
});

test('never sends email or a customer object — no Shopify Customer record', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  assert.equal('email' in payload, false);
  assert.equal('customer' in payload, false);
});

test('suppresses both receipt emails', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  assert.equal(payload.send_receipt, false);
  assert.equal(payload.send_fulfillment_receipt, false);
});

test('tags the order with the guard tag, exactly', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  assert.equal(payload.tags, MIRROR_GUARD_TAG);
  assert.equal(MIRROR_GUARD_TAG, 'gci-walmart-mirror');
});

test('note carries the Walmart PO# and order# for cross-reference', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  assert.match(payload.note as string, /309117859146786/);
  assert.match(payload.note as string, /600000102653105/);
});

test('maps each order line to sku/price/quantity, verbatim SKU (no stripping)', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  const items = payload.line_items as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].sku, '200E1059');
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].price, '194.99');
  assert.equal(items[0].title, 'Test Tire 205/55R16');
});

test('splits the Walmart name into first/last for shipping_address', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  const addr = payload.shipping_address as any;
  assert.equal(addr.first_name, 'Jane');
  assert.equal(addr.last_name, 'Doe');
  assert.equal(addr.province, 'ON');
});

test('never fabricates a phone number — omitted, not guessed', () => {
  const payload = buildMirrorOrderPayload(sampleOrder());
  const addr = payload.shipping_address as any;
  assert.equal('phone' in addr, false);
});

test('a single-word name still produces a usable last_name (not blank)', () => {
  const order = sampleOrder();
  order.shippingInfo.postalAddress.name = 'Cher';
  const payload = buildMirrorOrderPayload(order);
  const addr = payload.shipping_address as any;
  assert.equal(addr.first_name, 'Cher');
  assert.equal(addr.last_name, '-');
});

console.log(`\n✅ ${passed} assertions passed\n`);

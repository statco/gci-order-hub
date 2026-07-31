// api/tests/walmart-order-sync.unit.test.ts
// ─────────────────────────────────────────────────────────────
// Unit tests for maybeRouteToCT() (api/walmart-order-sync.ts) — the
// CT_AUTO_PO_ENABLED-gated call to routeOrderToCT() that fires synchronously
// right after mirrorWalmartOrderToShopify() succeeds (see the handler's
// per-order loop, step "2.6").
//
// maybeRouteToCT() was extracted verbatim from that inline block specifically
// so it's callable in isolation here — no other file in this repo mocks the
// handler it lives in, and importing the real handler() would additionally
// require faking the Walmart API, Google Sheets (via the googleapis SDK),
// Supabase REST, and Telegram just to reach this one gate. This test stubs
// only routeOrderToCT() (via maybeRouteToCT()'s `routeFn` injection point)
// and drives `ctAutoPoEnabled` explicitly — it never touches the network,
// same boundary ct-order-routing.unit.test.ts and
// walmart-shopify-mirror.unit.test.ts already draw for their own modules.
//
// What this does NOT test: routeOrderToCT()'s own internals (classify →
// claim → submit) — that's ct-order-routing.unit.test.ts's job — or
// mirrorWalmartOrderToShopify()'s own claim/attempt orchestration, which
// remains integration-only (see walmart-shopify-mirror.ts's module header).
//
// Run:
//   npx tsc api/tests/walmart-order-sync.unit.test.ts api/walmart-order-sync.ts \
//     --outDir /tmp/test-order-sync --module nodenext --target es2022 \
//     --moduleResolution nodenext --strict && \
//   NODE_PATH="$PWD/node_modules" node /tmp/test-order-sync/tests/walmart-order-sync.unit.test.js
//
// NODE_PATH is required (like ct-tracking-parser.unit.test.ts and
// ct-order-routing.unit.test.ts) because walmart-order-sync.ts transitively
// imports sheets-client.ts, which imports 'googleapis' — outside the repo
// tree, /tmp/test-order-sync has no node_modules of its own.
// ─────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { maybeRouteToCT, type WalmartOrder } from '../walmart-order-sync.js';
import type { RouteOrderToCTInput, RouteOrderOutcome } from '../lib/ct-order-routing.js';

let passed = 0;
function test(name: string, fn: () => Promise<void> | void): Promise<void> | void {
  const result = fn();
  if (result instanceof Promise) {
    return result.then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    });
  }
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
          item: { sku: 'TIRE-200E1059', productName: 'Test Tire 205/55R16' },
          charges: { charge: [{ chargeType: 'PRODUCT', chargeAmount: { currency: 'CAD', amount: 194.99 } }] },
          orderLineQuantity: { amount: '2' },
        },
      ],
    },
    ...overrides,
  };
}

function fakeRouteFn(calls: RouteOrderToCTInput[]): (input: RouteOrderToCTInput) => Promise<RouteOrderOutcome> {
  return async (input: RouteOrderToCTInput) => {
    calls.push(input);
    return {
      kind: 'submitted',
      poNumber: 'GCI-2026-000001',
      ctOrderNumber: 'SO123456',
      ctInternalId: 'internal-1',
      location: 'Toronto, ON',
      dryRun: true,
    };
  };
}

// Wrapped in an async IIFE rather than top-level await — this file compiles
// as CommonJS (no "type": "module" in package.json, same as every other test
// in this suite), which disallows top-level await.
async function main(): Promise<void> {
  console.log('\nmaybeRouteToCT');

  await test('CT_AUTO_PO_ENABLED=true, mirror succeeded → calls routeOrderToCT() exactly once, keyed on the Shopify order id', async () => {
    const calls: RouteOrderToCTInput[] = [];
    await maybeRouteToCT(sampleOrder(), 'gid://shopify/Order/999888777', '#1043', {
      ctAutoPoEnabled: true,
      routeFn: fakeRouteFn(calls),
    });

    assert.equal(calls.length, 1, `expected exactly 1 call, got ${calls.length}`);
    assert.equal(calls[0].sourceOrderId, 'gid://shopify/Order/999888777');
    assert.equal(calls[0].sourceOrderNumber, '#1043');
    assert.equal(calls[0].channel, 'walmart');
    // Walmart PO# rides along as meta, not as the ledger key — see
    // CT-INTEGRATION-CONTEXT.md §7 ("Ledger keys on the Shopify order id").
    assert.equal(calls[0].meta?.walmartPoNumber, '309117859146786');
  });

  await test('CT_AUTO_PO_ENABLED=false, mirror succeeded → does NOT call routeOrderToCT()', async () => {
    const calls: RouteOrderToCTInput[] = [];
    await maybeRouteToCT(sampleOrder(), 'gid://shopify/Order/999888777', '#1043', {
      ctAutoPoEnabled: false,
      routeFn: fakeRouteFn(calls),
    });

    assert.equal(calls.length, 0, `expected 0 calls, got ${calls.length}`);
  });

  console.log(`\n✅ ${passed} assertions passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

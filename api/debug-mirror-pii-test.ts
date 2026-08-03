// api/debug-mirror-pii-test.ts
// ─────────────────────────────────────────────────────────────
// TEMPORARY. Not part of the application. Exists solely to answer one
// question empirically, from inside a real Vercel deployment where real
// (unmasked) secrets are natively available: does the live
// mirrorWalmartOrderToShopify() order-creation path retain customer PII, or
// is it subject to the same silent PII-stripping observed tonight on four
// hand-crafted `POST /orders.json` test orders (first_name/last_name/
// address1/city/zip/phone all dropped on create + an independent GET
// re-fetch, while a genuine checkout-created order, #1003, retained
// everything)?
//
// A local-script attempt at this same test failed for an unrelated reason:
// `vercel env pull` masks any Vercel-flagged "Sensitive" variable as the
// literal string "[SENSITIVE]" when exported to a file, which is exactly
// how SUPABASE_URL / SHOPIFY_ADMIN_API_TOKEN / CT_AUTO_PO_ENABLED (at least)
// are flagged in this project. This endpoint sidesteps that by running
// inside Vercel's own runtime instead of a local process.
//
// DELETE THIS FILE, on its own commit, the moment one result has been
// captured. It must never be reachable longer than that.
//
// Calls the REAL, unmodified exported functions this repo already ships —
// mirrorWalmartOrderToShopify() (api/lib/walmart-shopify-mirror.ts) and
// maybeRouteToCT() (api/walmart-order-sync.ts) — against a synthetic,
// obviously-fake Walmart order (TEST-PII-<timestamp> PO#). Nothing here is
// a reimplementation or approximation of those functions.
//
// Auth: bearer-token gated. Deliberately NOT CRON_SECRET (that secret is
// separately flagged for rotation after a prior leak this session --
// reusing an already-compromised secret for a new endpoint is bad hygiene).
// A fresh secret is hardcoded below and reported out-of-band; it dies with
// this file.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { mirrorWalmartOrderToShopify } from './lib/walmart-shopify-mirror.js';
import { maybeRouteToCT, type WalmartOrder } from './walmart-order-sync.js';
import { getBySourceOrder } from './lib/ct-order-ledger.js';

export const config = { maxDuration: 60 };

// Freshly generated for this file only (crypto.randomBytes(24).toString('hex')).
// Not CRON_SECRET. Not stored as a real env var. Dies with this file.
const DEBUG_BEARER_SECRET = '5e70e31beabaacf6e722ccaa7cc85318ca8e09d1c0a8e6eb';

// Same env vars walmart-shopify-mirror.ts reads at module load -- reading
// them again here (rather than importing a constant) is deliberate: this
// file's whole purpose is to observe THIS runtime's actual environment.
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN   ?? '';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
// Matches api/lib/walmart-shopify-mirror.ts's API_VERSION -- the read-back
// must hit the same API surface the write went through, not a different one.
const API_VERSION = '2024-01';

function isAuthorized(req: VercelRequest): boolean {
  const header = req.headers['authorization'];
  const auth = Array.isArray(header) ? header[0] : header;
  return auth === `Bearer ${DEBUG_BEARER_SECRET}`;
}

interface EnvDiagnostic {
  SUPABASE_URL:              boolean;
  SUPABASE_SERVICE_ROLE_KEY: boolean;
  SHOPIFY_STORE_DOMAIN:      boolean;
  SHOPIFY_ADMIN_API_TOKEN:   boolean;
  CT_AUTO_PO_ENABLED:        boolean;
  CT_DRY_RUN:                boolean;
}

function diagnoseEnv(): EnvDiagnostic {
  // Presence only -- never the values themselves, per this endpoint's own
  // reason for existing (it must not become a second way to leak secrets).
  return {
    SUPABASE_URL:              !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SHOPIFY_STORE_DOMAIN:      !!process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_API_TOKEN:   !!process.env.SHOPIFY_ADMIN_API_TOKEN,
    CT_AUTO_PO_ENABLED:        !!process.env.CT_AUTO_PO_ENABLED,
    CT_DRY_RUN:                !!process.env.CT_DRY_RUN,
  };
}

function buildSyntheticOrder(): WalmartOrder {
  const testPo = `TEST-PII-${Date.now()}`;
  return {
    purchaseOrderId: testPo,
    customerOrderId: `TEST-ORDER-${Date.now()}`,
    orderDate: Date.now(),
    shippingInfo: {
      postalAddress: {
        name:       'PII Test Customer',
        address1:   '456 Verification Ave',
        city:       'Toronto',
        state:      'ON',
        postalCode: 'M5V 2T6',
        country:    'CA',
      },
      estimatedShipDate:     Date.now() + 86_400_000,
      estimatedDeliveryDate: Date.now() + 3 * 86_400_000,
    },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'TIRE-200E1059', productName: 'PII Test Tire' },
          charges: { charge: [{ chargeType: 'PRODUCT', chargeAmount: { currency: 'CAD', amount: 97.50 } }] },
          orderLineQuantity: { amount: '1' },
        },
      ],
    },
  };
}

/**
 * Independent read-back via Shopify Admin GraphQL -- deliberately not
 * trusting createMirrorShopifyOrder()'s own response body as the answer,
 * same discipline as tonight's manual #1003 vs hand-crafted-order checks
 * (an independent GET/query, not the create response).
 */
async function readBackShippingAddress(numericOrderId: string): Promise<unknown> {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    return { skipped: true, reason: 'SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN not present in this runtime' };
  }
  const gid = `gid://shopify/Order/${numericOrderId}`;
  const query = `
    query DebugPiiReadback($id: ID!) {
      order(id: $id) {
        id
        name
        tags
        shippingAddress {
          firstName
          lastName
          address1
          city
          province
          zip
          phone
        }
      }
    }
  `;
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });
  const body: unknown = await res.json();
  return { httpStatus: res.status, body };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const diagnostic = diagnoseEnv();
  console.log('[debug-mirror-pii-test] env diagnostic:', JSON.stringify(diagnostic));

  // Safety check -- same boundary as every other CT-adjacent script in this
  // repo. Only the literal string 'false' means real transmission is live.
  if (process.env.CT_DRY_RUN === 'false') {
    console.error('[debug-mirror-pii-test] ABORT: CT_DRY_RUN is the literal string \'false\'. Refusing to proceed.');
    return res.status(412).json({
      diagnostic,
      aborted: true,
      reason: "CT_DRY_RUN is the literal string 'false' — safety check failed, refusing to call mirrorWalmartOrderToShopify().",
    });
  }

  const syntheticOrder = buildSyntheticOrder();
  console.log('[debug-mirror-pii-test] synthetic Walmart PO:', syntheticOrder.purchaseOrderId);

  let mirrorOutcome: Awaited<ReturnType<typeof mirrorWalmartOrderToShopify>>;
  try {
    mirrorOutcome = await mirrorWalmartOrderToShopify(syntheticOrder);
  } catch (err: any) {
    console.error('[debug-mirror-pii-test] mirrorWalmartOrderToShopify threw:', err);
    return res.status(500).json({
      diagnostic,
      aborted: false,
      testPo: syntheticOrder.purchaseOrderId,
      mirrorThrew: err?.message ?? String(err),
    });
  }
  console.log('[debug-mirror-pii-test] mirrorOutcome:', JSON.stringify(mirrorOutcome));

  let ctOutcome: unknown = null;
  let shippingAddressReadback: unknown = null;

  if (mirrorOutcome.kind === 'mirrored') {
    try {
      await maybeRouteToCT(syntheticOrder, mirrorOutcome.shopifyOrderId, mirrorOutcome.shopifyOrderNumber);
    } catch (err: any) {
      console.error('[debug-mirror-pii-test] maybeRouteToCT threw:', err);
    }

    try {
      ctOutcome = await getBySourceOrder('walmart', mirrorOutcome.shopifyOrderId);
    } catch (err: any) {
      ctOutcome = { lookupError: err?.message ?? String(err) };
    }

    try {
      shippingAddressReadback = await readBackShippingAddress(mirrorOutcome.shopifyOrderId);
    } catch (err: any) {
      shippingAddressReadback = { readbackError: err?.message ?? String(err) };
    }
  }

  return res.status(200).json({
    diagnostic,
    aborted: false,
    testPo: syntheticOrder.purchaseOrderId,
    mirrorOutcome,
    ctOutcome,
    shippingAddressReadback,
  });
}

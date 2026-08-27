// api/admin-canary-ct-order.ts
// ─────────────────────────────────────────────────────────────
// POST /api/admin-canary-ct-order?order=<Shopify order name, e.g. %231044>
// Authorization: Bearer <CRON_SECRET>
//
// WHY THIS EXISTS: there is no CT sandbox (see CT-INTEGRATION-CONTEXT.md
// §13). The canary override in ct-order-routing.ts (CT_CANARY_*) lets ONE
// specific order bypass the global CT_DRY_RUN=true default — but Shopify
// webhooks only fire once, at order creation. By the time you've decided
// which real order to canary-test and set the env vars, that order's
// webhook already fired (and, given CT wasn't configured yet, almost
// certainly returned 'not_configured'). This endpoint re-fetches that
// order's CURRENT state fresh from Shopify and re-runs it through the exact
// same routeOrderToCT() every other order goes through.
//
// 🔴 Deliberately does NOT filter line items by a 'TIRE-' SKU prefix the
// way order-router.ts does. Live catalog data (checked 2026-08-27 against
// real orders #1011, #1010, #1003, #1001) shows real tire SKUs are bare —
// no prefix at all. order-router.ts's TIRE_PREFIX filter is stale against
// the current catalog and would silently misclassify every real item as
// 'unknownItems' with zero notification (see CT-INTEGRATION-CONTEXT.md
// §14 — that's a separate, real bug in order-router.ts, not yet fixed).
// This endpoint does NOT repeat that mistake: it hands every line item
// through to routeOrderToCT() → classifyLineItems(), which asks CT's real
// product-search RESTlet whether each SKU is CT-eligible — the same
// pattern maybeRouteToCT() (walmart-order-sync.ts) already uses
// successfully. No local prefix heuristic, nothing to drift out of sync
// with the live catalog.
//
// SAFETY:
//   • CRON_SECRET-protected, POST only — same pattern as
//     admin-alert-order.ts.
//   • Refuses (400, does not call routeOrderToCT) if the order has zero
//     line items, or if it looks like a ship-to-installer order
//     (gci_fulfillment_type=ship_to_installer in customAttributes).
//     Installer orders are refused by routeOrderToCT() anyway, but this
//     endpoint is meant for a plain direct-to-customer canary — pick a
//     simple order for the first live test, not a complicated one.
//   • Does NOT itself decide whether the submission is live or dry-run —
//     that's entirely CT_CANARY_SOURCE_ORDER_NUMBER / CT_CANARY_CONFIRM
//     (ct-order-routing.ts), which must already be armed and matching this
//     order's name before this endpoint is called, or routeOrderToCT()
//     will just log the payload same as any other dry-run order. This
//     endpoint is the "re-deliver the webhook" mechanism, not the "make it
//     live" mechanism — those are deliberately two separate switches.
//   • claimOrder()'s ledger idempotency still applies: if this order was
//     somehow already claimed (ct_orders row exists), routeOrderToCT()
//     returns 'already_claimed' and this endpoint will NOT resubmit —
//     same protection as every other caller gets.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchOrderByName, type ShopifyOrderLookup } from './lib/shopify.js';
import { routeOrderToCT } from './lib/ct-order-routing.js';
import { MIRROR_GUARD_TAG } from './lib/walmart-shopify-mirror.js';

export const config = { maxDuration: 30 };

// Same defensive normalization as fetchActiveCtSyncVariants() in
// lib/shopify.ts: strip an accidental 'TIRE-' prefix if present, but don't
// require one — real catalog SKUs are bare. Kept here as a named constant
// rather than a magic string, in case this DOES change later.
const STALE_TIRE_PREFIX = 'TIRE-';

function normalizedLineItems(order: ShopifyOrderLookup) {
  return order.lineItems
    .filter((i) => i.sku)
    .map((i) => ({
      sku: i.sku.startsWith(STALE_TIRE_PREFIX) ? i.sku.slice(STALE_TIRE_PREFIX.length) : i.sku,
      quantity: i.quantity,
    }));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed — POST only' });

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });

  const orderName = (req.query.order as string || '').trim();
  if (!orderName) return res.status(400).json({ error: 'order query param required (Shopify order name, e.g. #1044)' });

  let order: ShopifyOrderLookup | null;
  try {
    order = await fetchOrderByName(orderName);
  } catch (err: any) {
    return res.status(502).json({ error: `Shopify lookup failed: ${err.message}` });
  }

  if (!order) return res.status(404).json({ error: `No order found matching '${orderName}'` });

  if (order.tags.includes(MIRROR_GUARD_TAG)) {
    // Not a hard refusal — routeOrderToCT() has no problem with Walmart-
    // channel orders — but this endpoint currently only builds a
    // Shopify-channel input below. Refuse rather than silently mislabel
    // the channel.
    return res.status(400).json({
      error: `Order '${order.name}' carries '${MIRROR_GUARD_TAG}' — it's a Walmart-mirrored order. ` +
             `This endpoint only supports direct Shopify-channel orders today.`,
    });
  }

  const fulfillmentType = order.customAttributes.find((a) => a.key === 'gci_fulfillment_type')?.value
    ?? 'direct_to_customer';
  if (fulfillmentType === 'ship_to_installer') {
    return res.status(400).json({
      error: `Order '${order.name}' is ship_to_installer. Pick a plain direct-to-customer order for the ` +
             `first canary test — routeOrderToCT() would refuse this one anyway (installer shipping isn't ` +
             `modeled), but that refusal happens AFTER a ledger claim, and this endpoint would rather you ` +
             `pick a cleaner order than burn a PO number finding that out.`,
    });
  }

  const lineItems = normalizedLineItems(order);
  if (lineItems.length === 0) {
    return res.status(400).json({
      error: `Order '${order.name}' has no line items with a SKU — nothing for CT routing to do.`,
    });
  }

  const addr = order.shippingAddress;
  const outcome = await routeOrderToCT({
    channel:           'shopify',
    sourceOrderId:      order.id,
    sourceOrderNumber:  order.name,
    lineItems,
    shipTo: {
      name:       addr?.name,
      address1:   addr?.address1,
      address2:   addr?.address2,
      city:       addr?.city,
      province:   addr?.province,
      postalCode: addr?.postalCode,
      country:    addr?.country,
      phone:      addr?.phone,
    },
    shipToInstaller: false, // already refused above if true
    email: order.email || undefined,
    phone: order.phone || addr?.phone || undefined,
    meta:  { resultingShopifyOrderNumber: order.name },
    tags:  order.tags,
  });

  console.log(`[admin-canary-ct-order] ${order.name} → ${outcome.kind}`, outcome);
  return res.status(200).json({ order: order.name, outcome });
}

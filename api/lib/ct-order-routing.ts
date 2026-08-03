// api/lib/ct-order-routing.ts
// ─────────────────────────────────────────────────────────────
// Shared CT (Canada Tire) order-routing function — the single place that
// turns "an order that includes CT-eligible tires" into either a real CT
// sales order or a routed-to-a-human outcome, with the ct_orders ledger
// (ct-order-ledger.ts) as the idempotency guard in between.
//
// Callers today: only order-router.ts's Shopify `orders/paid` webhook (its
// previously-dormant CT_AUTO_PO_ENABLED branch). Kept channel-agnostic
// (CTSourceChannel is 'shopify' | 'walmart' | 'manual') and importable so a
// future Walmart-order caller can reuse it once a Walmart→Shopify mirror (or
// a direct Walmart→CT trigger) exists — see CT-INTEGRATION-CONTEXT.md for
// that gap. No such caller is wired up in this change; walmart-order-sync.ts
// is untouched.
//
// ─── FLOW, IN ORDER ───────────────────────────────────────────────────────
//   1. ship_to_installer refusal — BEFORE any ledger claim. Installer
//      shipping data isn't modeled yet; order-router.ts used to send empty
//      address fields straight into submitOrder(), which threw a raw
//      CTValidationError deep inside AFTER a ledger row had already been
//      claimed for it. Refusing up front means an order CT can never fulfill
//      never occupies a claim slot at all.
//   2. classifyLineItems() — CT-eligible vs excluded vs unknown.
//      unknownItems ALWAYS alert (Telegram), independent of whether any
//      CT-eligible items remain — never silently dropped, per ct-client.ts's
//      classification contract. This call requires CT to be configured
//      (it calls the product-search RESTlet), so CTNotConfiguredError
//      naturally surfaces here, before any claim exists.
//   3. If nothing CT-eligible remains (ctItems.length === 0), stop — no
//      claim, no CT call, nothing to submit.
//   4. claimOrder() — bare-INSERT idempotency guard. claimed:false means
//      someone already owns this order; return without calling CT.
//   5. submitOrder() — map every outcome to a ledger status write, per
//      ct-order-ledger.ts's STATUS SEMANTICS:
//        success                  → markSubmitted
//        CTInsufficientStockError → markManualRequired (ROUTINE — expect this
//                                    often; live stock is thin)
//        CTValidationError        → markFailed (safe to fix + resubmit)
//        CTAuthError              → markFailed
//        anything else (CTServerError, timeout, unexpected) → markIndeterminate,
//          LOUD alert, NEVER auto-retried — see ct-order-ledger.ts's
//          isAutoRetryable().
//
// Every outcome past the classification step is reported via one enriched
// Telegram alert (sendCtRoutingAlert) carrying whatever of {Walmart PO#,
// Walmart order#, resulting Shopify order#, SKU+qty, ship-to city/province,
// ship-by/deliver-by, revenue, CT cost, chosen warehouse, stock status} the
// caller actually supplied — Walmart-only fields are simply absent for the
// Shopify caller wired up today.
//
// The three real-order safety gates (CT_AUTO_PO_ENABLED / CT_DRY_RUN /
// CT_ENVIRONMENT) are untouched by this file — they live in, and are
// enforced by, ct-client.ts (CT_AUTO_PO_ENABLED gates whether callers even
// reach this function; CT_DRY_RUN and CT_ENVIRONMENT are read and enforced
// inside submitOrder()). Making this function reachable does not change any
// of their defaults.
// ─────────────────────────────────────────────────────────────

import {
  classifyLineItems,
  submitOrder,
  CT_DRY_RUN,
  CTNotConfiguredError,
  CTInsufficientStockError,
  CTValidationError,
  CTAuthError,
  type CTClassification,
  type CTOrderShipping,
} from './ct-client.js';
import {
  claimOrder,
  markSubmitted,
  markManualRequired,
  markFailed,
  markIndeterminate,
  type CTSourceChannel,
} from './ct-order-ledger.js';
import { writePoNumberByOrderId } from './sheets-client.js';
import { sendTelegramMessage } from './telegram.js';

const WALMART_ORDER_LOG_SHEET_ID = process.env.WALMART_ORDER_LOG_SHEET_ID ?? '';

// ─── Public types ────────────────────────────────────────────────────────

export interface RouteOrderShipTo {
  name?:       string;
  address1?:   string;
  address2?:   string;
  city?:       string;
  province?:   string;
  postalCode?: string;
  country?:    string;
  phone?:      string;
}

/**
 * Optional, channel-specific enrichment for the Telegram alert only —
 * nothing here drives routing logic. Fields only Walmart orders have
 * (PO#, order#, ship-by/deliver-by) are simply omitted by the one caller
 * wired up today (Shopify, via order-router.ts).
 */
export interface RouteOrderMeta {
  walmartPoNumber?:             string;
  walmartOrderNumber?:          string;
  resultingShopifyOrderNumber?: string;
  /** Matches column A in WALMART_ORDER_LOG_SHEET_ID — drives the column-N PO write on success. */
  walmartSheetOrderId?: string;
  shipByDate?:          string;
  deliverByDate?:       string;
  revenue?:              number;
}

export interface RouteOrderToCTInput {
  channel:           CTSourceChannel;
  sourceOrderId:     string;
  sourceOrderNumber: string;
  lineItems:         { sku: string; quantity: number }[];
  shipTo:            RouteOrderShipTo;
  /** True routes to an explicit refusal BEFORE any ledger claim — see module header. */
  shipToInstaller:   boolean;
  installerName?:    string;
  installerId?:      string;
  email?: string;
  phone?: string;
  meta?:  RouteOrderMeta;
}

export type RouteOrderOutcome =
  | { kind: 'installer_refused';  reason: string }
  | { kind: 'not_configured';     reason: string }
  | { kind: 'no_ct_items';        reason: string }
  | { kind: 'already_claimed';    poNumber: string; existingStatus: string }
  | { kind: 'submitted';          poNumber: string; ctOrderNumber: string; ctInternalId: string; location: string; dryRun: boolean }
  | { kind: 'manual_required';    poNumber: string; reason: string }
  | { kind: 'failed';             poNumber: string; reason: string }
  | { kind: 'indeterminate';      poNumber: string; reason: string };

// ─── Main entry point ──────────────────────────────────────────────────────

export async function routeOrderToCT(input: RouteOrderToCTInput): Promise<RouteOrderOutcome> {
  const meta = input.meta ?? {};

  // ── 1. Installer refusal — BEFORE any ledger claim ──────────────────────
  if (input.shipToInstaller) {
    const reason =
      `Ship-to-installer order — installer shipping address is not modeled yet ` +
      `(installer: ${input.installerName || input.installerId || 'unknown'}). ` +
      `Not auto-submitted to CT; route manually.`;
    console.warn(`[ct-order-routing] ${input.channel} ${input.sourceOrderNumber}: ${reason}`);
    await sendCtRoutingAlert(input, null, { outcomeLine: `⚠️ manual PO required — ${reason}` });
    return { kind: 'installer_refused', reason };
  }

  // ── 2. Classify. Requires CT to be configured (calls product search), so
  // CTNotConfiguredError naturally surfaces here — before any ledger claim
  // exists, so a config problem never burns a PO number or gets misreported
  // as 'indeterminate' (which implies CT was actually contacted for THIS order).
  let classification: CTClassification;
  try {
    classification = await classifyLineItems(input.lineItems);
  } catch (err: any) {
    if (err instanceof CTNotConfiguredError) {
      console.log(`[ct-order-routing] ${input.channel} ${input.sourceOrderNumber}: CT not configured — ${err.message}`);
      return { kind: 'not_configured', reason: err.message };
    }
    throw err;
  }

  if (classification.unknownItems.length > 0) {
    await sendTelegramMessage(buildUnknownItemsAlert(input, classification), 'actionable');
  }

  if (classification.ctItems.length === 0) {
    const reason = classification.unknownItems.length > 0
      ? `No CT-eligible line items — ${classification.unknownItems.length} unknown SKU(s) (alerted separately), ${classification.excluded.length} excluded.`
      : `No CT-eligible line items (${classification.excluded.length} excluded — e.g. install fees only).`;
    console.log(`[ct-order-routing] ${input.channel} ${input.sourceOrderNumber}: ${reason}`);
    return { kind: 'no_ct_items', reason };
  }

  // ── 3. Claim ─────────────────────────────────────────────────────────────
  const claim = await claimOrder({
    channel:            input.channel,
    sourceOrderId:      input.sourceOrderId,
    sourceOrderNumber:  input.sourceOrderNumber,
    dryRun:             CT_DRY_RUN,
    requestPayload:     { lineItems: input.lineItems, shipTo: input.shipTo },
  });

  if (!claim.claimed) {
    console.warn(
      `[ct-order-routing] ${input.channel} ${input.sourceOrderNumber}: already claimed as ` +
      `${claim.row.po_number} (status=${claim.row.status}) — not resubmitting.`
    );
    return { kind: 'already_claimed', poNumber: claim.row.po_number, existingStatus: claim.row.status };
  }

  const poNumber = claim.row.po_number;
  const ctCost = classification.ctItems.reduce(
    (sum, i) => sum + (parseFloat(i.product.cost) || 0) * i.quantity, 0,
  );

  const shipping: CTOrderShipping = {
    addr1:      input.shipTo.address1,
    addr2:      input.shipTo.address2,
    addressee:  input.shipTo.name,
    city:       input.shipTo.city,
    province:   input.shipTo.province,
    postalCode: input.shipTo.postalCode,
    country:    input.shipTo.country,
  };

  // ── 4. Submit ────────────────────────────────────────────────────────────
  try {
    const result = await submitOrder({
      poNumber,
      items:    classification.ctItems.map(i => ({ partNumber: i.partNumber, quantity: i.quantity })),
      shipping,
      email:    input.email,
      phone:    input.phone || input.shipTo.phone,
    });

    await markSubmitted(poNumber, {
      ctInternalId:     result.id,
      ctOrderNumber:    result.orderNumber,
      ctLocation:       result.locationUsed,
      dryRun:           result.dryRun,
      orderTotal:       result.orderTotal,
      salesTax:         result.salesTax,
      tireTax:          result.tireTax,
      shippingCost:     result.shippingCost,
      responsePayload:  result,
    });

    // Column N is written ONLY on this confirmed success path — every other
    // outcome below leaves it blank, exactly as today. Never write speculatively.
    if (meta.walmartSheetOrderId) {
      await writePoNumberByOrderId(WALMART_ORDER_LOG_SHEET_ID, meta.walmartSheetOrderId, poNumber).catch(err => {
        console.error(`[ct-order-routing] Sheet column-N write failed for order ${meta.walmartSheetOrderId}:`, err);
      });
    }

    await sendCtRoutingAlert(input, classification, {
      poNumber, ctCost, location: result.locationUsed, stockStatus: 'OK',
      outcomeLine: `✅ CT order ${result.orderNumber} placed${result.dryRun ? ' (DRY RUN)' : ''}`,
    });

    return {
      kind: 'submitted', poNumber, ctOrderNumber: result.orderNumber,
      ctInternalId: result.id, location: result.locationUsed, dryRun: result.dryRun,
    };
  } catch (err: any) {
    if (err instanceof CTInsufficientStockError) {
      await markManualRequired(poNumber, { name: err.name, message: err.message, detail: err.detail });
      await sendCtRoutingAlert(input, classification, {
        poNumber, ctCost, stockStatus: err.detail || err.message,
        outcomeLine: `⚠️ manual PO required — insufficient stock`,
      });
      return { kind: 'manual_required', poNumber, reason: err.detail || err.message };
    }

    if (err instanceof CTValidationError || err instanceof CTAuthError) {
      await markFailed(poNumber, err);
      await sendCtRoutingAlert(input, classification, {
        poNumber, ctCost,
        outcomeLine: `⚠️ manual PO required — CT rejected the order (${err.name}): ${err.message}`,
      });
      return { kind: 'failed', poNumber, reason: err.message };
    }

    // CTServerError, timeout, or anything unrecognized: CT may already hold
    // the order. NEVER auto-retry — see ct-order-ledger.ts's isAutoRetryable().
    await markIndeterminate(poNumber, err);
    console.error(
      `🚨 [ct-order-routing] INDETERMINATE — CT may have already committed PO ${poNumber}. ` +
      `Human reconciliation required, no auto-retry.`, err,
    );
    await sendCtRoutingAlert(input, classification, {
      poNumber, ctCost,
      outcomeLine:
        `🚨 INDETERMINATE — CT may have already placed this order (PO ${poNumber}). ` +
        `DO NOT resubmit. Human must check CT before touching this order again.`,
    });
    return { kind: 'indeterminate', poNumber, reason: err.message };
  }
}

// ─── Telegram alert building (pure — no network calls of their own) ────────

export function lineItemsSummary(items: { sku: string; quantity: number }[]): string {
  return items.map(i => `  • <code>${i.sku}</code> × ${i.quantity}`).join('\n') || '  (none)';
}

export function buildUnknownItemsAlert(input: RouteOrderToCTInput, classification: CTClassification): string {
  const lines = classification.unknownItems
    .map(i => `  • <code>${i.sku}</code> (part ${i.partNumber}) × ${i.quantity} — ${i.reason}`)
    .join('\n');
  return (
    `⚠️ <b>CT routing: unrecognized SKU(s)</b>\n` +
    `Channel: ${input.channel} · Order: <code>${input.sourceOrderNumber}</code>\n` +
    `${lines}\n` +
    `Not sent to CT — needs a human to check the SKU or CT's catalog.`
  );
}

interface AlertExtra {
  poNumber?:    string;
  ctCost?:      number;
  location?:    string;
  stockStatus?: string;
  outcomeLine:  string;
}

export function buildCtRoutingAlert(
  input: RouteOrderToCTInput,
  classification: CTClassification | null,
  extra: AlertExtra,
): string {
  const meta = input.meta ?? {};
  const items = classification?.ctItems.map(i => ({ sku: i.sku, quantity: i.quantity })) ?? input.lineItems;

  const walmartLine = (meta.walmartPoNumber || meta.walmartOrderNumber)
    ? `🛒 Walmart PO: <code>${meta.walmartPoNumber ?? 'N/A'}</code> · Order#: <code>${meta.walmartOrderNumber ?? 'N/A'}</code>\n`
    : '';
  const shopifyOrderNumber = input.channel === 'shopify' ? input.sourceOrderNumber : meta.resultingShopifyOrderNumber;
  const shopifyLine = shopifyOrderNumber
    ? `🛍️ Shopify order: <code>${shopifyOrderNumber}</code>\n`
    : '';
  const cityProvince = [input.shipTo.city, input.shipTo.province].filter(Boolean).join(', ') || 'Unknown';
  const dateLine = (meta.shipByDate || meta.deliverByDate)
    ? `📅 Ship by ${meta.shipByDate ?? 'N/A'} · Deliver by ${meta.deliverByDate ?? 'N/A'}\n`
    : '';
  const revenueLine = meta.revenue != null ? `💰 Revenue: $${meta.revenue.toFixed(2)} CAD\n` : '';
  const ctCostLine = extra.ctCost != null ? `🏭 CT cost: $${extra.ctCost.toFixed(2)} CAD\n` : '';
  const poLine = extra.poNumber ? `📋 PO: <code>${extra.poNumber}</code>\n` : '';
  const locationLine = extra.location ? `📦 Warehouse: ${extra.location}\n` : '';
  const stockLine = extra.stockStatus ? `📊 Stock: ${extra.stockStatus}\n` : '';

  return (
    `🚗 <b>CT Order Routing — ${input.channel}</b>\n` +
    `Order: <code>${input.sourceOrderNumber}</code>\n` +
    walmartLine + shopifyLine +
    poLine +
    `📦 Items:\n${lineItemsSummary(items)}\n` +
    `📍 ${cityProvince}\n` +
    dateLine + revenueLine + ctCostLine + locationLine + stockLine +
    `\n${extra.outcomeLine}`
  );
}

async function sendCtRoutingAlert(
  input: RouteOrderToCTInput,
  classification: CTClassification | null,
  extra: AlertExtra,
): Promise<void> {
  await sendTelegramMessage(buildCtRoutingAlert(input, classification, extra), 'actionable');
}

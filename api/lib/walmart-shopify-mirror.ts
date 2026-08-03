// api/lib/walmart-shopify-mirror.ts
// ─────────────────────────────────────────────────────────────
// Mirrors a Walmart CA marketplace order into a real Shopify order.
//
// A Walmart order is already sold and paid for via the marketplace -- this
// creates the Shopify order already marked financial_status: 'paid'. It is
// NOT a checkout, and no live Shopify checkout/payment flow is involved.
//
// Independent of, and separate from, gci-walmart-sync (a different repo --
// a standalone commercial Shopify App Store app that has its own,
// unrelated order-mirroring logic for its own multi-tenant merchants). This
// module does not import, call, or depend on anything in that repo. It is
// informed by the same general shape (Walmart order -> Shopify order,
// paid-at-creation) because that shape is dictated by how Walmart
// marketplace orders actually work, not by that repo's implementation.
//
// ─── IDEMPOTENCY: walmart_shopify_mirror (own table, own guarantee) ────────
// walmart-order-sync.ts has a 48h rolling lookback (PR #52) -- the same
// Walmart PO can reach this code path across multiple cron runs. The
// walmart_shopify_mirror table (see the migration file for the full status
// contract) is what guarantees at most one Shopify order per Walmart PO.
// This is DELIBERATELY separate from, and in addition to, ct_orders' own
// idempotency further downstream in routeOrderToCT() -- that ledger answers
// "was this Shopify order already submitted to Canada Tire," a different
// question with a different key.
//
// Like ct-order-ledger.ts's claimOrder(), the guard is the INSERT, not a
// SELECT-then-INSERT: two overlapping cron runs both attempting to claim the
// same walmart_po race on the database's primary-key constraint, not on
// application logic. See claimMirror() below.
//
// ─── NEVER BLIND-RETRY A TIMEOUT/5xx ────────────────────────────────────────
// A POST to Shopify's Admin API can time out, or return a 5xx, AFTER Shopify
// has already created the order. Retrying that blind risks a second real
// Shopify order (and, downstream, a second CT submission attempt) for the
// same Walmart sale -- the exact class of bug ct-order-ledger.ts's header
// comment describes for submitOrder(). createMirrorShopifyOrder() below is
// therefore a SINGLE attempt, never wrapped in retryWithBackoff (unlike the
// Walmart acknowledge/fetch calls elsewhere in this repo, which are safe to
// retry because they are idempotent on Walmart's side). A definitive 4xx
// rejection maps to 'failed' (safe to fix and resubmit); a timeout/network
// error/5xx maps to 'indeterminate' (a human must check Shopify for a
// matching order -- search by the MIRROR_GUARD_TAG tag + the Walmart PO# in
// the order note -- before this row is manually moved forward). This repo's
// code never auto-retries an 'indeterminate' row.
//
// ─── COMPLIANCE: no Shopify Customer record ────────────────────────────────
// CT-INTEGRATION-CONTEXT.md §7 ("Walmart marketing-data restriction"):
// Walmart's Marketplace agreement restricts using their buyer data for
// marketing, so mirrored orders must not create a Shopify Customer record.
// buildMirrorOrderPayload() deliberately omits `email`/`customer` entirely
// (Shopify only creates/links a Customer when an email is present) and sets
// send_receipt / send_fulfillment_receipt to false.
//
// ─── FIELD MAPPING GAPS (do not silently invent data) ──────────────────────
// This repo's own WalmartOrder type (api/walmart-order-sync.ts) has NO phone
// field anywhere under shippingInfo -- unlike gci-walmart-sync's own
// (unrelated, unimported) type, which assumes shippingInfo.phone exists.
// Nothing in this repo has ever verified where -- or whether -- Walmart
// actually sends a buyer phone number in this account's live payloads.
// buildMirrorOrderPayload() leaves shipping_address.phone unset rather than
// guessing a field path. Same caveat as api/walmart-order-sync.ts's own
// header comments for customerOrderId / estimatedShipDate /
// estimatedDeliveryDate: those fields are handled defensively (fall back to
// undefined/omitted, never crash) because their exact shape has never been
// confirmed against a live payload.
//
// Line-item tax is NOT mapped: this repo's OrderLine.charges.charge type is
// generic (chargeType/chargeAmount pairs) and only a 'PRODUCT' chargeType
// has ever been read anywhere in this codebase (getLinePrice-equivalent
// below). Whether Walmart's real payload includes a line-level 'TAX' charge
// entry, and in what shape, is unverified -- so no tax_lines are sent, same
// as no shipping_lines are sent (Walmart's shippingInfo carries dates and an
// address here, never a shipping cost figure, in this repo's type).
// ─────────────────────────────────────────────────────────────

import type { WalmartOrder, OrderLine, PostalAddress } from '../walmart-order-sync.js';

const SUPABASE_URL     = process.env.SUPABASE_URL              ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN   ?? '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
// Matches api/lib/shopify.ts's existing Admin API version for this repo.
// Independent of gci-walmart-sync's own app, which uses its own version.
const API_VERSION = '2024-01';

/** Tag written on every mirrored order, and the guard order-router.ts checks
 *  to avoid double-routing the same order through both this in-process call
 *  and the Shopify orders/paid webhook. Distinct from gci-walmart-sync's own
 *  'walmart-canada' tag -- these are two independent systems that must never
 *  be confused with each other, even if both ever touch the same store. */
export const MIRROR_GUARD_TAG = 'gci-walmart-mirror';

const TABLE = '/walmart_shopify_mirror';

// ─── Ledger types ────────────────────────────────────────────────────────

export type MirrorStatus = 'claimed' | 'mirrored' | 'failed' | 'indeterminate';

export interface MirrorRow {
  walmart_po:           string;
  walmart_order_number: string | null;
  status:               MirrorStatus;
  shopify_order_id:     string | null;
  shopify_order_number: string | null;
  attempt_count:        number;
  request_payload:      unknown;
  response_payload:     unknown;
  error_name:           string | null;
  error_message:        string | null;
  created_at:           string;
  updated_at:           string;
  mirrored_at:          string | null;
}

export class MirrorLedgerError extends Error {
  constructor(m: string) { super(m); this.name = 'MirrorLedgerError'; }
}

/** Thrown when the ledger cannot be reached. Callers must NOT create a Shopify order blind. */
export class MirrorLedgerUnavailableError extends Error {
  constructor(m: string) { super(m); this.name = 'MirrorLedgerUnavailableError'; }
}

export type MirrorOutcome =
  | { kind: 'mirrored';               shopifyOrderId: string; shopifyOrderNumber: string; freshlyCreated: boolean }
  | { kind: 'failed';                 reason: string }
  | { kind: 'indeterminate';          reason: string }
  | { kind: 'indeterminate_unresolved'; reason: string };

// ─── PostgREST transport ─────────────────────────────────────────────────
// Deliberately local, not shared with ct-order-ledger.ts or lib/supabase.ts
// -- same convention already used by walmart-order-alerts.ts (see its own
// header comment) rather than introducing a shared abstraction as a
// drive-by refactor here.

function requireEnv(): void {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new MirrorLedgerUnavailableError(
      'Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
      'Refusing to proceed: without the ledger there is no duplicate-mirror guard.'
    );
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey:          SERVICE_ROLE_KEY,
    Authorization:   `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type':  'application/json',
    Accept:          'application/json',
    ...extra,
  };
}

async function rest(path: string, init: RequestInit): Promise<Response> {
  requireEnv();
  try {
    return await fetch(`${SUPABASE_URL}/rest/v1${path}`, init);
  } catch (err: any) {
    throw new MirrorLedgerUnavailableError(`Supabase request failed (${path}): ${err?.message}`);
  }
}

async function getByWalmartPo(walmartPo: string): Promise<MirrorRow | null> {
  const res = await rest(`${TABLE}?walmart_po=eq.${encodeURIComponent(walmartPo)}&select=*&limit=1`, {
    method: 'GET', headers: headers(),
  });
  if (!res.ok) {
    throw new MirrorLedgerUnavailableError(`Supabase GET ${TABLE} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = await res.json() as MirrorRow[];
  return rows[0] ?? null;
}

async function patchRow(walmartPo: string, patch: Record<string, unknown>): Promise<MirrorRow> {
  const res = await rest(`${TABLE}?walmart_po=eq.${encodeURIComponent(walmartPo)}`, {
    method:  'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body:    JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new MirrorLedgerUnavailableError(`Supabase PATCH ${TABLE} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = await res.json() as MirrorRow[];
  if (!rows.length) {
    throw new MirrorLedgerError(`walmart_shopify_mirror row not found for walmart_po='${walmartPo}' — nothing was updated.`);
  }
  return rows[0];
}

// ─── Claim ───────────────────────────────────────────────────────────────

interface ClaimResult {
  row: MirrorRow;
  /** true = this call inserted the row and owns the mirror attempt.
   *  false = a row already existed; inspect row.status before doing anything. */
  claimed: boolean;
}

async function claimMirror(
  walmartOrder: WalmartOrder,
  requestPayload: unknown,
): Promise<ClaimResult> {
  const walmartPo = walmartOrder.purchaseOrderId;
  if (!walmartPo?.trim()) {
    throw new MirrorLedgerError('claimMirror requires a Walmart purchaseOrderId.');
  }

  const insert = {
    walmart_po:            walmartPo,
    walmart_order_number:  walmartOrder.customerOrderId ?? null,
    status:                'claimed' as const,
    attempt_count:          0,
    request_payload:        requestPayload ?? null,
  };

  const res = await rest(TABLE, {
    method:  'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body:    JSON.stringify(insert),
  });

  if (res.status === 201 || res.status === 200) {
    const rows = await res.json() as MirrorRow[];
    if (!rows.length) {
      throw new MirrorLedgerUnavailableError('Supabase INSERT returned no row — cannot confirm the claim, refusing to create a Shopify order.');
    }
    return { row: rows[0], claimed: true };
  }

  // 409 = unique violation on walmart_po. Someone already has (or had) a
  // claim on this PO -- a previous run, or an overlapping concurrent one.
  if (res.status === 409) {
    const existing = await getByWalmartPo(walmartPo);
    if (!existing) {
      throw new MirrorLedgerUnavailableError(
        `walmart_shopify_mirror rejected the insert for walmart_po='${walmartPo}' as a duplicate, but no ` +
        `existing row could be read back. Refusing to proceed while ledger state is unknown.`
      );
    }
    return { row: existing, claimed: false };
  }

  throw new MirrorLedgerUnavailableError(
    `Supabase POST ${TABLE} → ${res.status}: ${(await res.text()).slice(0, 200)}`
  );
}

// ─── Field mapping ───────────────────────────────────────────────────────

function getLinePrice(line: OrderLine): number {
  const productCharge = line.charges?.charge?.find((c) => c.chargeType === 'PRODUCT');
  return productCharge?.chargeAmount?.amount ?? 0;
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? '',
    lastName:  parts.slice(1).join(' ') || '-',
  };
}

function mapAddress(addr: PostalAddress): Record<string, unknown> {
  const { firstName, lastName } = splitName(addr.name);
  return {
    first_name: firstName,
    last_name:  lastName,
    address1:   addr.address1,
    address2:   addr.address2 ?? '',
    city:       addr.city,
    // No province_code/name distinction available from Walmart's payload in
    // this repo's PostalAddress type -- `state` is passed through as-is,
    // same as this repo's other Walmart->Shopify-shaped field reads.
    province:   addr.state,
    zip:        addr.postalCode,
    country:    addr.country,
    // phone intentionally omitted -- see module header.
  };
}

/**
 * Pure function: Walmart order -> Shopify Admin REST order-creation payload.
 * Exported for the unit test (no network -- see api/tests/).
 */
export function buildMirrorOrderPayload(walmartOrder: WalmartOrder): Record<string, unknown> {
  const address = walmartOrder.shippingInfo.postalAddress;
  const lines = walmartOrder.orderLines?.orderLine ?? [];

  const lineItems = lines.map((line) => ({
    title:             line.item.productName,
    sku:               line.item.sku,
    quantity:          parseInt(line.orderLineQuantity?.amount ?? '1', 10) || 1,
    price:             getLinePrice(line).toFixed(2),
    requires_shipping: true,
  }));

  return {
    // No `email` / `customer` object -- see module header (compliance:
    // never create a Shopify Customer record for a Walmart buyer).
    note:                       `Walmart PO: ${walmartOrder.purchaseOrderId}` +
                                 (walmartOrder.customerOrderId ? ` · Walmart Order#: ${walmartOrder.customerOrderId}` : ''),
    tags:                       MIRROR_GUARD_TAG,
    financial_status:           'paid',
    fulfillment_status:         null,
    send_receipt:               false,
    send_fulfillment_receipt:   false,
    source_name:                MIRROR_GUARD_TAG,
    shipping_address:           mapAddress(address),
    line_items:                 lineItems,
    // No shipping_lines / tax_lines -- see module header (unverified /
    // unavailable Walmart fields; never fabricated).
  };
}

// ─── Shopify order creation (single attempt — see module header) ─────────

interface ShopifyOrderCreateOk {
  ok: true;
  orderId: string;
  orderNumber: string;
  raw: unknown;
}
interface ShopifyOrderCreateFailed {
  ok: false;
  transient: boolean; // true => classify as indeterminate; false => failed
  message: string;
}

async function createMirrorShopifyOrder(
  payload: Record<string, unknown>,
): Promise<ShopifyOrderCreateOk | ShopifyOrderCreateFailed> {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    // Configuration problem, not a Shopify-side failure -- definitive, not
    // indeterminate. No claim state is at risk of a phantom duplicate here.
    return { ok: false, transient: false, message: 'Shopify credentials not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN)' };
  }

  try {
    const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ order: payload }),
    });

    if (res.ok) {
      const data: any = await res.json();
      const id = data?.order?.id;
      const name = data?.order?.name;
      if (id == null) {
        // 2xx with no order id is exactly the "success-without-id" case
        // ct-order-ledger.ts's markIndeterminate() exists for -- Shopify
        // MAY have created the order, we cannot confirm it from this
        // response. Never assume success without an id.
        return { ok: false, transient: true, message: `Shopify returned ${res.status} with no order.id in the response body` };
      }
      return { ok: true, orderId: String(id), orderNumber: String(name ?? `#${id}`), raw: data };
    }

    const body = await res.text();
    if (res.status >= 500) {
      return { ok: false, transient: true, message: `Shopify order create failed: ${res.status} ${body.slice(0, 300)}` };
    }
    // 4xx — definitive rejection (bad payload, invalid SKU shape, etc.).
    return { ok: false, transient: false, message: `Shopify order create rejected: ${res.status} ${body.slice(0, 300)}` };
  } catch (err: any) {
    // Network-level failure (timeout, DNS, connection reset) — Shopify may
    // or may not have received/processed the request. Treat as transient
    // (indeterminate), same as a 5xx.
    return { ok: false, transient: true, message: `Shopify order create threw: ${err?.message ?? String(err)}` };
  }
}

// ─── Orchestration ─────────────────────────────────────────────────────────

/**
 * Mirror one Walmart order into Shopify, exactly once, ever.
 *
 * Safe to call on every walmart-order-sync run for the same order (the 48h
 * rolling lookback means it will be) -- the walmart_shopify_mirror row is
 * what makes repeated calls a no-op once the order is actually mirrored, or
 * a safe single retry attempt while it is still 'claimed'/'failed'.
 *
 * NEVER calls Shopify twice for a row already 'mirrored', and NEVER
 * auto-retries a row left 'indeterminate' by a previous attempt — that
 * status means a human must check Shopify directly before this order is
 * touched again (search: tag "gci-walmart-mirror" + this Walmart PO# in the
 * order note).
 */
export async function mirrorWalmartOrderToShopify(walmartOrder: WalmartOrder): Promise<MirrorOutcome> {
  const walmartPo = walmartOrder.purchaseOrderId;
  const payload = buildMirrorOrderPayload(walmartOrder);

  const claim = await claimMirror(walmartOrder, payload);

  if (!claim.claimed) {
    const row = claim.row;
    if (row.status === 'mirrored') {
      if (!row.shopify_order_id || !row.shopify_order_number) {
        // Should not happen (mirrored is only ever set alongside both
        // fields — see markMirrored below) — fail loudly rather than
        // silently treating this as fresh.
        throw new MirrorLedgerError(
          `walmart_shopify_mirror row for ${walmartPo} is 'mirrored' but missing shopify_order_id/shopify_order_number.`
        );
      }
      return { kind: 'mirrored', shopifyOrderId: row.shopify_order_id, shopifyOrderNumber: row.shopify_order_number, freshlyCreated: false };
    }
    if (row.status === 'indeterminate') {
      return {
        kind: 'indeterminate_unresolved',
        reason: `Previous attempt for ${walmartPo} left this order indeterminate (${row.error_message ?? 'no message'}). ` +
                `Not retried automatically — a human must confirm in Shopify whether an order for this PO already exists.`,
      };
    }
    // status is 'claimed' or 'failed' — safe to attempt once more, using
    // the EXISTING row rather than re-inserting.
    return attemptCreate(walmartPo, row.attempt_count, payload);
  }

  return attemptCreate(walmartPo, 0, payload);
}

async function attemptCreate(
  walmartPo: string,
  attemptCountBefore: number,
  payload: Record<string, unknown>,
): Promise<MirrorOutcome> {
  const result = await createMirrorShopifyOrder(payload);

  if (result.ok) {
    await patchRow(walmartPo, {
      status:               'mirrored',
      shopify_order_id:     result.orderId,
      shopify_order_number: result.orderNumber,
      response_payload:     result.raw ?? null,
      error_name:           null,
      error_message:        null,
      attempt_count:        attemptCountBefore + 1,
      mirrored_at:          new Date().toISOString(),
    });
    return { kind: 'mirrored', shopifyOrderId: result.orderId, shopifyOrderNumber: result.orderNumber, freshlyCreated: true };
  }

  if (result.transient) {
    await patchRow(walmartPo, {
      status:         'indeterminate',
      error_name:     'ShopifyOrderCreateIndeterminate',
      error_message:  result.message,
      attempt_count:  attemptCountBefore + 1,
    });
    return { kind: 'indeterminate', reason: result.message };
  }

  await patchRow(walmartPo, {
    status:         'failed',
    error_name:     'ShopifyOrderCreateFailed',
    error_message:  result.message,
    attempt_count:  attemptCountBefore + 1,
  });
  return { kind: 'failed', reason: result.message };
}

/** Read-only lookup, for observability/reconciliation logging. */
export async function getMirrorStatus(walmartPo: string): Promise<MirrorRow | null> {
  return getByWalmartPo(walmartPo);
}

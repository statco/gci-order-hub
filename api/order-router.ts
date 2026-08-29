// api/order-router.ts
// ─────────────────────────────────────────────────────────────
// POST /api/order-router
//
// Shopify webhook handler (topic: orders/paid).
// Register in Shopify Admin → Settings → Notifications → Webhooks.
//
// Flow:
//  1. Verify Shopify HMAC signature (SHOPIFY_WEBHOOK_SECRET)
//  2. Hand ALL line items to routeOrderToCT() → classifyLineItems(), which
//     asks CT's real product-search RESTlet what's CT-eligible. No local
//     SKU-prefix filtering — see CT-INTEGRATION-CONTEXT.md §14 for why
//     that used to exist and why it was removed 2026-08-28: it required a
//     'TIRE-' prefix that the live catalog has never actually used, so
//     every real order's line items were silently falling into
//     unknownItems (console.warn() only, no alert) since this handler
//     went live. classifyLineItems() already excludes non-CT items
//     (install fees / warranties) internally via isCandidateForCT() —
//     nothing here needs to duplicate that.
//  3. Whatever CT auto-routing does or doesn't resolve, always fire the
//     manual-authorize notification (Telegram + email) unless the order
//     was fully auto-submitted or already handled by a human — see the
//     outcome-kind branches below. This is the real safety net and is
//     outcome-agnostic, so it covers items CT doesn't recognize too.
//  4. Mixed/partial outcomes still return 200 — Shopify would otherwise
//     retry the whole webhook on a non-2xx.
//
// NUPROZ- (nuprozone.com dropshipping via CJ) routing removed 2026-07 --
// confirmed permanently discontinued. See git history if ever needed again.
//
// Env vars:
//   SHOPIFY_WEBHOOK_SECRET  — from Shopify webhook config
//   ORDER_ROUTER_SECRET     — 32+ char random string for signing auth links
//   APP_BASE_URL            — e.g. https://your-vercel-domain.vercel.app
// ─────────────────────────────────────────────────────────────

import crypto                                       from 'crypto';
import type { VercelRequest, VercelResponse }        from '@vercel/node';
import { sendOrderNotification, NotifyPayload }      from './lib/notify.js';
import { CT_AUTO_PO_ENABLED }                        from './lib/ct-client.js';
import { routeOrderToCT }                            from './lib/ct-order-routing.js';
import { dispatchInstaller }                         from './lib/installer-dispatch.js';
import { MIRROR_GUARD_TAG }                          from './lib/walmart-shopify-mirror.js';

export const config = { maxDuration: 30 };

// ─── CONSTANTS ────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? '';
const ROUTER_SECRET  = process.env.ORDER_ROUTER_SECRET    ?? '';
const APP_BASE_URL   = (
  process.env.APP_BASE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
).replace(/\/$/, '');

// Defensive strip only, NOT a classification filter — see CT-INTEGRATION-
// CONTEXT.md §14. Real catalog SKUs are bare; this exists only in case a
// stray 'TIRE-' prefix ever shows up on a line item, matching the same
// normalization used in lib/shopify.ts and admin-canary-ct-order.ts.
const STALE_TIRE_PREFIX = 'TIRE-';
// NUPROZ- (nuprozone.com dropshipping) routing removed 2026-07 --
// confirmed by GCI Tires as permanently discontinued (brand-conflict
// decision, not a temporary pause). See git history for the old CJ
// Dropshipping integration if this is ever needed again.

// Your approximate net cost ratio — adjust per supplier agreement
const TIRE_COST_RATIO   = 0.50;

// ─── SHOPIFY TYPES ────────────────────────────────────────────

export interface ShopifyLineItem {
  id:         number;
  sku:        string;
  title:      string;
  quantity:   number;
  price:      string;
  variant_id: number;
  properties?: Array<{ name: string; value: string }>;
}

interface ShopifyAddress {
  first_name?:    string;
  last_name?:     string;
  address1?:      string;
  address2?:      string;
  city?:          string;
  province?:      string;
  province_code?: string;
  zip?:           string;
  country_code?:  string;
  phone?:         string;
}

interface ShopifyOrder {
  id:               number;
  name:             string;   // "#1042"
  email:            string;
  line_items:       ShopifyLineItem[];
  shipping_address?: ShopifyAddress;
  billing_address?:  ShopifyAddress;
  note_attributes?:  Array<{ name: string; value: string }>;
  // Comma-separated on the REST webhook payload, e.g. "gci-walmart-mirror, foo".
  tags?:            string;
}

/** True if this order carries the mirror's guard tag — see the guard check
 *  in the handler below for why this must short-circuit before any routing. */
function hasMirrorGuardTag(order: ShopifyOrder): boolean {
  return (order.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .includes(MIRROR_GUARD_TAG);
}

// ─── INSTALLER METADATA ───────────────────────────────────────

interface InstallerMeta {
  fulfillmentType: string;   // "direct_to_customer" | "ship_to_installer"
  installerId:     string;
  installerName:   string;
  appointmentDate: string;
  fitmentVerified: boolean;
}

function extractInstallerMeta(order: ShopifyOrder): InstallerMeta {
  const map: Record<string, string> = {};
  for (const a of order.note_attributes ?? []) map[a.name] = a.value;
  return {
    fulfillmentType: map['gci_fulfillment_type'] ?? 'direct_to_customer',
    installerId:     map['gci_installer_id']     ?? '',
    installerName:   map['gci_installer_name']   ?? '',
    appointmentDate: map['gci_appointment_date'] ?? '',
    fitmentVerified: map['gci_fitment_verified'] === 'true',
  };
}

// ─── HMAC VERIFICATION ───────────────────────────────────────

async function readBody(req: VercelRequest): Promise<Uint8Array> {
  return new Promise((res, rej) => {
    const chunks: Uint8Array[] = [];
    req.on('data', (c: Buffer) => chunks.push(new Uint8Array(c)));
    req.on('end',  ()          => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function verifyShopifyHmac(rawBody: Uint8Array, header: string): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn('⚠️  SHOPIFY_WEBHOOK_SECRET not set — HMAC check skipped');
    return true;
  }
  const digest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(new Uint8Array(Buffer.from(digest)), new Uint8Array(Buffer.from(header)));
  } catch {
    return false;
  }
}

// ─── AUTHORIZE-LINK TOKEN ─────────────────────────────────────

export interface AuthToken {
  orderId:      number;
  orderNumber:  string;
  supplierType: 'TIRE' | 'NUPROZ';
  cjOrderId?:   string;
  exp:          number;  // unix ms
}

export function buildAuthorizeUrl(payload: AuthToken): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto
    .createHmac('sha256', ROUTER_SECRET || 'dev-secret')
    .update(data)
    .digest('hex');
  return `${APP_BASE_URL}/api/authorize-order?data=${data}&sig=${sig}`;
}

/**
 * Normalizes Shopify line items for CT routing — strips a stray 'TIRE-'
 * prefix if present (defensive only, see STALE_TIRE_PREFIX above) and
 * upper-cases every SKU. Deliberately does NOT filter by prefix or
 * classify anything — that's classifyLineItems()'s job now, against CT's
 * real live catalog. See CT-INTEGRATION-CONTEXT.md §14.
 * Exported for unit testing.
 */
export function normalizeLineItems(lineItems: ShopifyLineItem[]): ShopifyLineItem[] {
  return lineItems
    .filter((i) => i.sku)
    .map((i) => ({
      ...i,
      sku: i.sku.toUpperCase().startsWith(STALE_TIRE_PREFIX)
        ? i.sku.toUpperCase().slice(STALE_TIRE_PREFIX.length)
        : i.sku.toUpperCase(),
    }));
}

// ─── MAIN HANDLER ─────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Read raw body before JSON parse (needed for HMAC)
  let rawBody: Uint8Array;
  let order:   ShopifyOrder;
  try {
    rawBody = await readBody(req);
    order   = JSON.parse(Buffer.from(rawBody).toString('utf-8')) as ShopifyOrder;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Verify Shopify signature
  const hmacHeader = (req.headers['x-shopify-hmac-sha256'] as string) ?? '';
  if (!verifyShopifyHmac(rawBody, hmacHeader)) {
    console.error(`❌ HMAC failed for order ${order?.name}`);
    return res.status(401).json({ error: 'HMAC verification failed' });
  }

  // Sanity-check topic (belt-and-suspenders; already enforced in Shopify webhook config)
  const topic = req.headers['x-shopify-topic'] as string ?? '';
  if (topic && topic !== 'orders/paid') {
    return res.status(200).json({ skipped: true, topic });
  }

  // ── Walmart mirror guard ─────────────────────────────────────
  // api/lib/walmart-shopify-mirror.ts creates Shopify orders tagged
  // MIRROR_GUARD_TAG ('gci-walmart-mirror') and calls routeOrderToCT()
  // in-process, directly, right after creation — see
  // api/walmart-order-sync.ts. Whether Shopify's Admin API fires
  // orders/paid for an order created via that API and marked paid WITHOUT
  // a processed transaction (Walmart collects payment; Shopify processes
  // none) is UNVERIFIED — see CT-INTEGRATION-CONTEXT.md §6 item 4.
  // Assume it does. If this webhook were also allowed to route a
  // mirrored order, the tire would be submitted to Canada Tire TWICE
  // against a live credit line. Returns 200 early, without any routing,
  // for any order carrying the tag — this looks like a bug and is not;
  // see CT-INTEGRATION-CONTEXT.md §1.
  if (hasMirrorGuardTag(order)) {
    console.log(`⏭️  Order ${order.name} carries '${MIRROR_GUARD_TAG}' — mirror already routed it in-process, skipping webhook routing.`);
    return res.status(200).json({ skipped: true, reason: 'walmart-mirror-guard', order: order.name });
  }

  console.log(`📦 Order received: ${order.name} (id=${order.id})`);

  // ── Normalize all line items — no local classification ──────────
  // See CT-INTEGRATION-CONTEXT.md §14: this used to split into
  // tireItems/unknownItems by a 'TIRE-' SKU prefix the live catalog has
  // never actually used, silently dropping every real order's items into
  // unknownItems (console.warn() only, no alert). Removed 2026-08-28.
  // classifyLineItems() (called inside routeOrderToCT() below) already
  // does real classification against CT's live catalog, including
  // excluding non-CT items (install fees/warranties) via its own
  // isCandidateForCT() filter — nothing here needs to duplicate that.
  const items = normalizeLineItems(order.line_items);

  const installer = extractInstallerMeta(order);
  const addr      = order.shipping_address ?? order.billing_address ?? {};
  const custName  = [addr.first_name, addr.last_name].filter(Boolean).join(' ') || order.email;

  const results: string[] = [];
  const errors:  string[] = [];

  // ── Route the whole order through CT auto-routing / manual notify ────
  if (items.length > 0) {
    try {
      const notifyItems = items.map(i => ({
        sku:      i.sku,
        title:    i.title,
        quantity: i.quantity,
        unitCost: parseFloat(i.price) * TIRE_COST_RATIO,
      }));
      const totalCost = notifyItems.reduce((s, i) => s + i.unitCost * i.quantity, 0);

      // ── The switch ──────────────────────────────────────────
      // Only attempted when CT_AUTO_PO_ENABLED=true. routeOrderToCT() runs
      // the shared classify → claim → submit flow (ct-order-routing.ts),
      // which handles the ship_to_installer case as an explicit refusal
      // BEFORE any ledger claim (no more sending CT an empty address and
      // letting it throw). Any outcome other than 'submitted' falls through
      // to the existing manual-authorize notification below -- exactly
      // today's behavior for "CT auto-PO didn't happen". Nothing here is a
      // hard dependency on CT being ready.
      let autoSubmittedCtPoId: string | undefined;
      let skipManualNotify = false;
      if (CT_AUTO_PO_ENABLED) {
        try {
          const outcome = await routeOrderToCT({
            channel:           'shopify',
            sourceOrderId:     String(order.id),
            sourceOrderNumber: order.name,
            lineItems: items.map(i => ({ sku: i.sku, quantity: i.quantity })),
            shipTo: {
              name:       custName,
              address1:   addr.address1,
              address2:   addr.address2,
              city:       addr.city,
              province:   addr.province_code ?? addr.province,
              postalCode: addr.zip,
              country:    addr.country_code ?? 'CA',
              phone:      addr.phone,
            },
            shipToInstaller: installer.fulfillmentType === 'ship_to_installer',
            installerName:   installer.installerName,
            installerId:     installer.installerId,
            meta: { resultingShopifyOrderNumber: order.name },
            tags: (order.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
          });

          if (outcome.kind === 'submitted') {
            autoSubmittedCtPoId = outcome.ctOrderNumber;
            console.log(`✅ CT auto-PO submitted for order ${order.name}: ${autoSubmittedCtPoId}`);
          } else if (outcome.kind === 'po_drafted_skip') {
            // A human already sent CT a real PO by hand for this order (see
            // CT-INTEGRATION-CONTEXT.md §12) — do NOT fall through to the
            // manual-authorize notification below; that would ask someone to
            // do a job that's already done. routeOrderToCT() already sent
            // its own Telegram alert for this outcome.
            skipManualNotify = true;
            console.log(`⏭️  CT routing for order ${order.name}: already manually drafted/sent — skipping manual-authorize notification.`);
          } else if (outcome.kind === 'not_configured') {
            console.log(`ℹ️  CT auto-PO not yet configured — falling back to manual authorize flow for ${order.name}`);
          } else if (outcome.kind === 'already_claimed') {
            console.log(`ℹ️  CT routing for order ${order.name}: already claimed as ${outcome.poNumber} (status=${outcome.existingStatus}) — falling back to manual authorize flow.`);
          } else if (outcome.kind === 'no_ct_items') {
            // CT's real classification found nothing it recognizes on this
            // order — could be genuinely non-tire items, or a real catalog
            // gap worth raising with CT (see CT-INTEGRATION-CONTEXT.md §13's
            // #1003 note). Either way, still falls through to manual notify
            // below — a human needs to see this order regardless.
            console.log(`ℹ️  CT routing for order ${order.name}: no CT-eligible items (${outcome.reason}) — falling back to manual authorize flow.`);
          } else {
            console.log(`ℹ️  CT routing for order ${order.name}: ${outcome.kind} (${outcome.reason}) — falling back to manual authorize flow.`);
          }
        } catch (err: any) {
          console.error(`⚠️  CT routing threw for ${order.name}, falling back to manual:`, err);
          // Deliberately not re-thrown -- manual flow below is the safety net.
        }
      }

      if (skipManualNotify) {
        // Order already carries the 'po-drafted' tag — a human already sent
        // CT a real PO by hand (Cowork tool, no repo — see
        // CT-INTEGRATION-CONTEXT.md §12). Sending a manual-authorize
        // notification here would ask someone to do a job that's already
        // done; routeOrderToCT() already sent its own Telegram alert.
        results.push('TIRE: already manually drafted/sent — no notification sent');
      } else {
        const authUrl = buildAuthorizeUrl({
          orderId:     order.id,
          orderNumber: order.name,
          supplierType:'TIRE',
          exp:         Date.now() + 24 * 60 * 60 * 1_000,
        });

        const po = {
          shopifyOrderId: order.id,
          orderNumber:    order.name,
          createdAt:      new Date().toISOString(),
          items:          notifyItems,
          shippingAddress: installer.fulfillmentType === 'ship_to_installer'
            ? { note: `Ship to installer: ${installer.installerName} (id: ${installer.installerId})` }
            : addr,
          installerMeta: installer,
          autoSubmittedCtPoId,
        };
        console.log('🛞 TIRE PO:', JSON.stringify(po));

        const notify: NotifyPayload = {
          shopifyOrderId:   order.id,
          orderNumber:      order.name,
          supplierType:     'TIRE',
          items:            notifyItems,
          totalCost,
          authorizeUrl:     authUrl,
          customerName:     custName,
          shippingCity:     addr.city          ?? '',
          shippingProvince: addr.province_code ?? addr.province ?? '',
          installerName:    installer.installerName  || undefined,
          appointmentDate:  installer.appointmentDate || undefined,
          autoSubmittedCtPoId,
        };
        await sendOrderNotification(notify);
        results.push(autoSubmittedCtPoId
          ? `TIRE: auto-submitted to CT (PO ${autoSubmittedCtPoId}) + notification sent`
          : 'TIRE: PO built + notification sent');
      }
    } catch (err: any) {
      console.error('❌ TIRE routing error:', err);
      errors.push(`TIRE: ${err.message}`);
    }
  }

  // ── Installer dispatch (AI Match + any other flow that sets gci_installer_id) ──
  // Runs independently of supplier routing above -- an order can need
  // installer dispatch regardless of whether its tire came via TIRE-/NUPROZ-/
  // unprefixed SKU. Only fires here, AFTER Shopify has confirmed payment
  // (this whole handler is the orders/paid webhook) -- see installer-dispatch.ts
  // for why that ordering matters.
  if (installer.installerId) {
    try {
      const addressParts = [addr.address1, addr.address2, addr.city, addr.province_code ?? addr.province, addr.zip]
        .filter(Boolean);
      const dispatch = await dispatchInstaller({
        shopifyOrderId:  order.id,
        orderNumber:     order.name,
        customerEmail:   order.email,
        customerName:    custName,
        customerPhone:   addr.phone,
        customerAddress: addressParts.join(', '),
        lineItems:       order.line_items,
        installerId:     installer.installerId,
        installerName:   installer.installerName,
      });
      if (dispatch.ok) {
        results.push(`INSTALL: job created + confirmation sent (installer: ${installer.installerName || installer.installerId})`);
      } else {
        // Partial failure (e.g. job created but email failed, or vice versa) --
        // surface as a warning, not a hard failure, since Shopify would retry
        // the whole webhook on a 500 and we don't want duplicate Airtable jobs.
        errors.push(`INSTALL (partial): ${dispatch.errors.join('; ')}`);
      }
    } catch (err: any) {
      console.error('❌ Installer dispatch error:', err);
      errors.push(`INSTALL: ${err.message}`);
    }
  }

  // Shopify retries on non-2xx — only return 500 if everything failed
  if (errors.length > 0 && results.length === 0) {
    return res.status(500).json({ error: 'All routing failed', errors });
  }

  return res.status(200).json({
    ok:     true,
    order:  order.name,
    routed: results,
    ...(errors.length ? { warnings: errors } : {}),
  });
}

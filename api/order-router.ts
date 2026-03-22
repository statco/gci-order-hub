// api/order-router.ts
// ─────────────────────────────────────────────────────────────
// POST /api/order-router
//
// Shopify webhook handler (topic: orders/paid).
// Register in Shopify Admin → Settings → Notifications → Webhooks.
//
// Flow:
//  1. Verify Shopify HMAC signature (SHOPIFY_WEBHOOK_SECRET)
//  2. Split line items by SKU prefix
//       TIRE-   → build Canada Tire PO, preserve installer metadata
//       NUPROZ- → create CJ Dropshipping order in PENDING state
//  3. For each supplier batch: generate HMAC-signed 24h authorize link
//  4. Fire notifications (Telegram + email) — order not submitted yet
//  5. Mixed orders handled independently (separate supplier batches)
//
// Env vars:
//   SHOPIFY_WEBHOOK_SECRET  — from Shopify webhook config
//   ORDER_ROUTER_SECRET     — 32+ char random string for signing auth links
//   APP_BASE_URL            — e.g. https://your-vercel-domain.vercel.app
// ─────────────────────────────────────────────────────────────

import crypto                                       from 'crypto';
import type { VercelRequest, VercelResponse }        from '@vercel/node';
import { createOrder }                               from './lib/cj-client.js';
import { sendOrderNotification, NotifyPayload }      from './lib/notify.js';

export const config = { maxDuration: 30 };

// ─── CONSTANTS ────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? '';
const ROUTER_SECRET  = process.env.ORDER_ROUTER_SECRET    ?? '';
const APP_BASE_URL   = (
  process.env.APP_BASE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
).replace(/\/$/, '');

const TIRE_PREFIX   = 'TIRE-';
const NUPROZ_PREFIX = 'NUPROZ-';

// Your approximate net cost ratios — adjust per supplier agreement
const TIRE_COST_RATIO   = 0.50;
const NUPROZ_COST_RATIO = 0.60;

// ─── SHOPIFY TYPES ────────────────────────────────────────────

interface ShopifyLineItem {
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

async function readBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end',  ()          => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function verifyShopifyHmac(rawBody: Buffer, header: string): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn('⚠️  SHOPIFY_WEBHOOK_SECRET not set — HMAC check skipped');
    return true;
  }
  const digest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(header));
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

// ─── MAIN HANDLER ─────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Read raw body before JSON parse (needed for HMAC)
  let rawBody: Buffer;
  let order:   ShopifyOrder;
  try {
    rawBody = await readBody(req);
    order   = JSON.parse(rawBody.toString('utf-8')) as ShopifyOrder;
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

  console.log(`📦 Order received: ${order.name} (id=${order.id})`);

  // ── Split line items by SKU prefix ───────────────────────────
  const tireItems:    ShopifyLineItem[] = [];
  const nuProzItems:  ShopifyLineItem[] = [];
  const unknownItems: ShopifyLineItem[] = [];

  for (const item of order.line_items) {
    const sku = (item.sku ?? '').toUpperCase();
    if (sku.startsWith(TIRE_PREFIX))   { tireItems.push(item);   continue; }
    if (sku.startsWith(NUPROZ_PREFIX)) { nuProzItems.push(item); continue; }
    unknownItems.push(item);
  }

  if (unknownItems.length) {
    console.warn(
      `⚠️  Order ${order.name}: unrecognised SKU prefix on`,
      unknownItems.map(i => i.sku).join(', '),
    );
  }

  const installer = extractInstallerMeta(order);
  const addr      = order.shipping_address ?? order.billing_address ?? {};
  const custName  = [addr.first_name, addr.last_name].filter(Boolean).join(' ') || order.email;

  const results: string[] = [];
  const errors:  string[] = [];

  // ── TIRE- items → Canada Tire PO ─────────────────────────────
  if (tireItems.length > 0) {
    try {
      const notifyItems = tireItems.map(i => ({
        sku:      i.sku,
        title:    i.title,
        quantity: i.quantity,
        unitCost: parseFloat(i.price) * TIRE_COST_RATIO,
      }));
      const totalCost = notifyItems.reduce((s, i) => s + i.unitCost * i.quantity, 0);

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
      };
      await sendOrderNotification(notify);
      results.push('TIRE: PO built + notification sent');
    } catch (err: any) {
      console.error('❌ TIRE routing error:', err);
      errors.push(`TIRE: ${err.message}`);
    }
  }

  // ── NUPROZ- items → CJ Dropshipping pending order ────────────
  if (nuProzItems.length > 0) {
    try {
      const cjProducts = nuProzItems.map(i => ({
        vid:      i.sku.replace(/^NUPROZ-/i, ''),   // CJ vid stored after prefix
        quantity: i.quantity,
      }));

      const cjOrder = await createOrder({
        orderNumber:          order.name,
        shippingCountry:      addr.country_code  ?? 'CA',
        shippingCustomerName: custName,
        shippingPhone:        addr.phone         ?? '',
        shippingAddress:      addr.address1       ?? '',
        shippingAddress2:     addr.address2       ?? '',
        shippingCity:         addr.city           ?? '',
        shippingProvince:     addr.province_code  ?? addr.province ?? '',
        shippingZip:          addr.zip            ?? '',
        products:             cjProducts,
      });

      const notifyItems = nuProzItems.map(i => ({
        sku:      i.sku,
        title:    i.title,
        quantity: i.quantity,
        unitCost: parseFloat(i.price) * NUPROZ_COST_RATIO,
      }));
      const totalCost = notifyItems.reduce((s, i) => s + i.unitCost * i.quantity, 0);

      const authUrl = buildAuthorizeUrl({
        orderId:     order.id,
        orderNumber: order.name,
        supplierType:'NUPROZ',
        cjOrderId:   cjOrder.orderId,
        exp:         Date.now() + 24 * 60 * 60 * 1_000,
      });

      const notify: NotifyPayload = {
        shopifyOrderId:   order.id,
        orderNumber:      `${order.name}-NUPROZ`,
        supplierType:     'NUPROZ',
        items:            notifyItems,
        totalCost,
        authorizeUrl:     authUrl,
        customerName:     custName,
        shippingCity:     addr.city          ?? '',
        shippingProvince: addr.province_code ?? addr.province ?? '',
        cjOrderId:        cjOrder.orderId,
      };
      await sendOrderNotification(notify);
      results.push(`NUPROZ: CJ pending order ${cjOrder.orderId} created + notification sent`);
    } catch (err: any) {
      console.error('❌ NUPROZ routing error:', err);
      errors.push(`NUPROZ: ${err.message}`);
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

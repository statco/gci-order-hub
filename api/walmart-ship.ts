// api/walmart-ship.ts
// ─────────────────────────────────────────────────────────────
// POST /api/walmart-ship
//
// Marks a Walmart order as shipped and updates the Google Sheet + Telegram.
//
// Body / query params:
//   orderId        — Walmart purchase order number
//   trackingNumber — carrier tracking number
//   carrier        — carrier name (default: PUROLATOR)
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client.js';
import { updateSheetRowByOrderId } from './lib/sheets-client.js';

export const config = { maxDuration: 60 };

const WALMART_BASE_URL    = process.env.WALMART_BASE_URL!;
const SHEET_ID            = process.env.WALMART_ORDER_LOG_SHEET_ID!;
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID!;

// ── Carrier maps ─────────────────────────────────────────────────────────

const CARRIER_MAP: Record<string, string> = {
  purolator:     'PUROLATOR',
  ups:           'UPS',
  fedex:         'FEDEX',
  'canada post': 'CANADA_POST',
  canadapost:    'CANADA_POST',
  dhl:           'DHL',
  gls:           'OTHER',
  '*gls':        'OTHER',
  canpar:        'OTHER',
};

// Carriers that Walmart classifies as OTHER but have their own tracking portals.
// Checked before TRACKING_URL_MAP so the right link appears in Telegram.
const RAW_CARRIER_TRACKING_OVERRIDES: Record<string, (t: string) => string> = {
  canpar: (t) => `https://www.canpar.com/en/tracking/TrackingAction.do?reference=${t}&locale=en`,
};

const TRACKING_URL_MAP: Record<string, (t: string) => string> = {
  PUROLATOR:   (t) => `https://www.purolator.com/en/shipping/tracker?pin=${t}`,
  UPS:         (t) => `https://www.ups.com/track?tracknum=${t}`,
  FEDEX:       (t) => `https://www.fedex.com/fedextrack/?trknbr=${t}`,
  CANADA_POST: (t) => `https://www.canadapost-postescanada.ca/track-reperage/en#/details/${t}`,
  DHL:         (t) => `https://www.dhl.com/en/express/tracking.html?AWB=${t}`,
  OTHER:       (t) => `https://gls-group.com/CA/en/parcel-tracking/?match=${t}`,
};

function normalizeCarrier(raw: string): string {
  const key = raw.trim().toLowerCase();
  return CARRIER_MAP[key] ?? raw.toUpperCase();
}

// rawCarrier preserved so RAW_CARRIER_TRACKING_OVERRIDES can fire even when
// Walmart sees the carrier as OTHER.
function getTrackingUrl(rawCarrier: string, normalizedCarrier: string, trackingNumber: string): string {
  const rawKey = rawCarrier.trim().toLowerCase();
  const fn = RAW_CARRIER_TRACKING_OVERRIDES[rawKey]
    ?? TRACKING_URL_MAP[normalizedCarrier]
    ?? TRACKING_URL_MAP['OTHER'];
  return fn(trackingNumber);
}

// ── Walmart helpers ───────────────────────────────────────────────────

function walmartHeaders(token: string): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN':   token,
    'WM_GLOBAL_VERSION':     '3.1',
    'WM_MARKET':             'ca',
    'WM_SVC.NAME':           'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'Accept':                'application/json',
    'Content-Type':          'application/json',
  };
}

async function fetchOrderLines(
  token: string,
  orderId: string,
): Promise<Array<{ lineNumber: string; sku: string }>> {
  const res = await fetch(`${WALMART_BASE_URL}/v3/orders/${orderId}`, {
    headers: walmartHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch order ${orderId}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const lines = data?.order?.orderLines?.orderLine ?? [];
  return lines.map((line: any) => ({
    lineNumber: line.lineNumber,
    sku:        line.item?.sku ?? '',
  }));
}

async function markShipped(
  token: string,
  orderId: string,
  lines: Array<{ lineNumber: string; sku: string }>,
  trackingNumber: string,
  rawCarrier: string,
  normalizedCarrier: string,
): Promise<void> {
  const payload = {
    orderShipment: {
      orderLines: {
        orderLine: lines.map((line) => ({
          lineNumber: line.lineNumber,
          orderLineStatuses: {
            orderLineStatus: [
              {
                status: 'Shipped',
                statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
                trackingInfo: {
                  shipDateTime:  new Date().toISOString(),
                  carrierName:   { carrier: normalizedCarrier },
                  methodCode:    'Standard',
                  trackingNumber,
                  trackingURL:   getTrackingUrl(rawCarrier, normalizedCarrier, trackingNumber),
                },
              },
            ],
          },
        })),
      },
    },
  };

  const res = await fetch(`${WALMART_BASE_URL}/v3/orders/${orderId}/shipping`, {
    method:  'POST',
    headers: walmartHeaders(token),
    body:    JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Walmart ship failed: ${res.status} ${await res.text()}`);
}

// ── Telegram ───────────────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text:       message,
      parse_mode: 'HTML',
    }),
  });
}

// ── Handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const params = req.method === 'POST' ? req.body : req.query;
  const { orderId, trackingNumber, carrier = 'PUROLATOR' } = params;

  if (!orderId || !trackingNumber) {
    return res.status(400).json({ error: 'orderId and trackingNumber are required' });
  }

  const rawCarrier        = carrier as string;
  const normalizedCarrier = normalizeCarrier(rawCarrier);

  try {
    const token = await getWalmartToken();

    // 1. Fetch order lines from Walmart
    const lines = await fetchOrderLines(token, orderId as string);
    if (lines.length === 0) {
      return res.status(404).json({ error: `No order lines found for order ${orderId}` });
    }

    // 2. Mark shipped on Walmart
    await markShipped(
      token,
      orderId as string,
      lines,
      trackingNumber as string,
      rawCarrier,
      normalizedCarrier,
    );
    console.log(`[walmart-ship] Order ${orderId} marked shipped — tracking: ${trackingNumber}`);

    // 3. Update Sheet row
    await updateSheetRowByOrderId(SHEET_ID, orderId as string, {
      status:          'SHIPPED',
      tracking_number: trackingNumber as string,
      carrier:         normalizedCarrier,
      shipped_at:      new Date().toISOString(),
    });
    console.log(`[walmart-ship] Sheet updated for order ${orderId}`);

    // 4. Telegram confirmation
    const trackingUrl = getTrackingUrl(rawCarrier, normalizedCarrier, trackingNumber as string);
    await sendTelegram(
      `✅ <b>Order Shipped</b>\n` +
      `📦 Order: <code>${orderId}</code>\n` +
      `🚚 Carrier: ${normalizedCarrier}\n` +
      `🔢 Tracking: <code>${trackingNumber}</code>\n` +
      `🔗 <a href="${trackingUrl}">Track Package</a>`,
    );

    return res.status(200).json({
      success:      true,
      orderId,
      trackingNumber,
      carrier:      normalizedCarrier,
      linesShipped: lines.length,
    });
  } catch (err: any) {
    console.error('[walmart-ship] Error:', err);
    await sendTelegram(`⚠️ <b>walmart-ship ERROR</b>\nOrder: ${orderId}\n${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}

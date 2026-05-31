import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client.js';
import { getSheetOrderIds, appendSheetRows } from './lib/sheets-client.js';
import { HttpError, retryWithBackoff } from './lib/retry.js';
import { getSyncSince, setSyncSuccess } from './lib/sync-state.js';

export const config = { maxDuration: 300 };

const WALMART_BASE_URL = process.env.WALMART_BASE_URL!;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const SHEET_ID = process.env.WALMART_ORDER_LOG_SHEET_ID!;

// ── Types ──────────────────────────────────────────────────────────────────

interface PostalAddress {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

interface OrderLine {
  lineNumber: string;
  item: { sku: string; productName: string };
  charges: {
    charge: Array<{
      chargeType: string;
      chargeAmount: { currency: string; amount: number };
    }>;
  };
  orderLineQuantity: { amount: string };
}

interface WalmartOrder {
  purchaseOrderId: string;
  orderDate: number;
  shippingInfo: { postalAddress: PostalAddress };
  orderLines: { orderLine: OrderLine[] };
}

// ── Walmart helpers ────────────────────────────────────────────────────────────────

function walmartHeaders(token: string): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_GLOBAL_VERSION': '3.1',
    'WM_MARKET': 'ca',
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

async function fetchCreatedOrders(token: string, since: string): Promise<WalmartOrder[]> {
  // Fetch orders created since the last successful sync (catch-up), filter
  // Created status in code. Throws HttpError on failure so the retry wrapper
  // can classify transient (5xx/520) vs permanent (4xx) responses.
  const url = `${WALMART_BASE_URL}/v3/orders?createdStartDate=${encodeURIComponent(since)}&limit=200`;
  const res = await fetch(url, { headers: walmartHeaders(token) });
  if (!res.ok) {
    throw new HttpError(res.status, `Walmart orders fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const allOrders: WalmartOrder[] = data?.list?.elements?.order ?? [];
  // Filter to only Created status orders
  return allOrders.filter((o) =>
    o.orderLines?.orderLine?.some((line: any) =>
      line.orderLineStatuses?.orderLineStatus?.some((s: any) => s.status === 'Created')
    )
  );
}
async function acknowledgeOrder(token: string, orderId: string): Promise<boolean> {
  const res = await fetch(`${WALMART_BASE_URL}/v3/orders/${orderId}/acknowledge`, {
    method: 'POST',
    headers: walmartHeaders(token),
  });
  if (res.ok) return true;
  // Transient (5xx/520) → throw so retryWithBackoff retries. Permanent (4xx)
  // → return false; the order is already visible via the early alert and gets
  // logged, so one failed ack must not abort the whole run.
  if (res.status >= 500) {
    throw new HttpError(res.status, `acknowledge ${orderId} failed: ${res.status} ${await res.text()}`);
  }
  console.warn(`[order-sync] acknowledge ${orderId} returned ${res.status} (permanent) — continuing`);
  return false;
}

// ── Formatters ───────────────────────────────────────────────────────────────────

function formatAddress(addr: PostalAddress): string {
  return [addr.address1, addr.address2, addr.city, addr.state, addr.postalCode, addr.country]
    .filter(Boolean)
    .join(', ');
}

function getLinePrice(line: OrderLine): number {
  const productCharge = line.charges?.charge?.find((c) => c.chargeType === 'PRODUCT');
  return productCharge?.chargeAmount?.amount ?? 0;
}

// ── Telegram ───────────────────────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ Telegram notify failed ${res.status}:`, body.slice(0, 200));
  } else {
    console.log('✅ Telegram alert sent');
  }
}

function buildTelegramMessage(orders: WalmartOrder[]): string {
  const header =
    orders.length === 1
      ? `🚨 <b>1 New Walmart Order</b>`
      : `🚨 <b>${orders.length} New Walmart Orders</b>`;

  const blocks = orders.map((order) => {
    const addr = order.shippingInfo?.postalAddress;
    const lines = order.orderLines?.orderLine ?? [];
    const total = lines.reduce((sum, l) => sum + getLinePrice(l), 0);

    const linesSummary = lines
      .map((line) => {
        const qty = line.orderLineQuantity?.amount ?? '1';
        const price = getLinePrice(line);
        return `  • <code>${line.item.sku}</code> × ${qty} — $${price.toFixed(2)} CAD`;
      })
      .join('\n');

    return (
      `🛒 <b>Order ${order.purchaseOrderId}</b>\n` +
      `📦 Items:\n${linesSummary}\n` +
      `👤 ${addr?.name ?? 'Unknown'}\n` +
      `📍 ${addr ? formatAddress(addr) : 'Unknown'}\n` +
      `💰 Total: $${total.toFixed(2)} CAD`
    );
  });

  return `${header}\n\n${blocks.join('\n\n─────────────\n\n')}`;
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  // Capture the cursor at the START of the run; we only persist it after a
  // clean completion so a failed pass self-heals on the next successful one.
  const runStartedAt = new Date().toISOString();
  try {
    const token = await getWalmartToken();

    // Catch-up: fetch orders created since the last SUCCESSFUL sync, not since
    // the last run. retryWithBackoff retries transient failures (5xx/520/network)
    // 2s/4s/8s before giving up.
    const since = await getSyncSince();
    const orders = await retryWithBackoff(() => fetchCreatedOrders(token, since), {
      label: 'fetchCreatedOrders',
    });

    if (orders.length === 0) {
      // Nothing to process is itself a clean pass — advance the cursor so we
      // don't re-scan an ever-growing window.
      await setSyncSuccess(runStartedAt);
      console.log('[order-sync] No orders with status=Created');
      return res.status(200).json({ message: 'No new orders', processed: 0 });
    }

    // Dedup against sheet
    const existingIds = await getSheetOrderIds(SHEET_ID);
    const newOrders = orders.filter((o) => !existingIds.has(o.purchaseOrderId));

    if (newOrders.length === 0) {
      // Clean pass (all already deduped) — advance the cursor.
      await setSyncSuccess(runStartedAt);
      console.log('[order-sync] All orders already processed');
      return res.status(200).json({ message: 'All orders already logged', processed: 0 });
    }

    console.log(`[order-sync] ${newOrders.length} new order(s) to process`);

    // 1. Alert fires immediately — before acknowledge or sheet log — so it
    //    reaches the team even if any downstream step fails.
    await sendTelegram(buildTelegramMessage(newOrders));
    console.log('[order-sync] Telegram alert sent');

    const ackedIds = new Set<string>();
    const rows: string[][] = [];

    for (const order of newOrders) {
      // 2. Acknowledge on Walmart (must be within 4 hrs). Retries transient
      //    failures (5xx/520/network) 2s/4s/8s; a permanent 4xx returns false.
      //    A transient exhaustion throws → outer catch alerts + cursor stays put.
      const acked = await retryWithBackoff(
        () => acknowledgeOrder(token, order.purchaseOrderId),
        { label: `acknowledge ${order.purchaseOrderId}` },
      );
      if (acked) ackedIds.add(order.purchaseOrderId);
      console.log(`[order-sync] ${order.purchaseOrderId} acknowledged: ${acked}`);

      const addr = order.shippingInfo?.postalAddress;
      const customerName = addr?.name ?? 'Unknown';
      const customerAddress = addr ? formatAddress(addr) : 'Unknown';
      const orderDate = new Date(order.orderDate).toISOString();
      const orderLines = order.orderLines?.orderLine ?? [];

      // 3. One row per order line
      for (const line of orderLines) {
        rows.push([
          order.purchaseOrderId,        // order_id
          orderDate,                     // created_at
          line.item?.sku ?? '',          // sku
          line.orderLineQuantity?.amount ?? '1', // qty
          customerName,                  // customer_name
          customerAddress,               // customer_address
          getLinePrice(line).toFixed(2), // price
          'PENDING_CT',                  // status
          '',                            // tracking_number
          '',                            // carrier
          '',                            // shipped_at
          acked ? 'TRUE' : 'FALSE',      // walmart_ack
          '',                            // notes
        ]);
      }
    }

    // 4. Log to sheet
    await appendSheetRows(SHEET_ID, rows);
    console.log(`[order-sync] Logged ${rows.length} row(s) to sheet`);

    // 5. Clean completion — advance the catch-up cursor. Persisting at
    //    runStartedAt (not now) keeps any orders created mid-run in range.
    await setSyncSuccess(runStartedAt);

    return res.status(200).json({
      newOrders: newOrders.length,
      acknowledged: ackedIds.size,
      rowsLogged: rows.length,
    });
  } catch (err: any) {
    console.error('[order-sync] Error:', err);
    // Alert on Telegram so you know the cron is broken
    try {
      await sendTelegram(`⚠️ <b>walmart-order-sync ERROR</b>\n${err.message}`);
    } catch (_) {}
    return res.status(500).json({ error: err.message });
  }
}

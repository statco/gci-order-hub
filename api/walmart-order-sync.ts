import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client.js';
import { getSheetOrderIds, appendSheetRows } from './lib/sheets-client.js';
import { HttpError, retryWithBackoff } from './lib/retry.js';
import { getFetchWindowStart, getSyncSince, setSyncSuccess } from './lib/sync-state.js';
import { sendTelegramMessage } from './lib/telegram.js';
import { claimOrderAlert, releaseOrderAlert, getOrInitAlertCutoffMs, isOrderAlerted } from './lib/walmart-order-alerts.js';
import { recordRunAndMaybeHeartbeat } from './lib/sync-heartbeat.js';

export const config = { maxDuration: 300 };

const WALMART_BASE_URL = process.env.WALMART_BASE_URL!;
const SHEET_ID = process.env.WALMART_ORDER_LOG_SHEET_ID!;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PostalAddress {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface OrderLineStatus {
  status: string;
}

export interface OrderLine {
  lineNumber: string;
  item: { sku: string; productName: string };
  charges: {
    charge: Array<{
      chargeType: string;
      chargeAmount: { currency: string; amount: number };
    }>;
  };
  orderLineQuantity: { amount: string };
  orderLineStatuses?: { orderLineStatus: OrderLineStatus[] };
}

export interface WalmartOrder {
  purchaseOrderId: string;
  // "Order#" in the ALERT CONTENT spec, distinct from purchaseOrderId (PO#).
  // NOT verified against a live payload anywhere in this repo — no existing
  // code reads it. Field name per Walmart's public v3 Orders API docs;
  // confirm against a real order (e.g. extend debug-find-order.ts) before
  // relying on it operationally. Falls back to 'N/A' if absent/renamed.
  customerOrderId?: string;
  orderDate: number;
  shippingInfo: {
    postalAddress: PostalAddress;
    // Ship-by / deliver-by. Same caveat as customerOrderId above: field
    // names are unverified against a live payload, not exercised by any
    // other code in this repo. Handled defensively (formatWalmartDate
    // falls back to 'N/A' on anything unparseable) so a wrong field name
    // degrades to a missing date, not a crash.
    estimatedShipDate?: number | string;
    estimatedDeliveryDate?: number | string;
  };
  orderLines: { orderLine: OrderLine[] };
}

// ── Walmart helpers ────────────────────────────────────────────────────────────────

export function walmartHeaders(token: string): Record<string, string> {
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

// Not paginated, deliberately: this account sees ~3 orders/week (see
// lib/sync-heartbeat.ts), createdStartDate covers a fixed rolling window
// (default 48h — see getFetchWindowStart()), and this call has no status
// filter, so `limit` bounds ALL orders of ANY status created in that window,
// not just unprocessed ones. Expected volume in a 48h window is under 1
// order; 200 is roughly two orders of magnitude of headroom. If that
// assumption ever breaks, the length-check below fires a loud, specific
// warning well before silent truncation could happen — add a real
// pagination loop at that point rather than pre-emptively building one for
// a case that has never occurred.
const PAGE_LIMIT = 200;

async function fetchRecentOrders(token: string, since: string): Promise<WalmartOrder[]> {
  // `since` bounds a rolling window (getFetchWindowStart()), NOT the sync
  // cursor — see lib/sync-state.ts's module header for why. No status
  // filter: confirmed via live query (order 600000102653105 /
  // PO 309121065891123, PO 309120965612142) that Walmart's CA marketplace
  // assigns new orders status "Acknowledged" directly — a "Created" filter
  // here matched nothing, ever, silently dropping every order. Dedup is
  // handled downstream by walmart_order_alerts (per-PO claim table) and the
  // Sheet-ID check, both of which are safe against repeated/overlapping
  // fetches, so no status filter is needed on this side.
  // Throws HttpError on failure so the retry wrapper can classify transient
  // (5xx/520) vs permanent (4xx) responses.
  const url = `${WALMART_BASE_URL}/v3/orders?createdStartDate=${encodeURIComponent(since)}&limit=${PAGE_LIMIT}`;
  const res = await fetch(url, { headers: walmartHeaders(token) });
  if (!res.ok) {
    throw new HttpError(res.status, `Walmart orders fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const orders = (data?.list?.elements?.order ?? []) as WalmartOrder[];

  // Pagination tripwire, not pagination itself (see comment above PAGE_LIMIT).
  // A full page is the one observable signal that the "under 1 order per 48h"
  // assumption broke and orders beyond this page may be silently missing.
  if (orders.length === PAGE_LIMIT) {
    console.warn(
      `[order-sync] fetchRecentOrders returned exactly ${PAGE_LIMIT} (the page limit) — ` +
      `order volume may exceed what a single unpaginated page can hold. Orders beyond this ` +
      `page would be silently missing. Investigate before this becomes routine.`
    );
  }

  return orders;
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

/**
 * True if every line on the order is fully Cancelled — order-level, not
 * line-level, matching how this account's seller-cancelled orders actually
 * look (2 of 6 orders in this account are fully seller-cancelled; none seen
 * so far are partially cancelled). A line with no status entries at all is
 * treated as NOT cancelled (fail open on alerting rather than silently
 * swallow an order because of an unexpected payload shape).
 */
export function isFullyCancelled(order: WalmartOrder): boolean {
  const lines = order.orderLines?.orderLine ?? [];
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const statuses = line.orderLineStatuses?.orderLineStatus ?? [];
    return statuses.length > 0 && statuses.every((s) => s.status === 'Cancelled');
  });
}

function formatWalmartDate(value: number | string | undefined): string {
  if (value == null) return 'N/A';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return 'N/A';
  return new Date(ms).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// ── New-order Telegram alert ─────────────────────────────────────────────────
//
// Gated per-PO by walmart_order_alerts (lib/walmart-order-alerts.ts), not by
// the Sheet dedup above — the Sheet read/append pair is check-then-act and
// does not guarantee exactly-once across overlapping cron runs; the claim
// table's unique constraint does. Uses lib/telegram.ts (the existing shared,
// never-throws Telegram sender used elsewhere in this repo) rather than
// api/lib/notify.ts, whose payload shape (mandatory authorizeUrl,
// supplierType 'TIRE'|'NUPROZ', a second Resend email with an "Authorize &
// Submit" CTA) is built for the Shopify → CT/CJ authorization flow and does
// not apply to a Walmart order with no such action.

export function buildTelegramMessage(orders: WalmartOrder[]): string {
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

    const cityProvince = addr ? [addr.city, addr.state].filter(Boolean).join(', ') : 'Unknown';
    const shipBy = formatWalmartDate(order.shippingInfo?.estimatedShipDate);
    const deliverBy = formatWalmartDate(order.shippingInfo?.estimatedDeliveryDate);

    return (
      `🛒 <b>PO ${order.purchaseOrderId}</b>\n` +
      `🆔 Order#: <code>${order.customerOrderId ?? 'N/A'}</code>\n` +
      `📦 Items:\n${linesSummary}\n` +
      `📍 ${cityProvince}\n` +
      `📅 Ship by ${shipBy} · Deliver by ${deliverBy}\n` +
      `💰 Revenue: $${total.toFixed(2)} CAD\n` +
      `🏭 CT cost / warehouse / stock: <i>— placeholder, filled by a later PR</i>`
    );
  });

  return `${header}\n\n${blocks.join('\n\n─────────────\n\n')}`;
}

/**
 * Claim + alert on eligible orders, independent of everything else in the
 * run: called before acknowledge/sheet-log/cursor-advance, and a failure
 * here (claim error, send failure) never throws, so it can't break the sync
 * or block those later steps. A send failure releases its claims so the
 * order is retried on the next run instead of being marked alerted for a
 * message that never went out.
 *
 * Deliberately called with the FULL set of orders fetched this run — NOT
 * filtered against the Google Sheet. The Sheet answers "has this order been
 * processed" (dedupes acknowledge + Sheet-row-append, below); it must never
 * answer "has this order been alerted" — that question belongs to
 * walmart_order_alerts alone. An order that got Sheet-logged during a run
 * where alerting was suppressed or failed (the class of bug that
 * permanently orphaned PO 309121065891123 from ever alerting) still needs a
 * path to alert on a later run once it's no longer suppressed; gating this
 * call on Sheet-newness is exactly what closed off that path. Idempotency
 * against re-alerting the same order every run is entirely
 * claimOrderAlert()'s unique constraint on walmart_po (below) — not this
 * function's input set. This also matches the invariant sync-state.ts's
 * module header already documents: re-fetching the same window on every run
 * is safe specifically because "the Telegram alert itself is gated by
 * walmart_order_alerts' unique constraint... repeated fetches of the same
 * order produce exactly one alert, never zero and never more than one."
 *
 * Two independent filters gate eligibility, in this order:
 *
 * 1. Cancelled orders are never alerted — a seller-cancelled order needs no
 *    action and would be pure noise (2 of 6 orders in this account are
 *    fully seller-cancelled). See isFullyCancelled(). This is scoped to
 *    alerting only: cancelled orders still flow through acknowledge/Sheet
 *    logging below unchanged.
 *
 * 2. Backfill guard: the cutoff is resolved once per run by the handler
 *    (getOrInitAlertCutoffMs(), called unconditionally right after the
 *    order fetch — see below) and passed in here — only orders created
 *    after it are ever eligible to alert. A null cutoff (KV unavailable or
 *    resolution failed) means alert nothing this run, deliberately
 *    fail-closed rather than guessing a fallback window.
 */
async function alertOrders(orders: WalmartOrder[], cutoffMs: number | null): Promise<void> {
  const notCancelled = orders.filter((o) => !isFullyCancelled(o));
  if (notCancelled.length < orders.length) {
    console.log(
      `[order-sync] ${orders.length - notCancelled.length} order(s) fully cancelled — not alerted`
    );
  }
  if (notCancelled.length === 0) return;

  if (cutoffMs === null) {
    console.warn('[order-sync] alert cutoff unavailable this run — not alerting (fail closed)');
    return;
  }

  const eligible = notCancelled.filter((o) => o.orderDate > cutoffMs);
  if (eligible.length < notCancelled.length) {
    console.log(
      `[order-sync] ${notCancelled.length - eligible.length} order(s) at/before cutoff — not alerted (backfill guard)`
    );
  }
  if (eligible.length === 0) return;

  const claimed: WalmartOrder[] = [];
  for (const order of eligible) {
    try {
      const won = await claimOrderAlert(order.purchaseOrderId);
      if (won) {
        claimed.push(order);
      } else {
        console.log(`[order-sync] ${order.purchaseOrderId} already claimed for alert — skipping`);
      }
    } catch (err) {
      // Claim itself failed (e.g. Supabase unreachable) — do not alert, do
      // not throw. Nothing was claimed, so the next run retries cleanly.
      console.error(
        `[order-sync] claimOrderAlert(${order.purchaseOrderId}) failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  if (claimed.length === 0) return;

  const sent = await sendTelegramMessage(buildTelegramMessage(claimed));
  if (!sent) {
    console.error(
      `[order-sync] Telegram alert send failed for ${claimed.length} order(s) — releasing claims so they retry next run`
    );
    await Promise.all(claimed.map((o) => releaseOrderAlert(o.purchaseOrderId)));
    return;
  }
  console.log(`[order-sync] Telegram alert sent for ${claimed.length} order(s)`);
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  // Capture the cursor at the START of the run; we only persist it after a
  // clean completion so a failed pass self-heals on the next successful one.
  // The cursor itself is observability-only now — see fetchWindowStart below.
  const runStartedAt = new Date().toISOString();
  try {
    const token = await getWalmartToken();

    // The actual fetch bound: a fixed rolling lookback from "now" (default
    // 48h), NOT the sync cursor. A forward-only cursor window is what let two
    // live unshipped orders (PO 309120965612142, PO 309121065891123) become
    // permanently unreachable — see lib/sync-state.ts's module header.
    // retryWithBackoff retries transient failures (5xx/520/network) 2s/4s/8s
    // before giving up.
    const fetchWindowStart = getFetchWindowStart();
    const orders = await retryWithBackoff(() => fetchRecentOrders(token, fetchWindowStart), {
      label: 'fetchRecentOrders',
    });

    // Resolve (and, on the first run after deploy or a KV reset, bootstrap)
    // the alert backfill cutoff on EVERY invocation, regardless of whether
    // this run found any orders — deploy-time bootstrap, not lazily deferred
    // until a run happens to find one. Passing this run's order dates lets a
    // first-ever bootstrap set the cutoff just before the earliest of them,
    // so nothing already fetched this run gets retroactively suppressed by
    // the cutoff its own arrival just created. Logs the resolved value every
    // run either way (see getOrInitAlertCutoffMs) so its state is visible
    // without having to infer it from silence.
    const alertCutoffMs = await getOrInitAlertCutoffMs(orders.map((o) => o.orderDate));

    // Cursor read AFTER the fetch, purely for heartbeat/observability — it no
    // longer gates what was just fetched above.
    const since = await getSyncSince();

    // Runs on every invocation (all ~96/day), independent of everything
    // below — a broken alert or ack step must not suppress the one signal
    // that would show the sync itself has gone quiet. Never throws.
    await recordRunAndMaybeHeartbeat(orders.length, since, sendTelegramMessage);

    if (orders.length === 0) {
      // Nothing to process this run — still advance the observability cursor
      // so the heartbeat can tell a live-but-quiet sync from a stuck one.
      await setSyncSuccess(runStartedAt);
      console.log('[order-sync] No orders in fetch window');
      return res.status(200).json({ message: 'No new orders', processed: 0 });
    }

    // Sheet lookup — used for two DIFFERENT, now-decoupled purposes below:
    // (a) reconciliation logging (every fetched order), (b) gating
    // acknowledge/Sheet-row-append (Sheet-new orders only). It does NOT gate
    // alerting — see alertOrders()'s docstring for why.
    const existingIds = await getSheetOrderIds(SHEET_ID);

    // Reconciliation: log sheet/ledger/cutoff/cancelled state for every
    // order fetched this run, independent of what gates alerting or
    // Sheet-logging below — so state is externally verifiable from the log
    // line itself instead of inferred from an aggregate message like "All
    // orders already processed" (which conflated "in the Sheet" with
    // "alerted" and is exactly how PO 309121065891123 stayed silently
    // orphaned). isOrderAlerted() here is read-only observability, never
    // used to gate the actual alert decision — that stays with
    // claimOrderAlert()'s atomic INSERT inside alertOrders() below.
    for (const order of orders) {
      const sheetPresent = existingIds.has(order.purchaseOrderId);
      const cancelled = isFullyCancelled(order);
      const cutoffEligible = alertCutoffMs !== null && order.orderDate > alertCutoffMs;
      let ledgerPresent: string;
      try {
        ledgerPresent = (await isOrderAlerted(order.purchaseOrderId)) ? 'yes' : 'no';
      } catch (err) {
        ledgerPresent = `unknown (${err instanceof Error ? err.message : String(err)})`;
      }
      console.log(
        `[order-sync] reconcile PO=${order.purchaseOrderId} ` +
        `sheet=${sheetPresent ? 'yes' : 'no'} ledger=${ledgerPresent} ` +
        `cancelled=${cancelled ? 'yes' : 'no'} cutoff-eligible=${cutoffEligible ? 'yes' : 'no'}`
      );
    }

    // 1. Alert every fetched order eligible per alertOrders()'s own filters
    //    (cancelled + cutoff) and claimOrderAlert()'s unique constraint —
    //    NOT gated by Sheet presence, so an order already Sheet-logged from
    //    an earlier suppressed/failed attempt still gets a chance here.
    //    Fires before acknowledge/sheet log so it reaches the team even if
    //    any downstream step fails. A send failure releases its claims so
    //    it's retried, not permanently marked alerted. Never throws.
    await alertOrders(orders, alertCutoffMs);

    // Sheet dedup — decoupled from alerting above. Only gates duplicate
    // acknowledge calls and duplicate Sheet rows; see reconcile log lines
    // above for per-order alert state.
    const newOrders = orders.filter((o) => !existingIds.has(o.purchaseOrderId));

    if (newOrders.length === 0) {
      // Every fetched order already has a Sheet row — nothing left to
      // acknowledge or log. Says nothing about whether any of them alerted.
      await setSyncSuccess(runStartedAt);
      console.log('[order-sync] All orders already in sheet — nothing to acknowledge/log this run');
      return res.status(200).json({ message: 'All orders already logged', processed: 0 });
    }

    console.log(`[order-sync] ${newOrders.length} order(s) new to the sheet — acknowledging + logging`);

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

    // 5. Clean completion — advance the observability cursor. Persisting at
    //    runStartedAt (not now) is harmless belt-and-braces consistency with
    //    the other call sites now that the cursor no longer bounds a fetch.
    await setSyncSuccess(runStartedAt);

    return res.status(200).json({
      newOrders: newOrders.length,
      acknowledged: ackedIds.size,
      rowsLogged: rows.length,
    });
  } catch (err: any) {
    console.error('[order-sync] Error:', err);
    // Alert on Telegram so you know the cron is broken
    await sendTelegramMessage(`⚠️ <b>walmart-order-sync ERROR</b>\n${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

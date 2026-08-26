import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client.js';
import { getSheetOrderIds, appendSheetRows } from './lib/sheets-client.js';
import { HttpError, retryWithBackoff } from './lib/retry.js';
import { getFetchWindowStart, getSyncSince, setSyncSuccess } from './lib/sync-state.js';
import { sendTelegramMessage } from './lib/telegram.js';
import { claimOrderAlert, releaseOrderAlert, getOrInitAlertCutoffMs, isOrderAlerted } from './lib/walmart-order-alerts.js';
import { recordRunAndMaybeHeartbeat } from './lib/sync-heartbeat.js';
import { mirrorWalmartOrderToShopify } from './lib/walmart-shopify-mirror.js';
import { routeOrderToCT } from './lib/ct-order-routing.js';
import { CT_AUTO_PO_ENABLED, normalizePartNumber } from './lib/ct-client.js';

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

  const sent = await sendTelegramMessage(buildTelegramMessage(claimed), 'actionable');
  if (!sent) {
    console.error(
      `[order-sync] Telegram alert send failed for ${claimed.length} order(s) — releasing claims so they retry next run`
    );
    await Promise.all(claimed.map((o) => releaseOrderAlert(o.purchaseOrderId)));
    return;
  }
  console.log(`[order-sync] Telegram alert sent for ${claimed.length} order(s)`);
}

// ── CT routing after a successful mirror ─────────────────────────────────
//
// Extracted verbatim from the handler's per-order loop so it's callable (and
// stubbable) in isolation — see api/tests/walmart-order-sync.unit.test.ts.
// `routeFn` defaults to the real routeOrderToCT() import; only tests pass a
// stub. `ctAutoPoEnabled` defaults to the real CT_AUTO_PO_ENABLED constant;
// only tests pass an explicit override. Neither default changes any real
// caller's behavior — the handler below calls this with no `opts`, so
// production behavior is byte-for-byte the same as the inline block it
// replaced.
//
// Only when CT_AUTO_PO_ENABLED (same gate api/order-router.ts already reads
// for the Shopify path; not modified here). routeOrderToCT() itself
// (api/lib/ct-order-routing.ts, PR #65) is not modified by this change —
// called exactly as documented there. Any outcome other than 'submitted' is
// logged; routeOrderToCT() sends its own Telegram alert per outcome (see
// ct-order-routing.ts) and never throws for expected outcomes, so a CT
// routing problem here never blocks the Sheet log that follows in the
// handler, which reflects the mirror having already succeeded.
export async function maybeRouteToCT(
  order: WalmartOrder,
  shopifyOrderId: string,
  shopifyOrderNumber: string,
  opts: { ctAutoPoEnabled?: boolean; routeFn?: typeof routeOrderToCT } = {},
): Promise<void> {
  const ctAutoPoEnabled = opts.ctAutoPoEnabled ?? CT_AUTO_PO_ENABLED;
  if (!ctAutoPoEnabled) return;
  const routeFn = opts.routeFn ?? routeOrderToCT;

  try {
    const walmartLines = order.orderLines?.orderLine ?? [];
    const ctOutcome = await routeFn({
      channel:           'walmart',
      // Ledger keys on the Shopify order id for BOTH channels — see
      // CT-INTEGRATION-CONTEXT.md §7 ("Shopify is the hub"). The Walmart
      // PO# rides along as meta below, not as the ledger key.
      sourceOrderId:     shopifyOrderId,
      sourceOrderNumber: shopifyOrderNumber,
      lineItems: walmartLines.map((line) => ({
        sku:      normalizePartNumber(line.item.sku),
        quantity: parseInt(line.orderLineQuantity?.amount ?? '1', 10) || 1,
      })),
      shipTo: {
        name:       order.shippingInfo.postalAddress.name,
        address1:   order.shippingInfo.postalAddress.address1,
        address2:   order.shippingInfo.postalAddress.address2,
        city:       order.shippingInfo.postalAddress.city,
        province:   order.shippingInfo.postalAddress.state,
        postalCode: order.shippingInfo.postalAddress.postalCode,
        country:    order.shippingInfo.postalAddress.country,
        // phone unavailable from this repo's WalmartOrder type — see
        // api/lib/walmart-shopify-mirror.ts's module header.
      },
      // Walmart marketplace orders never carry installer metadata — that
      // only exists on Shopify orders via note_attributes set by GCI's own
      // checkout/app flow.
      shipToInstaller: false,
      meta: {
        walmartPoNumber:             order.purchaseOrderId,
        walmartOrderNumber:          order.customerOrderId,
        resultingShopifyOrderNumber: shopifyOrderNumber,
        // Matches column A in the Walmart order-log Sheet — drives
        // ct-order-routing.ts's column-N CT-PO-number write on a confirmed
        // submission.
        walmartSheetOrderId:         order.purchaseOrderId,
        shipByDate:                  formatWalmartDate(order.shippingInfo?.estimatedShipDate),
        deliverByDate:               formatWalmartDate(order.shippingInfo?.estimatedDeliveryDate),
        revenue:                     walmartLines.reduce((sum, l) => sum + getLinePrice(l), 0),
      },
      // tags intentionally omitted: this call fires synchronously, in-process,
      // immediately after the Shopify order was just created by the mirror —
      // a human can't have tagged it 'po-drafted' yet (see
      // ct-order-routing.ts's PO_DRAFTED_TAG guard and CT-INTEGRATION-
      // CONTEXT.md §12). If this function is ever called again later for the
      // same order (e.g. a future retry/backfill path), that caller MUST
      // fetch and pass current Shopify tags — do not copy this omission.
    });
    console.log(`[order-sync] CT routing for ${order.purchaseOrderId} (Shopify ${shopifyOrderNumber}): ${ctOutcome.kind}`);
  } catch (err: any) {
    console.error(`[order-sync] CT routing threw for ${order.purchaseOrderId}, Shopify ${shopifyOrderNumber} still mirrored:`, err);
    // Deliberately not re-thrown — the mirror already succeeded and is
    // Sheet-logged by the caller regardless of CT routing's outcome.
  }
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

    // Sheet lookup — used for three purposes below: (a) the heartbeat count
    // just after this (b) reconciliation logging (every fetched order), (c)
    // gating acknowledge/Sheet-row-append (Sheet-new orders only). It does
    // NOT gate alerting — see alertOrders()'s docstring for why. Skipped
    // entirely when there are no orders to dedupe, so an empty-window run
    // (~95 of 96/day) still costs zero Sheet API calls, same as before.
    const existingIds = orders.length > 0 ? await getSheetOrderIds(SHEET_ID) : new Set<string>();
    const newOrders = orders.filter((o) => !existingIds.has(o.purchaseOrderId));

    // Runs on every invocation (all ~96/day), independent of the
    // alert/ack/mirror/CT-routing steps below — a broken one of those must
    // not suppress the one signal that would show the sync itself has gone
    // quiet. Never throws. Routed to the INFO channel — a periodic summary,
    // not a per-order action item.
    //
    // Counts newOrders (post-Sheet-dedup), NOT the raw Walmart fetch count —
    // this now depends on the Sheet lookup above succeeding, which is a
    // narrower guarantee than before (previously this ran before ANY
    // downstream call, including the Sheet lookup, so a broken Sheet
    // integration could never suppress it). A Sheet-lookup failure here
    // throws up to the handler's outer catch, which still sends its own
    // "walmart-order-sync ERROR" Telegram alert (see bottom of this
    // function) — so a Sheet outage isn't silent, it just surfaces as that
    // alert instead of a missing heartbeat count for this run. If a
    // Sheet-independent "did the Walmart API respond at all" signal is
    // still wanted alongside this one, that's a second, separate counter —
    // not implemented here.
    await recordRunAndMaybeHeartbeat(newOrders.length, since, (text) => sendTelegramMessage(text, 'info'));

    if (orders.length === 0) {
      // Nothing to process this run — still advance the observability cursor
      // so the heartbeat can tell a live-but-quiet sync from a stuck one.
      await setSyncSuccess(runStartedAt);
      console.log('[order-sync] No orders in fetch window');
      return res.status(200).json({ message: 'No new orders', processed: 0 });
    }

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

    // newOrders (Sheet dedup, decoupled from alerting above) was already
    // computed above, alongside existingIds, for the heartbeat call. Only
    // gates duplicate acknowledge calls and duplicate Sheet rows; see
    // reconcile log lines above for per-order alert state.
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

      // 2.5 Mirror into Shopify. ALWAYS attempted — independent of
      //     CT_AUTO_PO_ENABLED, per CT-INTEGRATION-CONTEXT.md §7's "Mirror
      //     into Shopify is CRITICAL PATH" decision, which is not
      //     conditioned on whether CT auto-submission is on. A Walmart
      //     order is already sold/paid via the marketplace — the mirrored
      //     order is created already financial_status: 'paid', never
      //     pushed through a live checkout. See
      //     api/lib/walmart-shopify-mirror.ts for the idempotency
      //     guarantee (one Shopify order per Walmart PO, independent of
      //     and in addition to ct_orders below) and the field-mapping
      //     gaps it documents rather than guessing.
      //
      //     A failed/indeterminate mirror alerts loudly and this order's
      //     Sheet row(s) are deliberately not appended below (the `continue`
      //     skips straight to the next order) — leaving it out of the Sheet
      //     means existingIds won't contain it on the next run, so this
      //     whole block (re-ack + re-mirror attempt) retries, matching the
      //     same documented "leave the order unmarked so the next cron run
      //     retries" decision.
      let mirrorOutcome;
      try {
        mirrorOutcome = await mirrorWalmartOrderToShopify(order);
      } catch (err: any) {
        console.error(`[order-sync] mirror threw for ${order.purchaseOrderId}:`, err);
        mirrorOutcome = { kind: 'failed' as const, reason: err instanceof Error ? err.message : String(err) };
      }

      if (mirrorOutcome.kind !== 'mirrored') {
        console.error(`[order-sync] mirror NOT completed for ${order.purchaseOrderId} (${mirrorOutcome.kind}): ${mirrorOutcome.reason}`);
        await sendTelegramMessage(
          `🚨 <b>Walmart order NOT mirrored to Shopify</b>\n` +
          `PO <code>${order.purchaseOrderId}</code>\n` +
          `Outcome: ${mirrorOutcome.kind} — ${mirrorOutcome.reason}\n` +
          (mirrorOutcome.kind === 'indeterminate_unresolved'
            ? '⚠️ A human must check Shopify (tag "gci-walmart-mirror" + this PO# in the order note) before this retries automatically.'
            : 'Left unmarked in the Sheet — next cron run will retry.'),
          'actionable',
        );
        continue;
      }

      const { shopifyOrderId, shopifyOrderNumber } = mirrorOutcome;
      console.log(
        `[order-sync] ${order.purchaseOrderId} mirrored → Shopify ${shopifyOrderNumber}` +
        (mirrorOutcome.freshlyCreated ? '' : ' (already existed — not re-created)')
      );

      // 2.6 Route to Canada Tire — only when CT_AUTO_PO_ENABLED. Extracted
      //     to maybeRouteToCT() above (real args, real defaults — this call
      //     is behaviorally identical to the inline block it replaced) so
      //     the gate can be tested in isolation; see
      //     api/tests/walmart-order-sync.unit.test.ts.
      await maybeRouteToCT(order, shopifyOrderId, shopifyOrderNumber);

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
          `Shopify ${shopifyOrderNumber}`, // notes
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
    // Alert on Telegram so you know the cron is broken. Routed ACTIONABLE
    // (not in the original bucket list — a crashed sync needs the same
    // attention as a health-check-make failure, so treated the same way).
    await sendTelegramMessage(`⚠️ <b>walmart-order-sync ERROR</b>\n${err.message}`, 'actionable');
    return res.status(500).json({ error: err.message });
  }
}

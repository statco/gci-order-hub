// api/admin-alert-order.ts
// ─────────────────────────────────────────────────────────────
// POST /api/admin-alert-order?po=<walmartPurchaseOrderId>
// Authorization: Bearer <CRON_SECRET>
//
// One-off manual trigger for the "new Walmart order" Telegram alert
// (walmart-order-sync.ts's alertNewOrders()), scoped to a single named PO.
//
// WHY THIS EXISTS: getOrInitAlertCutoffMs() (lib/walmart-order-alerts.ts)
// bootstraps to "now" the first time the sync runs after a deploy and never
// alerts on anything created before that moment — by design, so a fresh
// deploy doesn't dump a backlog of alerts. That guard is correct, but it
// means any order that happened to land in the gap before a bootstrap (e.g.
// PO 309120965612142, order date 2026-07-27, ~24h before the cutoff
// bootstrapped 2026-07-28) will NEVER alert automatically — not a bug, just
// something a human has to do once per affected order. This endpoint is
// that "once", made repeatable and safe instead of a raw manual Telegram
// message: reuses claimOrderAlert()'s ledger (walmart_order_alerts, unique
// on walmart_po) so calling this twice for the same PO is a no-op the
// second time, and reuses isFullyCancelled()/buildTelegramMessage() from
// walmart-order-sync.ts so the message is byte-identical in shape to what
// the automated path would have sent — no separately-maintained formatting
// to drift out of sync.
//
// Deliberately does NOT touch getOrInitAlertCutoffMs() or the cutoff value
// itself — the guard stays exactly as strict for every order this endpoint
// is never called for. This is a narrow, explicit, per-PO escape valve, not
// a way to widen the guard.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client.js';
import { sendTelegramMessage } from './lib/telegram.js';
import { claimOrderAlert, releaseOrderAlert } from './lib/walmart-order-alerts.js';
import {
  walmartHeaders,
  isFullyCancelled,
  buildTelegramMessage,
  type WalmartOrder,
} from './walmart-order-sync.js';

export const config = { maxDuration: 30 };

const WALMART_BASE_URL = process.env.WALMART_BASE_URL!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed — POST only' });

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });

  const po = (req.query.po as string || '').trim();
  if (!po) return res.status(400).json({ error: 'po query param required (Walmart purchaseOrderId)' });

  try {
    const token = await getWalmartToken();
    const r = await fetch(`${WALMART_BASE_URL}/v3/orders/${encodeURIComponent(po)}`, {
      headers: walmartHeaders(token),
    });
    if (!r.ok) {
      return res.status(502).json({ error: `Walmart order fetch failed: ${r.status} ${await r.text()}` });
    }
    const data = await r.json();
    const order = data?.order as WalmartOrder | undefined;
    if (!order?.purchaseOrderId) {
      return res.status(404).json({ error: `Order ${po} not found`, raw: data });
    }

    if (isFullyCancelled(order)) {
      return res.status(400).json({ message: `PO ${po} is fully cancelled — not alerting`, po });
    }

    const claimed = await claimOrderAlert(order.purchaseOrderId);
    if (!claimed) {
      return res.status(200).json({ message: `PO ${po} was already claimed for alert — no-op`, po, alerted: false });
    }

    const sent = await sendTelegramMessage(buildTelegramMessage([order]));
    if (!sent) {
      await releaseOrderAlert(order.purchaseOrderId);
      return res.status(502).json({ error: `Telegram send failed for PO ${po} — claim released, safe to retry`, po });
    }

    console.log(`[admin-alert-order] Manually alerted PO ${po}`);
    return res.status(200).json({ message: `Alerted PO ${po}`, po, alerted: true });
  } catch (err: any) {
    console.error('[admin-alert-order] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

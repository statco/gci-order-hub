// api/admin-set-alert-cutoff.ts
// ─────────────────────────────────────────────────────────────
// POST /api/admin-set-alert-cutoff?value=<ISO8601>
// Authorization: Bearer <CRON_SECRET>
//
// One-off admin endpoint to directly write the walmart-order-alerts backfill
// cutoff in KV (key: walmart-order-alerts:cutoffMs, see
// lib/walmart-order-alerts.ts). getOrInitAlertCutoffMs() never bootstrapped
// at the PR #49 deploy (no run found an order until the status=Created
// filter was removed in PR #50), so it lazily bootstrapped on the first run
// that found one and immediately suppressed that same order as
// pre-cutoff. This resets the cutoff to what the PR #49 deploy-ready time
// should have produced.
//
// Mirrors the existing admin-alert-order.ts escape-valve pattern. Reuses the
// same kvGet/kvSet request shape as lib/walmart-order-alerts.ts (GET for
// read, POST-with-raw-body for write) so it talks to the identical KV
// instance the alert path reads from. Does NOT touch alert or heartbeat
// logic — writes only the cutoff timestamp.
//
// This is a temporary, narrowly-scoped data-fix tool, not a permanent
// feature; expected to be removed once the cutoff has been reset.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 15 };

const CUTOFF_KEY = 'walmart-order-alerts:cutoffMs';
const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

async function kvGet(key: string): Promise<string | null> {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV get failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  return data?.result == null ? null : String(data.result);
}

async function kvSet(key: string, value: string): Promise<void> {
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: value,
  });
  if (!res.ok) throw new Error(`KV set failed: ${res.status} ${await res.text()}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — GET or POST only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  const authHeader = req.headers['authorization'];
  const secretParam = req.query.secret as string | undefined;
  const authorized = authHeader === `Bearer ${cronSecret}` || secretParam === cronSecret;
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV not configured' });

  const value = (req.query.value as string || '').trim();
  if (!value) return res.status(400).json({ error: 'value query param required (ISO 8601 timestamp)' });
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return res.status(400).json({ error: `Could not parse "${value}" as a timestamp` });

  try {
    const before = await kvGet(CUTOFF_KEY);
    await kvSet(CUTOFF_KEY, String(ms));
    const after = await kvGet(CUTOFF_KEY);
    console.log(`[admin-set-alert-cutoff] ${CUTOFF_KEY}: ${before} -> ${after} (requested ${value} = ${ms}ms)`);
    return res.status(200).json({
      key: CUTOFF_KEY,
      before,
      beforeIso: before ? new Date(Number(before)).toISOString() : null,
      after,
      afterIso: new Date(ms).toISOString(),
    });
  } catch (err: any) {
    console.error('[admin-set-alert-cutoff] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

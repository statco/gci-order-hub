// api/lib/sync-state.ts
// ─────────────────────────────────────────────────────────────
// Two independent things for walmart-order-sync, deliberately decoupled:
//
// 1. getFetchWindowStart() — the createdStartDate actually sent to Walmart's
//    /v3/orders. A fixed rolling lookback (ORDER_SYNC_FETCH_LOOKBACK_HOURS,
//    default 48h) measured from "now" on every run. No KV, no cursor: a
//    forward-only cursor window is exactly the bug this replaces — two live
//    unshipped orders (PO 309120965612142, PO 309121065891123) fell outside
//    every ~15-minute cursor-bound window and could never be seen again, even
//    after PR #50 removed the client-side status filter. Re-fetching the same
//    48h window on every run is safe because downstream processing is fully
//    idempotent: orders are deduped against the Google Sheet before any
//    alert/acknowledge/log step, and the Telegram alert itself is gated by
//    walmart_order_alerts' unique constraint on walmart_po (insert-before-send,
//    ON CONFLICT DO NOTHING) — repeated fetches of the same order produce
//    exactly one alert, never zero and never more than one.
//
// 2. getSyncSince() / setSyncSuccess() — the "last successful sync" cursor.
//    Kept for heartbeat reporting and observability ONLY (a stuck or
//    non-advancing cursor is a useful signal that the sync itself is broken)
//    — it no longer bounds what gets fetched.
//
// Primary store: Vercel KV (Upstash Redis) via its REST API, used when
// KV_REST_API_URL + KV_REST_API_TOKEN are present. We talk to it with plain
// `fetch` (no @vercel/kv npm dependency) to keep the bundle lean and avoid
// the ESM/CJS pitfalls noted in the project context.
//
// Fallback: when KV is not configured, getSyncSince() degrades to a fixed
// trailing look-back window (ORDER_SYNC_LOOKBACK_HOURS, default 24h) purely
// for its own reporting purposes — it has no effect on what gets fetched
// either way now.
// ─────────────────────────────────────────────────────────────

const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const KEY = 'walmart-order-sync:lastSuccessfulSyncTimestamp';

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK_HOURS = parseInt(process.env.ORDER_SYNC_LOOKBACK_HOURS || '24', 10) || 24;
// Cap how far back the cursor is ever reported as catching up from, purely
// for the heartbeat's benefit — an outage lasting longer than this reports
// as MAX_LOOKBACK_HOURS-stale rather than growing unbounded.
const MAX_LOOKBACK_HOURS =
  parseInt(process.env.ORDER_SYNC_MAX_LOOKBACK_HOURS || '168', 10) || 168; // 7 days

// The window actually sent to Walmart as createdStartDate. Default 48h:
// generous enough to survive a multi-hour outage without operator action
// (the cron runs every 15 min — a 48h window tolerates ~192 consecutive
// missed runs before an order could fall out of range), while still small
// relative to Walmart's 200-orders-per-page cap at this account's documented
// volume (~3 orders/week — see lib/sync-heartbeat.ts) with wide margin.
const FETCH_LOOKBACK_HOURS =
  parseInt(process.env.ORDER_SYNC_FETCH_LOOKBACK_HOURS || '48', 10) || 48;

/**
 * ISO timestamp to use as `createdStartDate` for this run: now minus a fixed
 * rolling lookback (ORDER_SYNC_FETCH_LOOKBACK_HOURS, default 48h). Does not
 * touch KV or the cursor — see the module header for why a forward-only
 * cursor window is unsafe here and a rolling window is not.
 */
export function getFetchWindowStart(): string {
  return new Date(Date.now() - FETCH_LOOKBACK_HOURS * HOUR_MS).toISOString();
}

export function kvAvailable(): boolean {
  return Boolean(KV_URL && KV_TOKEN);
}

async function kvGet(key: string): Promise<string | null> {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV get failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const result = data?.result;
  return result == null ? null : String(result);
}

async function kvSet(key: string, value: string): Promise<void> {
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: value,
  });
  if (!res.ok) throw new Error(`KV set failed: ${res.status} ${await res.text()}`);
}

/**
 * The "last successful sync" cursor value, for heartbeat reporting and
 * observability ONLY — see the module header. Does NOT bound what gets
 * fetched from Walmart; use getFetchWindowStart() for that.
 * = last successful sync (capped to MAX_LOOKBACK_HOURS), or a fixed
 * look-back window when no persisted cursor exists / KV is unavailable.
 */
export async function getSyncSince(): Promise<string> {
  const now = Date.now();
  const windowStart = new Date(now - LOOKBACK_HOURS * HOUR_MS).toISOString();

  if (!kvAvailable()) {
    console.log(`[sync-state] KV not configured — using ${LOOKBACK_HOURS}h look-back window`);
    return windowStart;
  }

  try {
    const stored = await kvGet(KEY);
    if (!stored) {
      console.log('[sync-state] no stored cursor — using look-back window');
      return windowStart;
    }
    const storedMs = new Date(stored).getTime();
    if (Number.isNaN(storedMs)) {
      console.warn(`[sync-state] stored cursor not a date (${stored}) — using look-back window`);
      return windowStart;
    }
    const earliest = now - MAX_LOOKBACK_HOURS * HOUR_MS;
    const sinceMs = Math.max(storedMs, earliest);
    const since = new Date(sinceMs).toISOString();
    console.log(`[sync-state] catching up from last successful sync: ${since}`);
    return since;
  } catch (err) {
    console.warn(
      '[sync-state] KV read failed — using look-back window:',
      err instanceof Error ? err.message : String(err),
    );
    return windowStart;
  }
}

/**
 * Advance the cursor after a clean run. Pass the timestamp captured at the
 * START of the run (not "now"), so orders created mid-run are still picked up
 * on the next pass. Never throws: a failed persist is non-fatal because the
 * Sheet-based dedup prevents duplicate processing on re-scan.
 */
export async function setSyncSuccess(timestampIso: string): Promise<void> {
  if (!kvAvailable()) {
    console.log('[sync-state] KV not configured — cursor not persisted (look-back mode)');
    return;
  }
  try {
    await kvSet(KEY, timestampIso);
    console.log(`[sync-state] cursor advanced to ${timestampIso}`);
  } catch (err) {
    console.warn(
      '[sync-state] failed to persist cursor (will re-scan window next run):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

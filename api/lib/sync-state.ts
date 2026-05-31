// api/lib/sync-state.ts
// ─────────────────────────────────────────────────────────────
// Catch-up cursor for walmart-order-sync.
//
// On each run we want to fetch Walmart orders created since the LAST
// SUCCESSFUL sync — not since the last run. A failed pass therefore
// self-heals on the next successful one: the cursor only advances after a
// clean completion.
//
// Primary store: Vercel KV (Upstash Redis) via its REST API, used when
// KV_REST_API_URL + KV_REST_API_TOKEN are present. We talk to it with plain
// `fetch` (no @vercel/kv npm dependency) to keep the bundle lean and avoid
// the ESM/CJS pitfalls noted in the project context.
//
// Fallback: when KV is not configured we degrade to a fixed trailing
// look-back window (ORDER_SYNC_LOOKBACK_HOURS, default 24h). In that mode the
// cursor cannot persist, so each run simply re-scans the window — still safe
// because downstream processing is idempotent (orders are deduped against the
// Google Sheet before any alert / acknowledge / log).
// ─────────────────────────────────────────────────────────────

const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const KEY = 'walmart-order-sync:lastSuccessfulSyncTimestamp';

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK_HOURS = parseInt(process.env.ORDER_SYNC_LOOKBACK_HOURS || '24', 10) || 24;
// Cap how far back we ever scan so a long outage can't trigger an unbounded
// back-fill (Walmart /v3/orders is paginated at 200/page).
const MAX_LOOKBACK_HOURS =
  parseInt(process.env.ORDER_SYNC_MAX_LOOKBACK_HOURS || '168', 10) || 168; // 7 days

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
 * ISO timestamp to use as `createdStartDate` for this run.
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

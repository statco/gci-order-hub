// api/lib/walmart-order-alerts.ts
// ─────────────────────────────────────────────────────────────
// Per-PO claim table gating the "new Walmart order" Telegram alert.
//
// walmart-order-sync.ts has no per-order tracking of its own — it uses a
// time cursor (lib/sync-state.ts) to decide what window to fetch, and a
// separate Google Sheet dedup (lib/sheets-client.ts) that is check-then-act
// (read once at the top of a run, append at the end) and does not guarantee
// exactly-once behavior across overlapping 15-min cron runs.
//
// claimOrderAlert() is a plain INSERT ... ON CONFLICT DO NOTHING against a
// unique primary key: the claim is an insert that fails, not a select that
// races, so it is safe under overlapping runs. releaseOrderAlert() undoes a
// claim when the send that followed it failed, so a real send failure stays
// retryable on the next run rather than being permanently marked "alerted".
//
// Deliberately NOT part of api/lib/supabase.ts (that file is scoped to the
// single-row walmart_sync_cursor table) and does NOT touch ct_orders
// (CT submissions only) or walmart_orders (multi-tenant, gci-walmart-sync).
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL     = process.env.SUPABASE_URL             ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function requireEnv(): void {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }
}

/**
 * Attempt to claim a Walmart PO for alerting.
 * Returns true iff this call inserted the row (i.e. this run owns the
 * alert). Returns false if the PO was already claimed — by this run's own
 * earlier attempt, a previous run, or an overlapping concurrent run.
 */
export async function claimOrderAlert(walmartPo: string): Promise<boolean> {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/walmart_order_alerts`, {
    method: 'POST',
    headers: {
      'apikey':        SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json',
      // resolution=ignore-duplicates -> ON CONFLICT DO NOTHING.
      // return=representation so an empty array tells us the insert affected
      // no row (already claimed), vs a populated array on real insert.
      'Prefer':        'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify({ walmart_po: walmartPo }),
  });

  if (!res.ok) {
    throw new Error(
      `Supabase POST walmart_order_alerts → ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }

  const rows: unknown[] = await res.json();
  return rows.length > 0;
}

/**
 * Undo a claim after the alert send that followed it failed. Leaves the PO
 * retryable on the next run instead of permanently marked "alerted" for a
 * message that never actually went out.
 *
 * Never throws — this already runs inside a failure path; a second failure
 * here must not mask the first or abort the sync. Worst case (release fails
 * after a send failure) is a rare skipped alert, not a broken cron run.
 */
export async function releaseOrderAlert(walmartPo: string): Promise<void> {
  try {
    requireEnv();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/walmart_order_alerts?walmart_po=eq.${encodeURIComponent(walmartPo)}`,
      {
        method: 'DELETE',
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      console.warn(
        `[walmart-order-alerts] release ${walmartPo} → ${res.status}: ${(await res.text()).slice(0, 200)}`
      );
    }
  } catch (err) {
    console.warn(
      `[walmart-order-alerts] release ${walmartPo} threw:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ── Deploy-time backfill cutoff ───────────────────────────────────────────
//
// Self-bootstrapping: no env var to set by hand. The first time this code
// runs after deploy (no cutoff yet persisted in KV), "now" is written and
// used as the cutoff for that same run. Every run after that reads the same
// persisted value forever — it's a one-time "since deploy" boundary, not a
// rolling window. At ~3 orders/week there's no meaningful backlog to guard
// against, so bootstrapping to first-run time (rather than requiring an
// exact deploy timestamp) is close enough in practice: worst case is the
// handful of orders created in the gap between deploy and the next 15-min
// cron tick, which is the same order of magnitude as the polling interval
// itself already tolerates.
//
// Uses the same Vercel KV (Upstash) instance as lib/sync-state.ts and
// lib/sync-heartbeat.ts, via its own small client — this repo's existing
// convention (each of those two files also has its own kvGet/kvSet) rather
// than a shared abstraction introduced as a drive-by refactor here.

const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const CUTOFF_KEY = 'walmart-order-alerts:cutoffMs';

function kvAvailable(): boolean {
  return Boolean(KV_URL && KV_TOKEN);
}

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

/**
 * Returns the epoch-ms cutoff below which orders are never alerted,
 * bootstrapping it to "now" on first call if none is persisted yet. Returns
 * null (fail closed — alert nothing) if KV is unavailable or the bootstrap
 * itself fails, so a KV outage can't accidentally alert the whole backlog.
 */
export async function getOrInitAlertCutoffMs(): Promise<number | null> {
  if (!kvAvailable()) {
    console.warn('[walmart-order-alerts] KV not configured — cannot bootstrap cutoff, alerting nothing this run');
    return null;
  }
  try {
    const stored = await kvGet(CUTOFF_KEY);
    if (stored) {
      const ms = Number(stored);
      if (Number.isFinite(ms)) return ms;
      console.warn(`[walmart-order-alerts] stored cutoff not a number (${stored}) — re-bootstrapping`);
    }
    const now = Date.now();
    await kvSet(CUTOFF_KEY, String(now));
    console.log(`[walmart-order-alerts] cutoff bootstrapped at ${new Date(now).toISOString()}`);
    return now;
  } catch (err) {
    console.error(
      '[walmart-order-alerts] cutoff bootstrap failed — alerting nothing this run:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

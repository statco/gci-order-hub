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
// Self-bootstrapping: no env var to set by hand. Called unconditionally on
// every invocation of the sync (see walmart-order-sync.ts's handler), right
// after the order fetch and before any dedup/filtering — not lazily deferred
// until a run happens to find an order. The first call after deploy (or
// after any KV reset/outage/migration wipes the stored value) bootstraps it;
// every call after that reads the same persisted value forever. It's a
// one-time "since deploy" boundary, not a rolling window.
//
// Bootstrapping used to write Date.now() as the cutoff. That's wrong: orders
// already exist by the time this code runs, so their orderDate is always
// <= "now", meaning the very order(s) present in the bootstrapping run would
// be immediately excluded by the cutoff their own arrival just created. This
// bit the very first real alert on 2026-07-29 (see the incident writeup in
// gci-order-hub's history). Fixed by taking the candidate orders from the
// triggering run and, when bootstrapping, setting the cutoff to just before
// the earliest of them — so everything already in hand this run passes
// `orderDate > cutoff`, and only orders older than the whole run's fetch
// window remain excluded. Falls back to Date.now() only when the run found
// no orders at all (nothing to protect from suppression).
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
 * bootstrapping it if none is persisted yet. Call unconditionally on every
 * run (not only when orders are present) so the cutoff is established at
 * deploy time rather than lazily on the first order-bearing run.
 *
 * `candidateOrderDatesMs` should be the orderDate (epoch ms) of every order
 * fetched in the calling run, even ones later filtered out downstream (e.g.
 * already logged, cancelled) — pass `[]` when the run found no orders. On
 * bootstrap, if there are candidates, the cutoff is set to just before the
 * earliest one so nothing already fetched this run is retroactively
 * suppressed by the cutoff its own arrival just created; with no candidates
 * it falls back to Date.now() (nothing to protect from suppression).
 *
 * Returns null (fail closed — alert nothing) if KV is unavailable or
 * resolution otherwise fails, so a KV outage can't accidentally alert the
 * whole backlog once it recovers.
 */
export async function getOrInitAlertCutoffMs(candidateOrderDatesMs: number[] = []): Promise<number | null> {
  if (!kvAvailable()) {
    console.warn('[walmart-order-alerts] KV not configured — cannot resolve cutoff, alerting nothing this run');
    return null;
  }
  try {
    const stored = await kvGet(CUTOFF_KEY);
    if (stored) {
      const ms = Number(stored);
      if (Number.isFinite(ms)) {
        console.log(`[walmart-order-alerts] cutoff: ${new Date(ms).toISOString()} (${ms}ms)`);
        return ms;
      }
      console.warn(`[walmart-order-alerts] stored cutoff not a number (${stored}) — re-bootstrapping`);
    }
    const bootstrapMs = candidateOrderDatesMs.length > 0
      ? Math.min(...candidateOrderDatesMs) - 1
      : Date.now();
    await kvSet(CUTOFF_KEY, String(bootstrapMs));
    console.log(
      `[walmart-order-alerts] cutoff bootstrapped at ${new Date(bootstrapMs).toISOString()} ` +
      (candidateOrderDatesMs.length > 0
        ? `(1ms before the earliest of ${candidateOrderDatesMs.length} order(s) already fetched this run)`
        : `(no orders fetched this run — using now)`)
    );
    return bootstrapMs;
  } catch (err) {
    console.error(
      '[walmart-order-alerts] cutoff resolution failed — alerting nothing this run:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

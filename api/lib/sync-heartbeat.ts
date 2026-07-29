// api/lib/sync-heartbeat.ts
// ─────────────────────────────────────────────────────────────
// Once-daily "is this cron actually alive" summary for walmart-order-sync,
// separate from the per-order new-order alert.
//
// At ~3 orders/week, "No orders in fetch window" is the expected result on
// roughly 95 of 96 runs a day. That makes a genuinely broken sync (bad
// Telegram token, KV outage, Walmart API down, a too-narrow fetch window)
// look identical to a normal quiet week — nothing
// distinguishes them until a human happens to check days later. This is
// the class of gap that let PO# 309120965612142 go unnoticed with zero
// cron errors. The heartbeat doesn't diagnose a specific missed order; it
// surfaces the aggregate anomaly (runs/orders trending to zero, or a
// cursor that stops advancing) so a broken week doesn't look quiet.
//
// Counts accumulate in the same Vercel KV used by lib/sync-state.ts across
// runs. Roughly every 24h (not calendar-day aligned — anchored to whenever
// the window last reset) a run sends the accumulated summary and resets.
// Never throws — a heartbeat failure must not affect the sync itself.
// ─────────────────────────────────────────────────────────────

const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const KEY = 'walmart-order-sync:heartbeat';
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface HeartbeatState {
  windowStartedAt: string;
  runs: number;
  ordersSeen: number;
}

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

function parseState(raw: string | null): HeartbeatState {
  if (!raw) return { windowStartedAt: new Date().toISOString(), runs: 0, ordersSeen: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<HeartbeatState>;
    const windowStartMs = parsed.windowStartedAt ? Date.parse(parsed.windowStartedAt) : NaN;
    if (!Number.isFinite(windowStartMs)) throw new Error('bad windowStartedAt');
    return {
      windowStartedAt: parsed.windowStartedAt!,
      runs: typeof parsed.runs === 'number' ? parsed.runs : 0,
      ordersSeen: typeof parsed.ordersSeen === 'number' ? parsed.ordersSeen : 0,
    };
  } catch {
    return { windowStartedAt: new Date().toISOString(), runs: 0, ordersSeen: 0 };
  }
}

/**
 * Record this run and, roughly once every 24h, send a summary Telegram
 * message and reset the counting window.
 * @param ordersSeenThisRun orders returned by fetchRecentOrders this run
 *   (pre-Sheet-dedup — the raw "did Walmart's API give us anything" signal)
 * @param cursorIso the sync cursor value in effect for this run, so the
 *   heartbeat also surfaces a stuck/stale cursor
 * @param sendFn injected so this module doesn't import lib/telegram.js
 *   directly and stays trivially testable
 */
export async function recordRunAndMaybeHeartbeat(
  ordersSeenThisRun: number,
  cursorIso: string,
  sendFn: (text: string) => Promise<boolean>,
): Promise<void> {
  if (!kvAvailable()) {
    console.log('[heartbeat] KV not configured — skipping (no counters to accumulate)');
    return;
  }

  try {
    const now = Date.now();
    const state = parseState(await kvGet(KEY));
    state.runs += 1;
    state.ordersSeen += ordersSeenThisRun;

    const windowStartMs = Date.parse(state.windowStartedAt);
    const due = !Number.isFinite(windowStartMs) || now - windowStartMs >= WINDOW_MS;

    if (!due) {
      await kvSet(KEY, JSON.stringify(state));
      return;
    }

    const text =
      `📊 <b>walmart-order-sync daily heartbeat</b>\n` +
      `Runs in last ~24h: ${state.runs}\n` +
      `Orders seen: ${state.ordersSeen}\n` +
      `Cursor: <code>${cursorIso}</code>`;
    await sendFn(text);

    await kvSet(KEY, JSON.stringify({
      windowStartedAt: new Date(now).toISOString(),
      runs: 0,
      ordersSeen: 0,
    }));
  } catch (err) {
    console.warn(
      '[heartbeat] failed (non-fatal):',
      err instanceof Error ? err.message : String(err)
    );
  }
}

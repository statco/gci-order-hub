// api/walmart-sync-cursor.ts
// ─────────────────────────────────────────────────────────────
// GET /api/walmart-sync-cursor   — Vercel cron trigger (every 2 minutes)
// POST /api/walmart-sync-cursor  — Manual dry-run / debug trigger
//
// Cursor-driven replacement for the 25 static mode=listed crons.
// Advances a Supabase-persisted offset by one limit=50 chunk per tick,
// wraps at the end of the catalog, and runs serially (one cron entry,
// no overlap, no 504 risk).
//
// Tick ordering (must not be reordered — robustness depends on it):
//   1. Auth check
//   2. Read cursor
//   3. Poison-skip guard (attempt_count >= 3 → skip + advance)
//   4. Claim attempt (increment attempt_count, persist BEFORE chunk)
//   5. Run runListedSyncChunk()
//   6. On success → advance offset or wrap
//   7. On failure → increment consecutive_failures, do NOT advance
//   8. Return JSON summary
//
// Env vars:
//   CRON_SECRET               — must match the Authorization: Bearer header
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT
//   (+ all WALMART_* and SHOPIFY_* vars required by runListedSyncChunk)
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runListedSyncChunk } from './lib/listed-sync';
import { readCursor, updateCursor } from './lib/supabase';
import { sendTelegramMessage } from './lib/telegram';

export const config = { maxDuration: 180 };

const CHUNK_LIMIT = 50;

// ── Failure alerting ──────────────────────────────────────────────────────
// Added 2026-08-28 after a ~42h total outage (2026-08-26 17:24 UTC onward,
// every single tick failing on Walmart's /v3/items endpoint) went completely
// unalerted — consecutive_failures climbed past 270 with nothing watching it.
//
// ALERT_THRESHOLD: first alert fires once failures cross this (10 min at the
// 2-min tick interval) — long enough to skip single transient blips, short
// enough that a real outage is caught fast, not after two days.
// ALERT_REPEAT_EVERY: once alerted, re-alert only every N further failures
// (1h) so an ongoing outage doesn't spam the actionable channel every tick.
const ALERT_THRESHOLD    = 5;
const ALERT_REPEAT_EVERY = 30;

async function maybeSendFailureAlert(
  consecutiveFailures: number,
  lastAlertCount: number | null,
  errorDetail: string,
): Promise<number | null> {
  if (consecutiveFailures < ALERT_THRESHOLD) return lastAlertCount;

  const dueForAlert =
    lastAlertCount === null || consecutiveFailures - lastAlertCount >= ALERT_REPEAT_EVERY;
  if (!dueForAlert) return lastAlertCount;

  const minutesDown = consecutiveFailures * 2; // 2-min tick interval
  await sendTelegramMessage(
    `🔴 <b>Walmart sync down</b>\n` +
    `walmart-sync-cursor has failed ${consecutiveFailures} consecutive ticks ` +
    `(~${minutesDown} min). No price or inventory has synced to Walmart in that window.\n\n` +
    `Latest error:\n<code>${errorDetail.slice(0, 300)}</code>`,
    'actionable',
  );
  return consecutiveFailures;
}

async function maybeSendRecoveryAlert(lastAlertCount: number | null): Promise<void> {
  if (lastAlertCount === null) return; // no active outage alert to clear
  await sendTelegramMessage(
    `✅ <b>Walmart sync recovered</b>\nwalmart-sync-cursor succeeded after ${lastAlertCount}+ consecutive failures.`,
    'actionable',
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isDry = req.query['dry'] === 'true';
  const start = Date.now();

  console.log(`🔄 walmart-sync-cursor tick${isDry ? ' [DRY RUN]' : ''}…`);

  // ── 2. Read cursor ────────────────────────────────────────────────────────
  let cursor;
  try {
    cursor = await readCursor();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to read cursor:', msg);
    return res.status(500).json({ error: 'Cursor read failed', details: msg });
  }

  const offset = cursor.current_offset;
  console.log(
    `📍 Cursor: offset=${offset} attempt_count=${cursor.attempt_count}` +
    ` consecutive_failures=${cursor.consecutive_failures} last_status=${cursor.last_status}`
  );

  // ── 3. Poison-skip guard ──────────────────────────────────────────────────
  if (cursor.attempt_count >= 3) {
    const skippedOffset = offset;
    const nextOffset    = offset + CHUNK_LIMIT;
    console.warn(
      `⚠️  POISON-SKIP: offset=${skippedOffset} has attempt_count=${cursor.attempt_count} >= 3.` +
      ` Advancing to offset=${nextOffset} and skipping.`
    );
    await updateCursor({
      current_offset: nextOffset,
      attempt_count:  0,
      last_status:    'skipped',
      last_run_at:    new Date().toISOString(),
    });
    return res.status(200).json({
      skipped:       true,
      skippedOffset,
      nextOffset,
      attempt_count: 0,
      status:        'skipped',
      durationMs:    Date.now() - start,
    });
  }

  // ── 4. Claim the attempt (persist BEFORE running the chunk) ───────────────
  // Critical: Vercel may kill the function mid-chunk on a hard timeout.
  // Incrementing attempt_count here (before the work) means the poison-skip
  // guard will fire on the next tick even if we never reach the post-run write.
  // Cursor writes are NOT gated by isDry — dry suppresses only Walmart writes
  // (inside runListedSyncChunk), never cursor mechanics.
  await updateCursor({ attempt_count: cursor.attempt_count + 1 });

  // ── 5. Run the chunk ──────────────────────────────────────────────────────
  let chunkResult;
  try {
    chunkResult = await runListedSyncChunk({ offset, limit: CHUNK_LIMIT, dry: isDry });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Chunk failed:', msg);
    const newConsecutiveFailures = cursor.consecutive_failures + 1;
    const newAlertCount = await maybeSendFailureAlert(
      newConsecutiveFailures,
      cursor.last_failure_alert_count,
      msg,
    );
    await updateCursor({
      consecutive_failures:     newConsecutiveFailures,
      last_failure_alert_count: newAlertCount,
      last_status:              'error',
      last_run_at:               new Date().toISOString(),
    });
    return res.status(500).json({ error: 'Chunk failed', details: msg, offset, status: 'error' });
  }

  // ── 6. On success: advance or wrap ───────────────────────────────────────
  const wrapped       = chunkResult.done;
  const nextOffset    = wrapped ? 0 : (chunkResult.nextOffset ?? 0);
  const newStatus     = wrapped ? 'wrapped' : 'ok';

  console.log(
    `✅ Chunk done: processed=${chunkResult.processed}` +
    ` nextOffset=${nextOffset} done=${chunkResult.done} wrapped=${wrapped}` +
    ` inv_ok=${chunkResult.inventoryResult?.success ?? 'dry'}` +
    ` inv_fail=${chunkResult.inventoryResult?.failed ?? 'dry'}`
  );

  await maybeSendRecoveryAlert(cursor.last_failure_alert_count);

  await updateCursor({
    current_offset:           nextOffset,
    attempt_count:            0,
    consecutive_failures:     0,
    last_failure_alert_count: null,
    total_listed:             chunkResult.totalListed,
    last_inv_ok:              chunkResult.inventoryResult?.success ?? null,
    last_inv_fail:            chunkResult.inventoryResult?.failed  ?? null,
    last_zeroed:              chunkResult.zeroedNoActiveMatch,
    last_status:              newStatus,
    last_run_at:              new Date().toISOString(),
  });

  // ── 8. Return summary ─────────────────────────────────────────────────────
  return res.status(200).json({
    ok:            true,
    dry:           isDry,
    offset,
    processed:     chunkResult.processed,
    nextOffset,
    done:          chunkResult.done,
    wrapped,
    totalListed:   chunkResult.totalListed,
    inv_ok:        chunkResult.inventoryResult?.success ?? null,
    inv_fail:      chunkResult.inventoryResult?.failed  ?? null,
    zeroed:        chunkResult.zeroedNoActiveMatch,
    heldExposed:   chunkResult.heldExposed.length,
    skippedNoCost: chunkResult.skippedNoCost.length,
    attempt_count: 0,
    status:        newStatus,
    durationMs:    Date.now() - start,
    ...(chunkResult.errors.length ? { errors: chunkResult.errors } : {}),
  });
}

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

export const config = { maxDuration: 180 };

const CHUNK_LIMIT = 50;

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
  // A chunk that has crashed the function 3 times (hard timeout kills the
  // process before any post-run write) is unsafe to retry indefinitely.
  // Skip it: advance the offset and let the next tick resume from there.
  if (cursor.attempt_count >= 3) {
    const skippedOffset = offset;
    const nextOffset    = offset + CHUNK_LIMIT;
    console.warn(
      `⚠️  POISON-SKIP: offset=${skippedOffset} has attempt_count=${cursor.attempt_count} >= 3.` +
      ` Advancing to offset=${nextOffset} and skipping.`
    );
    if (!isDry) {
      await updateCursor({
        current_offset: nextOffset,
        attempt_count:  0,
        last_status:    'skipped',
        last_run_at:    new Date().toISOString(),
      });
    }
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
  if (!isDry) {
    await updateCursor({ attempt_count: cursor.attempt_count + 1 });
  }

  // ── 5. Run the chunk ──────────────────────────────────────────────────────
  let chunkResult;
  try {
    chunkResult = await runListedSyncChunk({ offset, limit: CHUNK_LIMIT, dry: isDry });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Chunk failed:', msg);
    if (!isDry) {
      await updateCursor({
        consecutive_failures: cursor.consecutive_failures + 1,
        last_status:          'error',
        last_run_at:          new Date().toISOString(),
      });
    }
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

  if (!isDry) {
    await updateCursor({
      current_offset:       nextOffset,
      attempt_count:        0,
      consecutive_failures: 0,
      total_listed:         chunkResult.totalListed,
      last_inv_ok:          chunkResult.inventoryResult?.success ?? null,
      last_inv_fail:        chunkResult.inventoryResult?.failed  ?? null,
      last_zeroed:          chunkResult.zeroedNoActiveMatch,
      last_status:          newStatus,
      last_run_at:          new Date().toISOString(),
    });
  }

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

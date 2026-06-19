// api/walmart-retire.ts
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/walmart-retire
//
// Bulk-retires TIRE- duplicate listings on Walmart. Retire is near-permanent
// (it removes the item from the catalogue); consequently this endpoint is
// guarded harder than walmart-zero:
//
//   • Separate secret  — WALMART_RETIRE_SECRET (never reuses WALMART_ZERO_SECRET)
//   • POST-only        — no cron, no GET, manual trigger only
//   • Structural TIRE- guard — any bare SKU in the input → reject whole batch
//   • Live-twin check  — TIRE-XXX is only retired when bare XXX is currently
//                        listed. TIRE-SKUs whose twin is absent are returned in
//                        skippedNoBareTwin and never retired.
//
// Query params:
//   ?dryRun=true|false   — default TRUE; must be explicitly false to write
//   ?offset=N&limit=N    — chunk through a large SKU list (~100 per call)
//
// Request body: { skus: string[] }   (max 500)
//
// Auth: Bearer token matching WALMART_RETIRE_SECRET env var.
// No cron entry — manual only.
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchListedSkus, retireItem } from './lib/walmart-client';

export const config = { maxDuration: 300 };

const SECRET = process.env.WALMART_RETIRE_SECRET ?? '';

const MAX_SKUS  = 500;
const CHUNK_SIZE = 100;

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // ── Method guard ────────────────────────────────────────────────
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST only' });
    }

    // ── Auth ────────────────────────────────────────────────────────
    if (!SECRET) {
      return res.status(500).json({ error: 'WALMART_RETIRE_SECRET not configured' });
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ── Parse body ──────────────────────────────────────────────────
    const body = req.body as { skus?: unknown } | undefined;
    if (!body || !Array.isArray(body.skus)) {
      return res.status(400).json({ error: 'Body must be { skus: string[] }' });
    }

    const rawSkus: string[] = body.skus;
    if (rawSkus.length === 0) {
      return res.status(400).json({ error: 'skus array is empty' });
    }
    if (rawSkus.length > MAX_SKUS) {
      return res.status(400).json({ error: `Too many SKUs — max ${MAX_SKUS}, got ${rawSkus.length}` });
    }

    const skus = rawSkus.map(s => String(s).toUpperCase().trim());

    // ── Hard guardrail: every SKU must start with TIRE- ─────────────
    // If even one bare SKU sneaks in the whole batch is rejected. This
    // makes it structurally impossible to retire a live bare listing.
    const bareSkusPresent = skus.filter(s => !s.startsWith('TIRE-'));
    if (bareSkusPresent.length > 0) {
      return res.status(400).json({
        error: 'Batch rejected — bare (non-TIRE-) SKUs are not permitted in a retire request',
        bareSkusPresent,
      });
    }

    // ── Pagination ──────────────────────────────────────────────────
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const offset    = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
    const rawLimit  = parseInt(String(req.query.limit ?? String(CHUNK_SIZE)), 10);
    const limit     = Number.isNaN(rawLimit) ? CHUNK_SIZE : Math.max(1, Math.min(500, rawLimit));

    const dryRun = (req.query.dryRun as string | undefined ?? 'true') !== 'false';

    const start = Date.now();

    console.log(
      `[walmart-retire] Starting${dryRun ? ' [DRY RUN]' : ' [WRITE]'} ` +
      `skus=${skus.length} offset=${offset} limit=${limit}`,
    );

    // ── Fetch live Walmart listing set ──────────────────────────────
    const listedSkus = await fetchListedSkus();

    // ── Live-twin check ─────────────────────────────────────────────
    // For each TIRE-XXX, confirm bare XXX is currently listed.
    // If the bare twin is absent, skip and report — never retire.
    const willRetire:         string[] = [];
    const skippedNoBareTwin:  string[] = [];

    for (const sku of skus) {
      const bare = sku.slice('TIRE-'.length); // strip prefix
      if (listedSkus.has(bare)) {
        willRetire.push(sku);
      } else {
        console.log(`[walmart-retire] SKIP ${sku} — bare twin ${bare} is NOT currently listed`);
        skippedNoBareTwin.push(sku);
      }
    }

    // ── Apply offset/limit to the willRetire list ───────────────────
    const totalWillRetire = willRetire.length;
    const chunk           = willRetire.slice(offset, offset + limit);
    const chunkSize       = chunk.length;
    const nextOffset      = offset + limit < totalWillRetire ? offset + limit : null;
    const done            = nextOffset === null;

    console.log(
      `[walmart-retire] willRetire=${totalWillRetire} skippedNoBareTwin=${skippedNoBareTwin.length} ` +
      `chunk=${chunkSize} nextOffset=${nextOffset} done=${done}`,
    );

    // ── Dry run ─────────────────────────────────────────────────────
    if (dryRun) {
      return res.status(200).json({
        ok:                  true,
        dryRun:              true,
        walmartListed:       listedSkus.size,
        totalInputSkus:      skus.length,
        willRetireCount:     totalWillRetire,
        willRetire,
        skippedNoBareTwin,
        offset,
        limit,
        chunkSize,
        nextOffset,
        done,
        durationMs:          Date.now() - start,
      });
    }

    // ── Write mode: retire chunk ────────────────────────────────────
    if (chunkSize === 0) {
      return res.status(200).json({
        ok:               true,
        dryRun:           false,
        totalInputSkus:   skus.length,
        willRetireCount:  totalWillRetire,
        skippedNoBareTwin,
        offset,
        limit,
        chunkSize:        0,
        nextOffset,
        done,
        retired:          [],
        failed:           [],
        durationMs:       Date.now() - start,
      });
    }

    const retired: string[]                           = [];
    const failed:  Array<{ sku: string; error: string }> = [];

    for (const sku of chunk) {
      try {
        await retireItem(sku);
        console.log(`[walmart-retire] ✓ retired ${sku}`);
        retired.push(sku);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[walmart-retire] ✗ ${sku}: ${msg}`);
        failed.push({ sku, error: msg });
      }
      // Small pause to avoid hammering the API
      await delay(150);
    }

    console.log(
      `[walmart-retire] done chunk: ${retired.length} retired, ${failed.length} failed, ` +
      `${skippedNoBareTwin.length} skippedNoBareTwin`,
    );

    return res.status(200).json({
      ok:               true,
      dryRun:           false,
      walmartListed:    listedSkus.size,
      totalInputSkus:   skus.length,
      willRetireCount:  totalWillRetire,
      skippedNoBareTwin,
      offset,
      limit,
      chunkSize,
      nextOffset,
      done,
      retiredCount:     retired.length,
      retired,
      failedCount:      failed.length,
      failed,
      durationMs:       Date.now() - start,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-retire] Unhandled error:', message);
    return res.status(500).json({ error: 'Internal error', details: message });
  }
}

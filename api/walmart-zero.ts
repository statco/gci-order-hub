// api/walmart-zero.ts
// ─────────────────────────────────────────────────────────────
// POST /api/walmart-zero
//
// Accepts { skus: string[] } (max 1000). For each SKU that is actually
// listed on Walmart (bare or TIRE- prefixed form), pushes quantity = 0.
// NEVER pushes any non-zero quantity.
//
// Server-side chunking (offset/limit in request body or query params):
//   Send all skus on every call; use offset+limit to walk through them.
//   Default limit: 50. Walk until done:true.
//
// Auth: Bearer token must match WALMART_ZERO_SECRET env var.
//
// Called reactively by gci-brain's inventory-reconcile when it detects
// SKUs that should be zeroed on Walmart.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchListedSkus,
  bulkInventoryFeed,
  chunkArray,
  type WalmartInventoryItem,
} from './lib/walmart-client';

export const config = { maxDuration: 120 };

const SECRET       = process.env.WALMART_ZERO_SECRET ?? '';
const DEFAULT_LIMIT = 50;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // ── Method check ──────────────────────────────────────────────
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST only' });
    }

    // ── Auth ──────────────────────────────────────────────────────
    if (!SECRET) {
      return res.status(500).json({ error: 'WALMART_ZERO_SECRET not configured' });
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ── Parse body ────────────────────────────────────────────────
    const body = req.body as { skus?: unknown; offset?: unknown; limit?: unknown };
    if (!body || !Array.isArray(body.skus) || body.skus.length === 0) {
      return res.status(400).json({ error: 'Body must contain { skus: string[] } (non-empty)' });
    }
    if (body.skus.length > 1000) {
      return res.status(400).json({ error: `Too many SKUs: ${body.skus.length} (max 1000)` });
    }
    const inputSkus: string[] = body.skus.map((s: unknown) => String(s).toUpperCase());

    // ── Pagination (offset/limit from body or query params) ───────
    // Body takes precedence; query params are accepted for curl convenience.
    const rawOffset = body.offset ?? req.query.offset;
    const rawLimit  = body.limit  ?? req.query.limit;
    const offset    = Math.max(0, parseInt(String(rawOffset ?? '0'), 10) || 0);
    const limit     = Math.max(1, Math.min(200, parseInt(String(rawLimit ?? String(DEFAULT_LIMIT)), 10) || DEFAULT_LIMIT));

    // ── Fetch Walmart listed SKUs ─────────────────────────────────
    console.log(`[walmart-zero] Received ${inputSkus.length} SKUs, offset=${offset} limit=${limit}; fetching Walmart listings…`);
    const listedSkus = await fetchListedSkus();

    // ── Match: only push zero for SKUs actually listed on Walmart ──
    const matched: string[] = [];
    const skipped: string[] = [];

    for (const sku of inputSkus) {
      const bare    = sku.startsWith('TIRE-') ? sku.slice(5) : sku;
      const hasBare = listedSkus.has(bare);
      const hasTire = listedSkus.has('TIRE-' + bare);

      if (hasBare || hasTire) {
        // Push whichever form(s) Walmart actually lists
        if (hasBare) matched.push(bare);
        if (hasTire) matched.push('TIRE-' + bare);
      } else {
        skipped.push(sku);
      }
    }

    // Deduplicate (in case input had both bare and TIRE- forms)
    const uniqueMatched = [...new Set(matched)];
    const totalMatched  = uniqueMatched.length;

    // ── Apply chunk (offset/limit over the matched list) ──────────
    const chunkSkus  = uniqueMatched.slice(offset, offset + limit);
    const nextOffset = offset + limit < totalMatched ? offset + limit : null;
    const done       = nextOffset === null;

    console.log(`[walmart-zero] ${totalMatched} matched, ${skipped.length} skipped; chunk ${chunkSkus.length} → nextOffset=${nextOffset}`);

    if (chunkSkus.length === 0) {
      return res.status(200).json({
        ok:          true,
        totalMatched,
        processed:   0,
        offset,
        limit,
        nextOffset,
        done,
        pushed:      0,
        feedResult:  null,
        skipped:     skipped.slice(0, 50),
      });
    }

    // ── Push quantity 0 for this chunk — NEVER non-zero ──────────
    const items: WalmartInventoryItem[] = chunkSkus.map(sku => ({
      sku,
      quantity: 0, // ALWAYS zero — this endpoint must never push non-zero
    }));

    let totalSuccess = 0;
    let totalFailed  = 0;
    for (const chunk of chunkArray(items, 1000)) {
      const result = await bulkInventoryFeed(chunk);
      totalSuccess += result.success;
      totalFailed  += result.failed;
    }

    console.log(`[walmart-zero] Done chunk: ${totalSuccess} zeroed, ${totalFailed} failed`);

    return res.status(200).json({
      ok:          totalFailed === 0,
      totalMatched,
      processed:   chunkSkus.length,
      offset,
      limit,
      nextOffset,
      done,
      pushed:      totalSuccess,
      feedResult:  { success: totalSuccess, failed: totalFailed },
      skipped:     skipped.slice(0, 50),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-zero] Unhandled error:', message);
    return res.status(500).json({ error: 'Internal error', details: message });
  }
}

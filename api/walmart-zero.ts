// api/walmart-zero.ts
// ─────────────────────────────────────────────────────────────
// POST /api/walmart-zero
//
// Accepts { skus: string[] } (max 1000). For each SKU that is actually
// listed on Walmart (bare or TIRE- prefixed form), pushes quantity = 0.
// NEVER pushes any non-zero quantity.
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

export const config = { maxDuration: 60 };

const SECRET = process.env.WALMART_ZERO_SECRET ?? '';

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
    const body = req.body as { skus?: unknown };
    if (!body || !Array.isArray(body.skus) || body.skus.length === 0) {
      return res.status(400).json({ error: 'Body must contain { skus: string[] } (non-empty)' });
    }
    if (body.skus.length > 1000) {
      return res.status(400).json({ error: `Too many SKUs: ${body.skus.length} (max 1000)` });
    }
    const inputSkus: string[] = body.skus.map((s: unknown) => String(s).toUpperCase());

    // ── Fetch Walmart listed SKUs ─────────────────────────────────
    console.log(`[walmart-zero] Received ${inputSkus.length} SKUs, fetching Walmart listings…`);
    const listedSkus = await fetchListedSkus();

    // ── Match: only push zero for SKUs actually listed on Walmart ──
    const matched: string[] = [];
    const skipped: string[] = [];

    for (const sku of inputSkus) {
      const bare = sku.startsWith('TIRE-') ? sku.slice(5) : sku;
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

    console.log(`[walmart-zero] ${uniqueMatched.length} matched, ${skipped.length} skipped (not listed)`);

    if (uniqueMatched.length === 0) {
      return res.status(200).json({
        ok: true,
        matched: 0,
        pushed: 0,
        feedResult: null,
        skipped: skipped.slice(0, 50),
      });
    }

    // ── Push quantity 0 — NEVER non-zero ──────────────────────────
    const items: WalmartInventoryItem[] = uniqueMatched.map(sku => ({
      sku,
      quantity: 0, // ALWAYS zero — this endpoint must never push non-zero
    }));

    let totalSuccess = 0;
    let totalFailed = 0;
    for (const chunk of chunkArray(items, 1000)) {
      const result = await bulkInventoryFeed(chunk);
      totalSuccess += result.success;
      totalFailed += result.failed;
    }

    console.log(`[walmart-zero] Done: ${totalSuccess} zeroed, ${totalFailed} failed`);

    return res.status(200).json({
      ok: totalFailed === 0,
      matched: uniqueMatched.length,
      pushed: totalSuccess,
      feedResult: { success: totalSuccess, failed: totalFailed },
      skipped: skipped.slice(0, 50),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-zero] Unhandled error:', message);
    return res.status(500).json({ error: 'Internal error', details: message });
  }
}

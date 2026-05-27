/**
 * api/walmart-listed-count.ts
 *
 * Diagnostic endpoint — calls fetchListedSkus() and returns the total
 * count so we can verify it matches Seller Center (expected: ~2,724).
 *
 * GET /api/walmart-listed-count
 *
 * Returns:
 *   { totalFetched, sampleSkus }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchListedSkus } from './lib/walmart-client.js';

export const config = { maxDuration: 300 };

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const skus = await fetchListedSkus();
    const skuArray = [...skus];
    return res.status(200).json({
      totalFetched: skuArray.length,
      sampleSkus:   skuArray.slice(0, 5),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

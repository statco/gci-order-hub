/**
 * api/walmart-listed-count.ts
 *
 * Diagnostic endpoint — probes the raw /v3/items response to identify
 * the correct pagination field name, then calls fetchListedSkus() to
 * get the full count (expected: ~2,724 matching Seller Center).
 *
 * GET /api/walmart-listed-count
 *
 * Returns:
 *   { rawPageKeys, rawPageSample, rawPageError, totalFetched, sampleSkus }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { walmartFetch, fetchListedSkus } from './lib/walmart-client.js';

export const config = { maxDuration: 300 };

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  // Probe the first page directly to identify the cursor field name.
  let testRes: any       = null;
  let rawPageError: string | null = null;
  try {
    testRes = await walmartFetch<any>(
      '/v3/items?limit=5&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE'
    );
    console.log('Raw items response keys:', JSON.stringify(Object.keys(testRes || {})));
    console.log('Raw items response sample:', JSON.stringify(testRes || {}).slice(0, 300));
  } catch (err: any) {
    rawPageError = err.message;
    console.error('Raw items probe failed:', err.message);
  }

  const rawPageKeys   = Object.keys(testRes || {});
  const rawPageSample = JSON.stringify(testRes || {}).slice(0, 300);

  try {
    const skus     = await fetchListedSkus();
    const skuArray = [...skus];
    return res.status(200).json({
      rawPageKeys,
      rawPageSample,
      ...(rawPageError ? { rawPageError } : {}),
      totalFetched: skuArray.length,
      sampleSkus:   skuArray.slice(0, 5),
    });
  } catch (err: any) {
    return res.status(500).json({
      rawPageKeys,
      rawPageSample,
      ...(rawPageError ? { rawPageError } : {}),
      error: err.message,
    });
  }
}

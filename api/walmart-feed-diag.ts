/**
 * api/walmart-feed-diag.ts
 *
 * Diagnostic endpoint — dumps the raw Walmart feed status response so we can
 * inspect the exact shape of itemDetails / ingestionErrors before finalising
 * the parsing logic in walmart-feed-status.ts.
 *
 * GET /api/walmart-feed-diag?feedId=<feedId>
 *
 * Returns: { topLevelKeys, itemDetailsKeys, rawSample, raw }
 *   raw          — full Walmart response (may be large for feeds with many items)
 *   topLevelKeys — keys present at the top level of the response
 *   itemDetailsKeys — keys inside itemDetails (if it exists)
 *   rawSample    — first item from ItemDetails array (if present) to show variant shape
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client';

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');

  const feedId = req.query.feedId as string | undefined;
  if (!feedId) {
    return res.status(400).json({ error: 'Missing feedId query param' });
  }

  const token = await getWalmartToken();
  const correlationId = crypto.randomUUID();

  const walmartRes = await fetch(
    `${process.env.WALMART_BASE_URL}/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true`,
    {
      headers: {
        'WM_SEC.ACCESS_TOKEN':   token,
        'WM_GLOBAL_VERSION':     '3.1',
        'WM_MARKET':             'ca',
        'WM_SVC.NAME':           'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': correlationId,
        Accept:                  'application/json',
      },
    }
  );

  const data: any = await walmartRes.json();

  const topLevelKeys    = Object.keys(data ?? {});
  const itemDetails     = data?.itemDetails ?? data?.ItemDetails ?? null;
  const itemDetailsKeys = itemDetails ? Object.keys(itemDetails) : null;

  // Pull first item to show per-item shape without sending the entire payload twice
  const itemsArray: any[] =
    itemDetails?.ItemDetails ?? itemDetails?.itemDetails ?? [];
  const rawSample = itemsArray[0] ?? null;

  return res.status(walmartRes.status).json({
    httpStatus:      walmartRes.status,
    topLevelKeys,
    itemDetailsKeys,
    rawSample,
    raw:             data,
  });
}

/**
 * api/walmart-feed-status.ts
 *
 * Polls the status of a submitted Walmart item feed.
 * Use after calling /api/walmart-item-feed to track listing creation progress.
 *
 * GET /api/walmart-feed-status?feedId=<feedId>
 *
 * Returns:
 *   {
 *     feedId, feedStatus, itemsTotal, itemsSucceeded, itemsFailed,
 *     itemsProcessing, errors[], ingestionSummary
 *   }
 *
 * feedStatus values:
 *   RECEIVED       — Feed received, not yet queued
 *   INPROGRESS     — Feed being processed
 *   PROCESSED      — Processing complete (check itemsFailed for partial failures)
 *   ERROR          — Feed-level error (malformed payload, auth issue, etc.)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { getWalmartToken } from './lib/walmart-client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IngestionError {
  type: string;
  code: string;
  field: string;
  description: string;
}

interface ItemError {
  sku: string;
  ingestionStatus: string;
  errors: IngestionError[];
}

interface FeedStatusResponse {
  feedId: string;
  feedStatus: string;
  itemsTotal: number;
  itemsSucceeded: number;
  itemsFailed: number;
  itemsProcessing: number;
  errors: ItemError[];
  ingestionSummary: {
    totalFailedItems: number;
    totalSucceededItems: number;
  } | null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const { feedId } = req.query;

  if (!feedId || typeof feedId !== 'string') {
    return res.status(400).json({
      error: 'Missing required query param: feedId',
      usage: 'GET /api/walmart-feed-status?feedId=<your-feed-id>',
    });
  }

  try {
    const token = await getWalmartToken();

    // includeDetails=true returns per-item ingestion errors
    const walmartRes = await fetch(
      `${process.env.WALMART_BASE_URL}/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true`,
      {
        headers: {
          'WM_SEC.ACCESS_TOKEN': token,
          'WM_GLOBAL_VERSION': '3.1',
          'WM_MARKET': 'ca',
          'WM_SVC.NAME': 'Walmart Marketplace',
          'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
          Accept: 'application/json',
        },
      }
    );

    if (!walmartRes.ok) {
      const errorText = await walmartRes.text();
      return res.status(walmartRes.status).json({
        error: 'Walmart API error',
        details: errorText,
      });
    }

    const data = await walmartRes.json();

    // TEMP DIAGNOSTIC — remove after inspecting structure
    return res.status(200).json({ raw: data });

    // Extract per-item errors from itemDetails if present
    const itemErrors: ItemError[] = [];

    const rawItems: any[] =
      data?.itemDetails?.ItemDetails ?? [];

    for (const rawItem of rawItems) {
      const errs: IngestionError[] =
        rawItem?.ingestionErrors?.ingestionError ?? [];

      if (errs.length > 0) {
        itemErrors.push({
          sku: rawItem.itemid ?? rawItem.sku ?? 'unknown',
          ingestionStatus: rawItem.ingestionStatus ?? 'ERROR',
          errors: errs.map((e: any) => ({
            type: e.type ?? '',
            code: e.code ?? '',
            field: e.field ?? '',
            description: e.description ?? '',
          })),
        });
      }
    }

    const response: FeedStatusResponse = {
      feedId,
      feedStatus: data.feedStatus ?? 'UNKNOWN',
      itemsTotal: data.itemsTotal ?? 0,
      itemsSucceeded: data.itemsSucceeded ?? 0,
      itemsFailed: data.itemsFailed ?? 0,
      itemsProcessing: data.itemsProcessing ?? 0,
      errors: itemErrors,
      ingestionSummary: data.ingestionSummary ?? null,
    };

    // Friendly console summary
    console.log(
      `[walmart-feed-status] feedId=${feedId} | status=${response.feedStatus}` +
      ` | ✅ ${response.itemsSucceeded} | ❌ ${response.itemsFailed}` +
      ` | ⏳ ${response.itemsProcessing}`
    );

    return res.status(200).json(response);

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[walmart-feed-status] Error:', message);
    return res.status(500).json({ error: message });
  }
}

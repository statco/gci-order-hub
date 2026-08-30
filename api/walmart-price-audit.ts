/**
 * api/walmart-price-audit.ts
 *
 * READ-ONLY diagnostic. Compares Walmart listed prices against current
 * Shopify prices, in BOTH directions:
 *
 *   - 'below_shopify': Walmart price is more than 5% below Shopify price —
 *     the delisting-risk direction (Walmart delists sellers found pricing
 *     lower elsewhere).
 *   - 'overpriced': Walmart price sits more than 5% above the correct
 *     landed-cost floor (real tireType/rimSize).
 *
 * CHANGED 2026-08-30: this endpoint used to auto-correct flagged SKUs by
 * default (writes unless ?dryRun=true was passed) — a second, independent
 * place computing and pushing a Walmart price, alongside the live
 * walmart-sync-cursor cron. The two could diverge and fight each other.
 * That write capability is removed entirely. api/lib/listed-sync.ts (used
 * by the scheduled cursor) now computes the identical safeWalmartPrice()
 * value automatically every 2 minutes — there is exactly one place in this
 * codebase that ever decides and writes a Walmart price. This endpoint is
 * now report-only, for manual sanity-checking between cursor passes.
 *
 * GET /api/walmart-price-audit               — report only, no writes, ever
 * GET /api/walmart-price-audit?offset=N&limit=M — paginated (default: all)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client.js';
import { fetchAllShopifyVariants } from './lib/shopify.js';
import { safeWalmartPrice } from './lib/pricing.js';

const WALMART_BASE    = process.env.WALMART_BASE_URL!;
const PAGE_SIZE       = 200;
const PRICE_THRESHOLD = 0.05; // flag if Walmart price < Shopify price × (1 - 0.05)

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditRow {
  sku: string;
  direction: 'below_shopify' | 'overpriced';
  walmartPrice: number;
  shopifyPrice: number;
  cost: number | null;
  safePrice: number | null;
  /** % below Shopify price (below_shopify rows) or % above the correct floor (overpriced rows). */
  pctDiff: number;
}

// ─── Walmart helpers ──────────────────────────────────────────────────────────

async function fetchListedItemsWithPrices(
  token: string
): Promise<Array<{ sku: string; price: number }>> {
  const items: Array<{ sku: string; price: number }> = [];
  let offset = 0;
  let totalItems = Infinity;

  while (offset < totalItems) {
    const res = await fetch(
      `${WALMART_BASE}/v3/items?limit=${PAGE_SIZE}&offset=${offset}&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`,
      {
        headers: {
          'WM_SEC.ACCESS_TOKEN':    token,
          'WM_GLOBAL_VERSION':      '3.1',
          'WM_MARKET':              'ca',
          'WM_SVC.NAME':            'Walmart Marketplace',
          'WM_QOS.CORRELATION_ID':  crypto.randomUUID(),
          Accept:                   'application/json',
        },
      }
    );

    if (!res.ok) throw new Error(`Walmart items API error: ${res.status}`);
    const data = await res.json();

    if (offset === 0) {
      totalItems = data.totalItems ?? 0;
      // Log raw first item shape to confirm price field name
      const sample = (data.ItemResponse ?? data.items ?? [])[0];
      console.log('[walmart-price-audit] first item sample:', JSON.stringify(sample));
    }

    const page: any[] = data.ItemResponse ?? data.items ?? [];
    if (page.length === 0) break;

    for (const item of page) {
      const sku = (item.sku ?? item.mart?.sku ?? '').toUpperCase();
      // Price may be nested — try common shapes
      const price =
        item.price?.currentPrice?.price ??
        item.price?.amount ??
        item.pricing?.[0]?.currentPrice?.amount ??
        item.currentPrice?.amount ??
        null;

      if (sku && price !== null) {
        items.push({ sku, price: parseFloat(price) });
      }
    }

    offset += PAGE_SIZE;
  }

  return items;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const offset = parseInt(req.query.offset as string ?? '0', 10) || 0;
  const limit = parseInt(req.query.limit as string ?? '300', 10) || 300;

  try {
    const token = await getWalmartToken();

    console.log('[walmart-price-audit] Fetching Walmart listed items with prices...');
    const walmartItems = await fetchListedItemsWithPrices(token);
    console.log(`[walmart-price-audit] Got ${walmartItems.length} Walmart items with prices`);

    console.log('[walmart-price-audit] Fetching Shopify variant map (price + cost)...');
    const shopify = await fetchAllShopifyVariants();
    console.log(`[walmart-price-audit] Got ${shopify.size} Shopify variants`);

    const flagged: AuditRow[] = [];
    const clean: number[] = [];

    for (const { sku, price: walmartPrice } of walmartItems) {
      const sv = shopify.get(sku);
      if (!sv || sv.price == null) continue; // no Shopify match — skip
      const shopifyPrice = sv.price;
      const safePrice = safeWalmartPrice({ shopifyPrice, cost: sv.cost, tireType: sv.tireType, rimSize: sv.rimSize });

      const belowThreshold = shopifyPrice * (1 - PRICE_THRESHOLD);
      const aboveThreshold = safePrice != null ? safePrice * (1 + PRICE_THRESHOLD) : null;

      if (walmartPrice < belowThreshold) {
        const pctDiff = ((shopifyPrice - walmartPrice) / shopifyPrice) * 100;
        flagged.push({
          sku, direction: 'below_shopify', walmartPrice, shopifyPrice,
          cost: sv.cost, safePrice, pctDiff: parseFloat(pctDiff.toFixed(1)),
        });
      } else if (aboveThreshold != null && walmartPrice > aboveThreshold) {
        const pctDiff = ((walmartPrice - safePrice!) / safePrice!) * 100;
        flagged.push({
          sku, direction: 'overpriced', walmartPrice, shopifyPrice,
          cost: sv.cost, safePrice, pctDiff: parseFloat(pctDiff.toFixed(1)),
        });
      } else {
        clean.push(walmartPrice);
      }
    }

    // Sort worst discrepancy first
    flagged.sort((a, b) => b.pctDiff - a.pctDiff);
    const pagedFlagged = flagged.slice(offset, offset + limit);

    const totalBelowShopify = flagged.filter(r => r.direction === 'below_shopify').length;
    const totalOverpriced   = flagged.filter(r => r.direction === 'overpriced').length;

    console.log(
      `[walmart-price-audit] Flagged: ${flagged.length} (below_shopify=${totalBelowShopify}, overpriced=${totalOverpriced})` +
      ` | Paged: ${pagedFlagged.length} | READ-ONLY, no writes made`
    );

    return res.status(200).json({
      readOnly: true,
      note: 'This endpoint never writes. Corrections happen automatically via walmart-sync-cursor every 2 minutes using the same safeWalmartPrice() formula.',
      totalItems: walmartItems.length,
      totalFlagged: flagged.length,
      totalBelowShopify,
      totalOverpriced,
      offset,
      limit,
      nextOffset: offset + limit < flagged.length ? offset + limit : null,
      pagedFlaggedCount: pagedFlagged.length,
      cleanCount: clean.length,
      flagged: pagedFlagged,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-price-audit] Error:', message);
    return res.status(500).json({ error: message });
  }
}

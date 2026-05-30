/**
 * api/walmart-price-audit.ts
 *
 * Compares Walmart listed prices against current Shopify prices.
 * Flags and auto-corrects any SKU where Walmart price is more than 5% below Shopify price.
 *
 * GET /api/walmart-price-audit?dryRun=true   — report only, no corrections
 * GET /api/walmart-price-audit               — report + auto-correct flagged SKUs
 * GET /api/walmart-price-audit?offset=N&limit=M — paginated (default: all)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client.js';
import { fetchAllShopifyVariants } from './lib/shopify.js';
import { safeWalmartPrice, assertAboveCost } from './lib/pricing.js';

const WALMART_BASE    = process.env.WALMART_BASE_URL!;
const PAGE_SIZE       = 200;
const PRICE_THRESHOLD = 0.05; // flag if Walmart price < Shopify price × (1 - 0.05)

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditRow {
  sku: string;
  walmartPrice: number;
  shopifyPrice: number;
  cost: number | null;
  safePrice: number | null;
  pctBelow: number;
  corrected: boolean;
  skippedNoCost?: boolean;
  error?: string;
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

async function correctWalmartPrice(
  token: string,
  sku: string,
  newPrice: number,
  cost: number | null
): Promise<void> {
  const amount = parseFloat(newPrice.toFixed(2));
  // LAYER 1 backstop — a below-cost correction throws rather than ships.
  assertAboveCost(sku, amount, cost);

  const res = await fetch(`${WALMART_BASE}/v3/price`, {
    method: 'PUT',
    headers: {
      'WM_SEC.ACCESS_TOKEN':    token,
      'WM_GLOBAL_VERSION':      '3.1',
      'WM_MARKET':              'ca',
      'WM_SVC.NAME':            'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID':  crypto.randomUUID(),
      Accept:                   'application/json',
      'Content-Type':           'application/json',
    },
    body: JSON.stringify({
      sku,
      pricing: [{
        currentPriceType: 'BASE',
        currentPrice: { currency: 'CAD', amount },
      }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Price update failed for ${sku}: ${text}`);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const dryRun = req.query.dryRun === 'true';
  const isCron = req.headers['x-vercel-cron'] === '1';
  const offset = parseInt(req.query.offset as string ?? '0', 10) || 0;
  const limit = isCron ? 99999 : (parseInt(req.query.limit as string ?? '300', 10) || 300);

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

      const threshold = shopifyPrice * (1 - PRICE_THRESHOLD);
      if (walmartPrice < threshold) {
        const pctBelow = ((shopifyPrice - walmartPrice) / shopifyPrice) * 100;
        const safePrice = safeWalmartPrice({ shopifyPrice, cost: sv.cost });
        const row: AuditRow = {
          sku,
          walmartPrice,
          shopifyPrice,
          cost: sv.cost,
          safePrice,
          pctBelow: parseFloat(pctBelow.toFixed(1)),
          corrected: false,
        };

        flagged.push(row);
      } else {
        clean.push(walmartPrice);
      }
    }

    // Sort worst discrepancy first
    flagged.sort((a, b) => b.pctBelow - a.pctBelow);

    // Paginate corrections on the flagged array, not walmartItems
    const pagedFlagged = flagged.slice(offset, offset + limit);

    if (!dryRun) {
      for (const row of pagedFlagged) {
        // LAYER 1: correct to the floored safe price, never the raw Shopify
        // price. Missing cost → skip + log (never guess).
        if (row.safePrice == null) {
          row.skippedNoCost = true;
          continue;
        }
        try {
          await correctWalmartPrice(token, row.sku, row.safePrice, row.cost);
          row.corrected = true;
        } catch (e: unknown) {
          row.error = e instanceof Error ? e.message : String(e);
        }
      }
    }

    console.log(`[walmart-price-audit] Flagged: ${flagged.length} | Paged: ${pagedFlagged.length} | Corrected: ${pagedFlagged.filter(r => r.corrected).length} | dryRun: ${dryRun}`);

    return res.status(200).json({
      dryRun,
      totalItems: walmartItems.length,
      totalFlagged: flagged.length,
      offset,
      limit,
      nextOffset: offset + limit < flagged.length ? offset + limit : null,
      pagedFlaggedCount: pagedFlagged.length,
      corrected: pagedFlagged.filter(r => r.corrected).length,
      skippedNoCost: pagedFlagged.filter(r => r.skippedNoCost).map(r => r.sku),
      cleanCount: clean.length,
      flagged: pagedFlagged,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-price-audit] Error:', message);
    return res.status(500).json({ error: message });
  }
}

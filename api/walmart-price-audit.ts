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

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE_DOMAIN!;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_API_TOKEN!;
const WALMART_BASE    = process.env.WALMART_BASE_URL!;
const PAGE_SIZE       = 200;
const PRICE_THRESHOLD = 0.05; // flag if Walmart price < Shopify price × (1 - 0.05)

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditRow {
  sku: string;
  walmartPrice: number;
  shopifyPrice: number;
  pctBelow: number;
  corrected: boolean;
  error?: string;
}

// ─── Shopify helpers ──────────────────────────────────────────────────────────

async function fetchShopifyPriceMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const query: string = `{
      productVariants(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node { sku price }
        }
      }
    }`;

    const res: Response = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      }
    );
    if (!res.ok) throw new Error(`Shopify GraphQL error: ${res.status}`);
    const data: any = await res.json();

    const variants: any = data?.data?.productVariants;
    if (!variants) throw new Error('Shopify GraphQL: unexpected response shape');

    for (const edge of variants.edges) {
      const { sku, price } = edge.node;
      if (sku) map.set(sku.toUpperCase(), parseFloat(price));
    }

    hasMore = variants.pageInfo.hasNextPage;
    cursor = variants.pageInfo.endCursor;
  }

  return map;
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
  newPrice: number
): Promise<void> {
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
        currentPrice: { currency: 'CAD', amount: parseFloat(newPrice.toFixed(2)) },
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
  const offset = parseInt(req.query.offset as string ?? '0', 10) || 0;
  const limit = parseInt(req.query.limit as string ?? '300', 10) || 300;

  try {
    const token = await getWalmartToken();

    console.log('[walmart-price-audit] Fetching Walmart listed items with prices...');
    const walmartItems = await fetchListedItemsWithPrices(token);
    console.log(`[walmart-price-audit] Got ${walmartItems.length} Walmart items with prices`);
    const debugSku = 'TIRE-170034002';
    const debugWalmart = walmartItems.find(i => i.sku === debugSku);
    console.log(`[walmart-price-audit] DEBUG ${debugSku} → walmart: ${debugWalmart ? debugWalmart.price : 'NOT FOUND'}`);

    console.log('[walmart-price-audit] Fetching Shopify price map...');
    const shopifyPrices = await fetchShopifyPriceMap();
    console.log(`[walmart-price-audit] Got ${shopifyPrices.size} Shopify variant prices`);
    console.log(`[walmart-price-audit] DEBUG ${debugSku} → shopify: ${shopifyPrices.get(debugSku) ?? 'NOT FOUND'}`);

    const flagged: AuditRow[] = [];
    const clean: number[] = [];

    const pagedItems = walmartItems.slice(offset, offset + limit);

    for (const { sku, price: walmartPrice } of pagedItems) {
      const shopifyPrice = shopifyPrices.get(sku);
      if (!shopifyPrice) continue; // no Shopify match — skip

      const threshold = shopifyPrice * (1 - PRICE_THRESHOLD);
      if (walmartPrice < threshold) {
        const pctBelow = ((shopifyPrice - walmartPrice) / shopifyPrice) * 100;
        const row: AuditRow = {
          sku,
          walmartPrice,
          shopifyPrice,
          pctBelow: parseFloat(pctBelow.toFixed(1)),
          corrected: false,
        };

        if (!dryRun) {
          try {
            await correctWalmartPrice(token, sku, shopifyPrice);
            row.corrected = true;
          } catch (e: unknown) {
            row.error = e instanceof Error ? e.message : String(e);
          }
        }

        flagged.push(row);
      } else {
        clean.push(walmartPrice);
      }
    }

    // Sort worst discrepancy first
    flagged.sort((a, b) => b.pctBelow - a.pctBelow);

    console.log(`[walmart-price-audit] Flagged: ${flagged.length} | Clean: ${clean.length} | dryRun: ${dryRun}`);

    return res.status(200).json({
      dryRun,
      totalItems: walmartItems.length,
      offset,
      limit,
      nextOffset: offset + limit < walmartItems.length ? offset + limit : null,
      totalChecked: pagedItems.length,
      matched: flagged.length + clean.length,
      flaggedCount: flagged.length,
      cleanCount: clean.length,
      corrected: flagged.filter(r => r.corrected).length,
      flagged,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-price-audit] Error:', message);
    return res.status(500).json({ error: message });
  }
}

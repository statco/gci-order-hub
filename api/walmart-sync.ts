// api/walmart-sync.ts
// ─────────────────────────────────────────────────────────────
// GET /api/walmart-sync   — Vercel cron trigger (0 9 * * *)
// POST /api/walmart-sync  — Manual trigger
//
// Reads all TIRE- variants from Shopify (gcitires.com) and pushes
// updated price + quantity to Walmart Marketplace.
//
// Safety switch:
//   Shopify qty < 4  →  Walmart qty = 0  (prevents overselling)
//
// Supports ?dry=true to preview changes without writing to Walmart.
//
// Env vars:
//   SHOPIFY_STORE_DOMAIN        — e.g. gcitires.myshopify.com
//   SHOPIFY_ADMIN_API_TOKEN     — Shopify Admin API access token
//   WALMART_CLIENT_ID           — Walmart Marketplace client ID
//   WALMART_CLIENT_SECRET       — Walmart Marketplace client secret
//   WALMART_BASE_URL            — optional (default https://marketplace.walmartapis.com)
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse }  from '@vercel/node';
import {
  bulkPriceFeed,
  bulkInventoryFeed,
  chunkArray,
  type WalmartPriceItem,
  type WalmartInventoryItem,
} from './lib/walmart-client.js';

export const config = { maxDuration: 60 };

// ─── SHOPIFY CONFIG ───────────────────────────────────────────

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN    ?? '';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION    = '2024-01';
const SHOPIFY_BASE   = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}`;

const TIRE_PREFIX      = 'TIRE-';
const CT_SYNC_TAG      = 'ct-sync';
const LOW_STOCK_CUTOFF = 4;     // qty below this → Walmart qty = 0
const WALMART_CHUNK    = 1_000; // Walmart feed max items per call

// ─── SHOPIFY HELPERS ──────────────────────────────────────────

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function shopifyGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SHOPIFY_BASE}${path}`, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type':           'application/json',
    },
  });
  if (res.status === 429) { await delay(2_000); return shopifyGet<T>(path); }
  if (!res.ok) throw new Error(`Shopify ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

interface SyncItem {
  sku:          string;
  price:        number;
  shopifyQty:   number;
  walmartQty:   number;
}

async function fetchTireVariants(): Promise<SyncItem[]> {
  const items: SyncItem[] = [];
  let sinceId = 0;

  while (true) {
    const q    = `tag=${CT_SYNC_TAG}&limit=250&fields=id,variants${sinceId ? `&since_id=${sinceId}` : ''}`;
    const data: any = await shopifyGet<any>(`/products.json?${q}`);
    const products  = data.products ?? [];

    for (const p of products) {
      for (const v of p.variants) {
        const sku = ((v.sku as string) ?? '').toUpperCase();
        if (!sku.startsWith(TIRE_PREFIX)) continue;

        const shopifyQty = Math.max(0, (v.inventory_quantity as number) ?? 0);
        items.push({
          sku,
          price:      parseFloat(v.price as string) || 0,
          shopifyQty,
          walmartQty: shopifyQty < LOW_STOCK_CUTOFF ? 0 : shopifyQty,
        });
      }
    }

    if (products.length < 250) break;
    sinceId = products[products.length - 1].id;
    await delay(300); // respect Shopify rate limits
  }

  return items;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    return res.status(500).json({ error: 'Shopify credentials not configured' });
  }

  const isDry = req.query.dry === 'true';
  const start = Date.now();

  console.log(`🛒 Walmart sync starting${isDry ? ' [DRY RUN]' : ''}…`);

  // ── Fetch Shopify data ────────────────────────────────────────
  let items: SyncItem[];
  try {
    items = await fetchTireVariants();
  } catch (err: any) {
    console.error('❌ Shopify fetch failed:', err.message);
    return res.status(500).json({ error: 'Shopify fetch failed', details: err.message });
  }

  console.log(`📦 ${items.length} TIRE- variants fetched from Shopify`);

  if (items.length === 0) {
    return res.status(200).json({ ok: true, message: 'No TIRE- variants found', synced: 0 });
  }

  const safetyZeroed = items.filter(i => i.shopifyQty > 0 && i.walmartQty === 0).length;
  console.log(`🛡️  Safety-zeroed: ${safetyZeroed} items (qty < ${LOW_STOCK_CUTOFF})`);

  // ── Dry run ───────────────────────────────────────────────────
  if (isDry) {
    return res.status(200).json({
      dryRun:       true,
      total:        items.length,
      safetyZeroed,
      sample:       items.slice(0, 5).map(i => ({
        sku:        i.sku,
        price:      i.price,
        shopifyQty: i.shopifyQty,
        walmartQty: i.walmartQty,
      })),
    });
  }

  // ── Push to Walmart ───────────────────────────────────────────
  const priceItems:     WalmartPriceItem[]     = items.map(i => ({ sku: i.sku, price: i.price }));
  const inventoryItems: WalmartInventoryItem[] = items.map(i => ({ sku: i.sku, quantity: i.walmartQty }));

  const priceFeedIds:    string[] = [];
  const inventoryFeedIds:string[] = [];
  const errors:          string[] = [];

  for (const chunk of chunkArray(priceItems, WALMART_CHUNK)) {
    try {
      priceFeedIds.push(await bulkPriceFeed(chunk));
    } catch (err: any) {
      errors.push(`price chunk: ${err.message}`);
    }
    await delay(500);
  }

  for (const chunk of chunkArray(inventoryItems, WALMART_CHUNK)) {
    try {
      inventoryFeedIds.push(await bulkInventoryFeed(chunk));
    } catch (err: any) {
      errors.push(`inventory chunk: ${err.message}`);
    }
    await delay(500);
  }

  const durationMs = Date.now() - start;
  console.log(`✅ Walmart sync done in ${durationMs}ms`);

  return res.status(errors.length > 0 ? 207 : 200).json({
    ok:             errors.length === 0,
    totalVariants:  items.length,
    safetyZeroed,
    priceFeedIds,
    inventoryFeedIds,
    durationMs,
    ...(errors.length ? { errors } : {}),
  });
}

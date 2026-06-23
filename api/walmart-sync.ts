// api/walmart-sync.ts
// ─────────────────────────────────────────────────────────────
// GET /api/walmart-sync   — Vercel cron trigger
// POST /api/walmart-sync  — Manual trigger
//
// Reads all ct-sync variants from Shopify (gcitires.com) and pushes
// updated price + quantity to Walmart Marketplace.
//
// Inventory rule:
//   Shopify qty === 0  →  Walmart qty = 0
//   Shopify qty  >  0  →  Walmart qty = real Shopify quantity (no suppression)
//   (The previous "< 4 → 0" low-stock suppression was removed — it hid live
//    stock from Walmart and suppressed sales.)
//
// Query params:
//   ?dry=true              — preview without writing to Walmart
//   ?mode=listed           — only sync SKUs currently listed on Walmart
//                            (fetches /v3/items to build allowed-SKU set)
//   ?mode=audit            — compare Walmart vs Shopify SKUs, no writes
//   ?offset=N&limit=M      — when mode=listed, slice the Walmart SKU list
//                            to [offset, offset+limit) so large catalogues
//                            can be processed in time-bounded chunks
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
  fetchListedSkus,
  chunkArray,
  type WalmartPriceItem,
  type WalmartInventoryItem,
} from './lib/walmart-client';
import { fetchAllShopifyVariants, fetchActiveCtSyncVariants } from './lib/shopify';
import { safeWalmartPrice, PRICE_FLOOR_MULTIPLIER } from './lib/pricing';

export const config = { maxDuration: 300 };

// ─── SHOPIFY CONFIG ─────────────────────────────────────────────

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN    ?? '';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION    = '2024-01';
const SHOPIFY_BASE   = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}`;

const CT_SYNC_TAG      = 'ct-sync';
const WALMART_CHUNK    = 1_000; // Walmart feed max items per call

// ─── SHOPIFY HELPERS ────────────────────────────────────────────

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
  cost:         number | null;   // attached from the GraphQL variant map (for the Layer 1 floor)
  ctCost:       number | null;   // canada_tire.cost metafield — for the exposure hold
  shopifyQty:   number;
  walmartQty:   number;
}

async function fetchTireVariants(): Promise<SyncItem[]> {
  const items: SyncItem[] = [];
  let sinceId = 0;

  while (true) {
    const q    = `tag=${CT_SYNC_TAG}&status=active&limit=250&fields=id,variants${sinceId ? `&since_id=${sinceId}` : ''}`;
    const data: any = await shopifyGet<any>(`/products.json?${q}`);
    const products  = data.products ?? [];

    for (const p of products) {
      for (const v of p.variants) {
        const sku = ((v.sku as string) ?? '').toUpperCase();
        if (!sku) continue;

        const shopifyQty = Math.max(0, (v.inventory_quantity as number) ?? 0);
        const entry = {
          price:      parseFloat(v.price as string) || 0,
          cost:       null as number | null,  // enriched post-fetch from the GraphQL variant map
          ctCost:     null as number | null,  // enriched post-fetch (canada_tire.cost)
          shopifyQty,
          walmartQty: shopifyQty, // send real qty; 0 only when Shopify is 0
        };

        // Push bare SKU + TIRE- prefixed version so the listed filter matches
        // regardless of which format Walmart has the item listed under.
        items.push({ sku, ...entry });
        if (!sku.startsWith('TIRE-')) {
          items.push({ sku: `TIRE-${sku}`, ...entry });
        }
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

  const isDry       = req.query.dry === 'true';
  const mode        = (req.query.mode as string) ?? '';
  const offsetParam = parseInt((req.query.offset as string) ?? '0', 10) || 0;
  const limitParam  = req.query.limit ? parseInt(req.query.limit as string, 10) : null;
  const start       = Date.now();

  console.log(
    `🛒 Walmart sync starting${
      isDry ? ' [DRY RUN]' : ''
    }${
      mode ? ` [mode=${mode}]` : ''
    }${
      limitParam !== null ? ` [offset=${offsetParam} limit=${limitParam}]` : ''
    }…`
  );

  // ── Fetch Shopify data ────────────────────────────────────────────────
  // Chunked mode=listed skips the full Shopify scan and looks up each SKU
  // directly — reducing the per-chunk Shopify fetch from ~90s to ~30s.
  const isChunkedListed = mode === 'listed' && limitParam !== null;

  let items: SyncItem[];
  let listedSkuCount: number | undefined;
  let totalListed = 0;
  // Tracks listed SKUs whose bare twin has no active ct-sync Shopify variant —
  // these are zeroed (not dropped) so their Walmart listing is corrected.
  let zeroedNoActiveMatch = 0;

  if (isChunkedListed) {
    try {
      console.log('🔍 [chunked] Fetching Walmart SKU list + active Shopify variants…');
      // Fetch both in parallel: Walmart listed set + active ct-sync variant map.
      // The active map is the sole quantity source — /variants.json is NOT used
      // because it returns variants from archived/draft products, causing the
      // qty-source bug that re-armed 360 oversell vectors in June 2026.
      const [allListedSkus, activeVariantMap] = await Promise.all([
        fetchListedSkus(),
        fetchActiveCtSyncVariants(),
      ]);

      const listedSkusArray = [...allListedSkus];
      totalListed    = listedSkusArray.length;
      listedSkuCount = totalListed;

      const chunkSkus = listedSkusArray.slice(offsetParam, offsetParam + (limitParam as number));
      console.log(`🔍 [chunked] ${chunkSkus.length} SKUs in chunk (offset ${offsetParam}, limit ${limitParam} of ${totalListed}); active Shopify variants: ${activeVariantMap.size}`);

      items = [];
      for (const walmartSku of chunkSkus) {
        // Normalise to bare SKU for the active-variant map lookup.
        const bareSku = walmartSku.startsWith('TIRE-') ? walmartSku.slice(5) : walmartSku;
        const activeVariant = activeVariantMap.get(bareSku);

        if (activeVariant != null) {
          // Active ct-sync variant exists — use its real inventory quantity.
          const shopifyQty = Math.max(0, activeVariant.inventoryQuantity ?? 0);
          items.push({
            sku:        walmartSku,
            price:      activeVariant.price ?? 0,
            cost:       activeVariant.cost,
            ctCost:     activeVariant.ctCost,
            shopifyQty,
            walmartQty: shopifyQty,
          });
        } else {
          // No active ct-sync variant — archived, draft, or no Shopify product.
          // Push qty 0 (safe correction) rather than omitting the SKU entirely.
          // Omitting would leave the Walmart listing at its current (possibly
          // re-armed default-100) value; zeroing is always the safe path.
          zeroedNoActiveMatch++;
          items.push({
            sku:        walmartSku,
            price:      0,
            cost:       null,
            ctCost:     null,
            shopifyQty: 0,
            walmartQty: 0,
          });
        }
      }

      console.log(`[chunked] built ${items.length} items; zeroedNoActiveMatch=${zeroedNoActiveMatch}`);
    } catch (err: any) {
      console.error('❌ Chunked listed fetch failed:', err.message);
      return res.status(500).json({ error: 'Chunked fetch failed', details: err.message });
    }
  } else {
    try {
      const shopifyStart = Date.now();
      items = await fetchTireVariants();
      console.log(`Shopify fetch complete: ${items.length} variants in ${((Date.now() - shopifyStart) / 1000).toFixed(1)}s`);
    } catch (err: any) {
      console.error('❌ Shopify fetch failed:', err.message);
      return res.status(500).json({ error: 'Shopify fetch failed', details: err.message });
    }
  }

  // ── mode=sku-sample: inspect raw SKU formats from both sides, no writes ─
  if (mode === 'sku-sample') {
    let listedSkus: Set<string>;
    try {
      console.log('🔍 Fetching Walmart-listed SKUs for sku-sample…');
      listedSkus = await fetchListedSkus();
    } catch (err: any) {
      console.error('❌ Walmart items fetch failed:', err.message);
      return res.status(500).json({ error: 'Walmart items fetch failed', details: err.message });
    }

    const walmartArray = [...listedSkus];
    const matched = items.filter(i => listedSkus.has(i.sku)).length;

    return res.status(200).json({
      walmartTotal:  listedSkus.size,
      shopifyTotal:  items.length,
      matched,
      walmartSample: walmartArray.slice(0, 10),
      shopifySample: items.slice(0, 10).map(i => i.sku),
    });
  }

  // ── mode=audit: compare Walmart vs Shopify SKUs, no writes ───────────
  if (mode === 'audit') {
    let listedSkus: Set<string>;
    try {
      console.log('🔍 Fetching Walmart-listed SKUs for audit…');
      listedSkus = await fetchListedSkus();
    } catch (err: any) {
      console.error('❌ Walmart items fetch failed:', err.message);
      return res.status(500).json({ error: 'Walmart items fetch failed', details: err.message });
    }

    const shopifySkus = new Set(items.map(i => i.sku).filter(Boolean));
    const matched     = [...listedSkus].filter(s => shopifySkus.has(s)).length;

    return res.status(200).json({
      walmartTotal:      listedSkus.size,
      shopifyTotal:      shopifySkus.size,
      matched,
      unmatchedWalmart:  [...listedSkus].filter(s => !shopifySkus.has(s)).slice(0, 20),
      unmatchedShopify:  [...shopifySkus].filter(s => !listedSkus.has(s)).slice(0, 20),
    });
  }

  if (items.length === 0) {
    return res.status(200).json({ ok: true, message: 'No variants found', synced: 0 });
  }

  // ── mode=listed (full scan): filter to only Walmart-listed SKUs ─────
  if (mode === 'listed' && limitParam === null) {
    try {
      console.log('🔍 Fetching Walmart-listed SKUs…');
      const listedSkus      = await fetchListedSkus();
      const listedSkusArray = [...listedSkus];
      totalListed           = listedSkusArray.length;
      listedSkuCount        = totalListed;

      const skusToProcess: Set<string> = limitParam !== null
        ? new Set(listedSkusArray.slice(offsetParam, offsetParam + limitParam))
        : listedSkus;

      const before = items.length;
      items = items.filter(i => skusToProcess.has(i.sku));
      console.log(
        `🔍 listed filter: ${items.length}/${before} Shopify variants matched` +
        (limitParam !== null
          ? ` (chunk [${offsetParam}–${offsetParam + limitParam}) of ${totalListed} Walmart listings)`
          : ` ${totalListed} Walmart listings`)
      );
    } catch (err: any) {
      console.error('❌ Walmart items fetch failed:', err.message);
      return res.status(500).json({ error: 'Walmart items fetch failed', details: err.message });
    }
  }

  // ── Enrich with cost (LAYER 1 floor needs it) ───────────────────────
  // Cost lives on InventoryItem.unitCost in GraphQL. For the chunked listed
  // path cost is already attached from fetchActiveCtSyncVariants(); this
  // enrichment step only runs for the full-scan (fetchTireVariants) path.
  if (!isChunkedListed) {
    try {
      const variantMap = await fetchAllShopifyVariants();
      for (const i of items) {
        const v = variantMap.get(i.sku) ?? variantMap.get(i.sku.replace(/^TIRE-/, ''));
        i.cost = v?.cost ?? null;
        i.ctCost = v?.ctCost ?? null;
      }
      const withCost = items.filter(i => i.cost != null).length;
      console.log(`💲 Cost enrichment: ${withCost}/${items.length} variants have a cost`);
    } catch (err: any) {
      console.error('❌ Cost enrichment failed (prices will be skipped without cost):', err.message);
    }
  }

  // Suppression removed: an in-stock SKU is never zeroed. This stays as a
  // backstop assertion — it must always be 0 now. `zeroStock` reports the
  // SKUs sent 0 because Shopify genuinely shows 0.
  const safetyZeroed = items.filter(i => i.shopifyQty > 0 && i.walmartQty === 0).length;
  const zeroStock    = items.filter(i => i.shopifyQty === 0).length;
  console.log(`📦 Inventory: ${zeroStock} at zero (Shopify shows 0); suppressed-in-stock=${safetyZeroed} (must be 0)`);

  // ── Dry run ───────────────────────────────────────────────────
  if (isDry) {
    return res.status(200).json({
      dryRun:       true,
      total:        items.length,
      safetyZeroed,
      zeroStock,
      zeroedNoActiveMatch,
      ...(listedSkuCount !== undefined ? { listedSkuCount } : {}),
      sample:       items.slice(0, 5).map(i => ({
        sku:        i.sku,
        price:      i.price,
        cost:       i.cost,
        safePrice:  safeWalmartPrice({ shopifyPrice: i.price, cost: i.cost }),
        shopifyQty: i.shopifyQty,
        walmartQty: i.walmartQty,
      })),
    });
  }

  // ── Push to Walmart ──────────────────────────────────────────────
  // Exposure hold: skip the price write for any SKU where the price we'd push
  // is below (true CT cost × floor) — i.e. a halved/suspect stored cost would
  // leave us under true cost. Inventory is still pushed. Mirrors reconcile's
  // holdExposed; auto-releases once the stored Shopify cost is corrected.
  const isExposed = (i: SyncItem): boolean => {
    if (i.ctCost == null || i.ctCost <= 0) return false;
    const safe = safeWalmartPrice({ shopifyPrice: i.price, cost: i.cost });
    return safe != null && safe < i.ctCost * PRICE_FLOOR_MULTIPLIER;
  };
  // heldExposed: stored Shopify price is below true CT cost × floor (suspect cost); price write
  // skipped until the stored cost is corrected. Inventory IS still pushed for these SKUs —
  // only the price write is held, never the quantity write.
  const heldExposed: string[] = items.filter(isExposed).map(i => i.sku);
  if (heldExposed.length) {
    console.log(`⏸️  Exposure-held (price skipped, suspect cost): ${heldExposed.length} SKUs`);
  }

  const priceItems:     WalmartPriceItem[]     = items.filter(i => !isExposed(i)).map(i => ({ sku: i.sku, price: i.price, cost: i.cost }));
  const inventoryItems: WalmartInventoryItem[] = items.map(i => ({ sku: i.sku, quantity: i.walmartQty }));

  let totalPriceSuccess     = 0;
  let totalPriceFailed      = 0;
  let totalInventorySuccess = 0;
  let totalInventoryFailed  = 0;
  const skippedNoCost: string[] = [];
  const errors: string[]    = [];

  const walmartStart = Date.now();

  for (const chunk of chunkArray(priceItems, WALMART_CHUNK)) {
    try {
      const result = await bulkPriceFeed(chunk);
      totalPriceSuccess += result.success;
      totalPriceFailed  += result.failed;
      if (result.skippedNoCost) skippedNoCost.push(...result.skippedNoCost);
    } catch (err: any) {
      errors.push(`price chunk: ${err.message}`);
    }
    await delay(500);
  }

  for (const chunk of chunkArray(inventoryItems, WALMART_CHUNK)) {
    try {
      const result = await bulkInventoryFeed(chunk);
      totalInventorySuccess += result.success;
      totalInventoryFailed  += result.failed;
    } catch (err: any) {
      errors.push(`inventory chunk: ${err.message}`);
    }
    await delay(500);
  }

  const walmartSecs = ((Date.now() - walmartStart) / 1000).toFixed(1);
  console.log(`Walmart calls complete: ${totalPriceSuccess + totalInventorySuccess} succeeded, ${totalPriceFailed + totalInventoryFailed} failed in ${walmartSecs}s`);

  const durationMs      = Date.now() - start;
  const priceResult     = { success: totalPriceSuccess,     failed: totalPriceFailed };
  const inventoryResult = { success: totalInventorySuccess, failed: totalInventoryFailed };
  console.log(`✅ Walmart sync done in ${durationMs}ms`);

  // ── Chunked response ───────────────────────────────────────────────
  if (limitParam !== null) {
    const nextOffset = offsetParam + limitParam < totalListed ? offsetParam + limitParam : null;
    return res.status(errors.length > 0 ? 207 : 200).json({
      ok:             errors.length === 0,
      processed:      items.length,
      offset:         offsetParam,
      limit:          limitParam,
      nextOffset,
      done:           nextOffset === null,
      zeroedNoActiveMatch,
      priceResult,
      inventoryResult,
      skippedNoCostCount: skippedNoCost.length,
      skippedNoCost:      skippedNoCost.slice(0, 100),
      heldExposedCount:   heldExposed.length,
      heldExposed:        heldExposed.slice(0, 100),
      durationMs,
      ...(errors.length ? { errors } : {}),
    });
  }

  // ── Full-catalogue response ──────────────────────────────────────────
  return res.status(errors.length > 0 ? 207 : 200).json({
    ok:              errors.length === 0,
    totalVariants:   items.length,
    safetyZeroed,
    zeroStock,
    ...(listedSkuCount !== undefined ? { listedSkuCount } : {}),
    priceResult,
    inventoryResult,
    skippedNoCostCount: skippedNoCost.length,
    skippedNoCost:      skippedNoCost.slice(0, 100),
    heldExposedCount:   heldExposed.length,
    heldExposed:        heldExposed.slice(0, 100),
    durationMs,
    ...(errors.length ? { errors } : {}),
  });
}

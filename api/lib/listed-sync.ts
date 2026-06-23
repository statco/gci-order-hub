// api/lib/listed-sync.ts
// ─────────────────────────────────────────────────────────────
// Shared core for mode=listed chunked sync.
//
// runListedSyncChunk() is the ONLY place that builds SyncItems from the
// Walmart listed set + active Shopify variants and pushes price/inventory
// to Walmart. Both api/walmart-sync.ts (the original endpoint) and
// api/walmart-sync-cursor.ts (the cursor-driven cron) call this function —
// neither implements its own fetch/write logic.
//
// Fix A invariant: quantity comes exclusively from fetchActiveCtSyncVariants().
// A missing active variant → qty 0 (zeroed, not skipped).
// ─────────────────────────────────────────────────────────────

import {
  bulkPriceFeed,
  bulkInventoryFeed,
  fetchListedSkus,
  chunkArray,
  type WalmartPriceItem,
  type WalmartInventoryItem,
} from './walmart-client';
import { fetchActiveCtSyncVariants } from './shopify';
import { safeWalmartPrice, PRICE_FLOOR_MULTIPLIER } from './pricing';

const WALMART_CHUNK = 1_000;

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export interface SyncItem {
  sku:        string;
  price:      number;
  cost:       number | null;
  ctCost:     number | null;
  shopifyQty: number;
  walmartQty: number;
}

export interface ChunkResult {
  /** Full item list for the chunk — exposed for caller dry-run inspection. */
  items:               SyncItem[];
  totalListed:         number;
  processed:           number;
  offset:              number;
  limit:               number;
  nextOffset:          number | null;
  done:                boolean;
  zeroedNoActiveMatch: number;
  heldExposed:         string[];
  skippedNoCost:       string[];
  /** null when dry=true — no Walmart calls are made. */
  priceResult:         { success: number; failed: number } | null;
  /** null when dry=true — no Walmart calls are made. */
  inventoryResult:     { success: number; failed: number } | null;
  errors:              string[];
  durationMs:          number;
}

export async function runListedSyncChunk(opts: {
  offset: number;
  limit:  number;
  dry:    boolean;
}): Promise<ChunkResult> {
  const { offset, limit, dry } = opts;
  const start = Date.now();

  console.log('🔍 [listed-sync] Fetching Walmart SKU list + active Shopify variants…');
  const [allListedSkus, activeVariantMap] = await Promise.all([
    fetchListedSkus(),
    fetchActiveCtSyncVariants(),
  ]);

  const listedSkusArray = [...allListedSkus];
  const totalListed     = listedSkusArray.length;
  const chunkSkus       = listedSkusArray.slice(offset, offset + limit);
  const nextOffset      = offset + limit < totalListed ? offset + limit : null;
  const done            = nextOffset === null;

  console.log(
    `🔍 [listed-sync] ${chunkSkus.length} SKUs in chunk` +
    ` (offset ${offset}, limit ${limit} of ${totalListed});` +
    ` active Shopify variants: ${activeVariantMap.size}`
  );

  let zeroedNoActiveMatch = 0;
  const items: SyncItem[] = [];

  for (const walmartSku of chunkSkus) {
    const bareSku       = walmartSku.startsWith('TIRE-') ? walmartSku.slice(5) : walmartSku;
    const activeVariant = activeVariantMap.get(bareSku);

    if (activeVariant != null) {
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
      // No active ct-sync variant → zero Walmart qty (safe correction).
      // Never omit the SKU: omitting leaves Walmart at whatever qty it has
      // (potentially the re-armed default-100 that caused the June 2026 incident).
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

  console.log(`[listed-sync] built ${items.length} items; zeroedNoActiveMatch=${zeroedNoActiveMatch}`);

  const isExposed = (i: SyncItem): boolean => {
    if (i.ctCost == null || i.ctCost <= 0) return false;
    const safe = safeWalmartPrice({ shopifyPrice: i.price, cost: i.cost });
    return safe != null && safe < i.ctCost * PRICE_FLOOR_MULTIPLIER;
  };

  // heldExposed: price write skipped (suspect cost); inventory IS still pushed.
  const heldExposed: string[] = items.filter(isExposed).map(i => i.sku);
  if (heldExposed.length) {
    console.log(`⏸️  [listed-sync] Exposure-held (price skipped, suspect cost): ${heldExposed.length} SKUs`);
  }

  if (dry) {
    return {
      items,
      totalListed,
      processed:           items.length,
      offset,
      limit,
      nextOffset,
      done,
      zeroedNoActiveMatch,
      heldExposed,
      skippedNoCost:  [],
      priceResult:    null,
      inventoryResult: null,
      errors:          [],
      durationMs:      Date.now() - start,
    };
  }

  // ── Push to Walmart ───────────────────────────────────────────────────────
  const priceItems:     WalmartPriceItem[]     = items.filter(i => !isExposed(i)).map(i => ({ sku: i.sku, price: i.price, cost: i.cost }));
  const inventoryItems: WalmartInventoryItem[] = items.map(i => ({ sku: i.sku, quantity: i.walmartQty }));

  let totalPriceSuccess     = 0;
  let totalPriceFailed      = 0;
  let totalInventorySuccess = 0;
  let totalInventoryFailed  = 0;
  const skippedNoCost: string[] = [];
  const errors: string[]        = [];

  for (const chunk of chunkArray(priceItems, WALMART_CHUNK)) {
    try {
      const result = await bulkPriceFeed(chunk);
      totalPriceSuccess += result.success;
      totalPriceFailed  += result.failed;
      if (result.skippedNoCost) skippedNoCost.push(...result.skippedNoCost);
    } catch (err: unknown) {
      errors.push(`price chunk: ${err instanceof Error ? err.message : String(err)}`);
    }
    await delay(500);
  }

  for (const chunk of chunkArray(inventoryItems, WALMART_CHUNK)) {
    try {
      const result = await bulkInventoryFeed(chunk);
      totalInventorySuccess += result.success;
      totalInventoryFailed  += result.failed;
    } catch (err: unknown) {
      errors.push(`inventory chunk: ${err instanceof Error ? err.message : String(err)}`);
    }
    await delay(500);
  }

  console.log(
    `[listed-sync] Walmart calls complete:` +
    ` price ${totalPriceSuccess}ok/${totalPriceFailed}fail,` +
    ` inv ${totalInventorySuccess}ok/${totalInventoryFailed}fail`
  );

  return {
    items,
    totalListed,
    processed:           items.length,
    offset,
    limit,
    nextOffset,
    done,
    zeroedNoActiveMatch,
    heldExposed,
    skippedNoCost,
    priceResult:     { success: totalPriceSuccess,     failed: totalPriceFailed     },
    inventoryResult: { success: totalInventorySuccess, failed: totalInventoryFailed },
    errors,
    durationMs: Date.now() - start,
  };
}

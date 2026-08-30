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
import { safeWalmartPrice } from './pricing';
import type { TireType } from './pricing/landedCost';

const WALMART_CHUNK = 1_000;

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export interface SyncItem {
  sku:        string;
  price:      number;
  cost:       number | null;
  ctCost:     number | null;
  shopifyQty: number;
  walmartQty: number;
  tireType:   TireType | null;   // real freight class — see parseTireSpecFromTags()
  rimSize:    number | null;     // real rim size — see parseTireSpecFromTags()
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
        tireType:   activeVariant.tireType,
        rimSize:    activeVariant.rimSize,
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
        tireType:   null,
        rimSize:    null,
      });
    }
  }

  console.log(`[listed-sync] built ${items.length} items; zeroedNoActiveMatch=${zeroedNoActiveMatch}`);

  // ── Price resolution — THE single canonical pricing decision ───────────
  // CHANGED 2026-08-30: previously pushed the raw Shopify price directly and
  // used safeWalmartPrice() only as a binary exposure-hold gate (skip the
  // whole write if the computed safe price looked suspect vs ctCost). That
  // meant the price actually sent to Walmart was NEVER the floor-aware safe
  // value — it was always Shopify's raw price, or nothing at all. This is
  // what let 261/318 live SKUs drift to being 15-50%+ overpriced on Walmart
  // (stale prices frozen during the Aug 26-28 outage, never corrected by
  // the normal sync because "not exposed" just meant "push the stale raw
  // price again unchanged").
  //
  // Fixed: safeWalmartPrice() - max(real Shopify price, real landed-cost
  // floor), using real tireType/rimSize - is now the ONLY value ever pushed
  // to Walmart. This is the same formula api/walmart-price-audit.ts used
  // for its one-off corrections; that tool's write capability has been
  // removed (see that file) now that this path computes the identical,
  // correct price automatically every 2 minutes via the cursor. There is
  // now exactly one place in this codebase that decides a Walmart price.
  //
  // Hold (skip the price write, inventory still pushes) ONLY when cost is
  // genuinely unknown - safeWalmartPrice() returns null and there is no
  // safe price to compute, not "the price looked suspiciously low."
  const resolved = items.map(i => {
    const finalPrice = safeWalmartPrice({
      shopifyPrice: i.price, cost: i.cost, tireType: i.tireType, rimSize: i.rimSize,
    });
    return { item: i, finalPrice };
  });

  const heldNoCost: string[] = resolved.filter(r => r.finalPrice == null).map(r => r.item.sku);
  if (heldNoCost.length) {
    console.log(`⏸️  [listed-sync] Held (cost unknown, cannot compute a safe price): ${heldNoCost.length} SKUs`);
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
      heldExposed:    heldNoCost,
      skippedNoCost:  [],
      priceResult:    null,
      inventoryResult: null,
      errors:          [],
      durationMs:      Date.now() - start,
    };
  }

  // ── Push to Walmart ───────────────────────────────────────────────────────
  const priceItems:     WalmartPriceItem[]     = resolved
    .filter((r): r is { item: SyncItem; finalPrice: number } => r.finalPrice != null)
    .map(r => ({ sku: r.item.sku, price: r.finalPrice, cost: r.item.cost, tireType: r.item.tireType, rimSize: r.item.rimSize }));
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
    heldExposed: heldNoCost,
    skippedNoCost,
    priceResult:     { success: totalPriceSuccess,     failed: totalPriceFailed     },
    inventoryResult: { success: totalInventorySuccess, failed: totalInventoryFailed },
    errors,
    durationMs: Date.now() - start,
  };
}

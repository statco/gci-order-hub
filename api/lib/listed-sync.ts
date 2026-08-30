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
  // CHANGED 2026-08-30: previously pushed the raw Shopify price directly;
  // safeWalmartPrice()'s return value was computed but never actually sent
  // — bulkPriceFeed() recomputes and writes its own safe price internally
  // regardless of what's passed as `price`, so the real write path was
  // already floor-aware even before this change. What WAS missing upstream
  // (fixed in gci-order-hub#82, merged) was real tireType/rimSize on that
  // computation — every caller defaulted to the most conservative (LT,
  // rim 22) fallback, inflating floors well above real Shopify prices.
  // That's what let 261/318 live SKUs drift to being 15-50%+ overpriced.
  //
  // This pass makes the resolved price explicit here too (still the same
  // value bulkPriceFeed() would compute) so this file's own hold logic can
  // reason about it directly, and so api/walmart-price-audit.ts's write
  // capability — a second, independent place that could compute and push a
  // price — could be removed entirely (see that file) now that this is
  // unambiguously the one place that decides a Walmart price.
  //
  // Hold (skip the price write, inventory still pushes) when EITHER:
  //   - cost is genuinely unknown — safeWalmartPrice() returns null, or
  //   - cost is known but looks corrupted: the computed price sits below
  //     (true CT dealer cost × floor) per the *independent* ctCost
  //     metafield. This catches a stored Shopify unitCost that's wrong
  //     (halved, bad sync, wrong decimal) even when tireType/rimSize are
  //     both correct — a different failure mode than the one above, and
  //     the only real-time guard against it (cost-integrity-audit.ts is a
  //     daily REPORT, not a write-blocking gate — see its own header).
  const resolved = items.map(i => {
    const finalPrice = safeWalmartPrice({
      shopifyPrice: i.price, cost: i.cost, tireType: i.tireType, rimSize: i.rimSize,
    });
    const suspectCost = finalPrice != null && i.ctCost != null && i.ctCost > 0
      && finalPrice < i.ctCost * PRICE_FLOOR_MULTIPLIER;
    return { item: i, finalPrice: suspectCost ? null : finalPrice, suspectCost };
  });

  const heldNoCost: string[] = resolved.filter(r => r.finalPrice == null && !r.suspectCost).map(r => r.item.sku);
  const heldSuspectCost: string[] = resolved.filter(r => r.suspectCost).map(r => r.item.sku);
  if (heldNoCost.length) {
    console.log(`⏸️  [listed-sync] Held (cost unknown, cannot compute a safe price): ${heldNoCost.length} SKUs`);
  }
  if (heldSuspectCost.length) {
    console.log(`⏸️  [listed-sync] Held (suspect cost — computed price below true CT cost × floor): ${heldSuspectCost.length} SKUs`);
  }
  const heldExposed = [...heldNoCost, ...heldSuspectCost];

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
      heldExposed:    heldExposed,
      skippedNoCost:  [],
      priceResult:    null,
      inventoryResult: null,
      errors:          [],
      durationMs:      Date.now() - start,
    };
  }

  // ── Push to Walmart ───────────────────────────────────────────────────────
  const priceItems:     WalmartPriceItem[]     = resolved
    .filter((r): r is { item: SyncItem; finalPrice: number; suspectCost: boolean } => r.finalPrice != null)
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
    heldExposed: heldExposed,
    skippedNoCost,
    priceResult:     { success: totalPriceSuccess,     failed: totalPriceFailed     },
    inventoryResult: { success: totalInventorySuccess, failed: totalInventoryFailed },
    errors,
    durationMs: Date.now() - start,
  };
}

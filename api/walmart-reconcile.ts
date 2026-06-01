/**
 * api/walmart-reconcile.ts
 *
 * LAYER 2 — Full daily reconciliation.
 *
 * Once a day, force Walmart to match Shopify on BOTH price and inventory
 * for every matched SKU — using Layer 1's cost floor for price.
 *
 *   GET /api/walmart-reconcile?dryRun=true        — report only, no writes
 *   GET /api/walmart-reconcile                    — reconcile (default page)
 *   GET /api/walmart-reconcile?offset=N&limit=M   — paginated
 *   (cron, x-vercel-cron: 1)                      — process everything in one run
 *
 * Price flows through safeWalmartPrice() (the ONLY sanctioned write path):
 * below-cost prices are structurally impossible, missing-cost SKUs are
 * skipped + logged. Inventory pushes the real Shopify quantity: only a
 * genuine Shopify stock of 0 sends 0 to Walmart. (The previous "< 4 → 0"
 * low-stock suppression was removed — it hid live stock and suppressed sales.)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { walmartFetch, updatePrice, updateInventory } from './lib/walmart-client.js';
import { fetchAllShopifyVariants } from './lib/shopify.js';
import { safeWalmartPrice, PRICE_FLOOR_MULTIPLIER } from './lib/pricing.js';
import { sendTelegramMessage } from './lib/telegram.js';

const PAGE_SIZE         = 200;
const PRICE_EPSILON     = 0.01;  // treat sub-cent differences as equal
const WRITE_CONCURRENCY = 6;     // parallel Walmart writes per batch

// ─── Walmart: list every published+active item with its current price ──────────

async function fetchWalmartItems(): Promise<Array<{ sku: string; price: number | null }>> {
  const items: Array<{ sku: string; price: number | null }> = [];

  const collect = (data: any): number => {
    const page: any[] = data?.ItemResponse ?? data?.items ?? [];
    for (const item of page) {
      const sku = (item.sku ?? item.mart?.sku ?? '').toUpperCase();
      const price =
        item.price?.currentPrice?.price ??
        item.price?.amount ??
        item.pricing?.[0]?.currentPrice?.amount ??
        item.currentPrice?.amount ??
        null;
      if (sku) items.push({ sku, price: price != null ? parseFloat(price) : null });
    }
    return page.length;
  };

  const pageUrl = (offset: number) =>
    `/v3/items?limit=${PAGE_SIZE}&offset=${offset}&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`;

  // Page 1 first to learn totalItems, then fetch the remaining pages in parallel.
  const first: any = await walmartFetch<any>(pageUrl(0));
  const firstCount = collect(first);
  const totalItems = first?.totalItems ?? firstCount;

  const offsets: number[] = [];
  for (let o = PAGE_SIZE; o < totalItems; o += PAGE_SIZE) offsets.push(o);

  const FETCH_CONCURRENCY = 5;
  for (let i = 0; i < offsets.length; i += FETCH_CONCURRENCY) {
    const batch = offsets.slice(i, i + FETCH_CONCURRENCY);
    const pages = await Promise.all(batch.map(o => walmartFetch<any>(pageUrl(o))));
    pages.forEach(collect);
  }

  return items;
}

// ─── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dryRun = req.query.dryRun === 'true';
  const isCron = req.headers['x-vercel-cron'] === '1';
  const offset = parseInt((req.query.offset as string) ?? '0', 10) || 0;
  const limit  = isCron ? 99999 : (parseInt((req.query.limit as string) ?? '500', 10) || 500);
  // Hold (skip the price write for) only SKUs that are actually EXPOSED: where
  // the price we'd push is below (true CT cost × floor multiplier). A halved /
  // suspect stored cost only matters when it leaves us under true cost; a
  // divergent SKU whose Shopify price already covers true cost is safe to push.
  // Inventory is still pushed for held SKUs. Default ON; holdExposed=false to override.
  const holdExposed = req.query.holdExposed !== 'false';

  try {
    console.log('[reconcile] Fetching Shopify variants + Walmart listed items in parallel…');
    const [shopify, walmartItems] = await Promise.all([
      fetchAllShopifyVariants(),
      fetchWalmartItems(),
    ]);
    console.log(`[reconcile] ${shopify.size} Shopify variants, ${walmartItems.length} Walmart listed items`);

    // Only operate on SKUs that exist on both sides.
    const matched = walmartItems.filter(w => shopify.has(w.sku));
    const page    = matched.slice(offset, offset + limit);

    let priceCorrected     = 0;
    let inventoryCorrected = 0;
    const skippedNoCost: string[]                 = [];
    const heldExposed: Array<{
      sku: string; shopifyPrice: number | null; storedCost: number | null;
      ctCost: number | null; requiredFloor: number; wouldPush: number;
    }> = [];
    const errors: Array<{ sku: string; error: string }> = [];

    // Process one matched SKU: correct price (unless held) + push inventory.
    async function processSku(w: { sku: string; price: number | null }): Promise<void> {
      const sv = shopify.get(w.sku)!;

      // ── Price (Layer 1 floor + hold-exposed guard) ─────────────────────
      const safe = safeWalmartPrice({ shopifyPrice: sv.price, cost: sv.cost });
      if (safe == null) {
        skippedNoCost.push(w.sku);
      } else {
        // Exposed = the price we'd push doesn't cover TRUE CT cost × floor.
        const requiredFloor =
          sv.ctCost != null && sv.ctCost > 0 ? sv.ctCost * PRICE_FLOOR_MULTIPLIER : null;
        const exposed = requiredFloor != null && safe < requiredFloor - PRICE_EPSILON;

        if (holdExposed && exposed) {
          heldExposed.push({
            sku: w.sku, shopifyPrice: sv.price, storedCost: sv.cost,
            ctCost: sv.ctCost, requiredFloor: parseFloat(requiredFloor!.toFixed(2)), wouldPush: safe,
          });
        } else if (w.price == null || Math.abs(safe - w.price) >= PRICE_EPSILON) {
          if (!dryRun) {
            try {
              const written = await updatePrice({ sku: w.sku, price: sv.price ?? safe, cost: sv.cost });
              if (written) priceCorrected++;
            } catch (e: unknown) {
              errors.push({ sku: w.sku, error: e instanceof Error ? e.message : String(e) });
            }
          } else {
            priceCorrected++;
          }
        }
      }

      // ── Inventory ──────────────────────────────────────────────────────
      // Push the real Shopify quantity. No low-stock suppression: 0 is sent
      // only when Shopify genuinely shows 0 (Math.max guards negatives/nulls).
      const shopifyQty = Math.max(0, sv.inventoryQuantity ?? 0);
      const walmartQty = shopifyQty;
      if (!dryRun) {
        try {
          await updateInventory({ sku: w.sku, quantity: walmartQty });
          inventoryCorrected++;
        } catch (e: unknown) {
          errors.push({ sku: w.sku, error: e instanceof Error ? e.message : String(e) });
        }
      } else {
        inventoryCorrected++;
      }
    }

    // Bounded-concurrency sweep so a paginated live run fits in the timeout.
    for (let i = 0; i < page.length; i += WRITE_CONCURRENCY) {
      await Promise.all(page.slice(i, i + WRITE_CONCURRENCY).map(processSku));
    }

    const nextOffset = offset + limit < matched.length ? offset + limit : null;

    console.log(
      `[reconcile] matched=${matched.length} paged=${page.length} priceCorrected=${priceCorrected} ` +
      `inventoryPushed=${inventoryCorrected} heldExposed=${heldExposed.length} ` +
      `skippedNoCost=${skippedNoCost.length} errors=${errors.length} dryRun=${dryRun}`,
    );

    // Telegram summary on completion of a live run (skip dry-runs and
    // intermediate pages of a manual paginated sweep). GCI Orders bot.
    if (!dryRun && nextOffset === null) {
      const errLine = errors.length
        ? `\n⚠️ <b>Errors:</b> ${errors.length}` +
          `\n${errors.slice(0, 5).map(e => `  • <code>${e.sku}</code>: ${e.error.slice(0, 80)}`).join('\n')}`
        : '';
      await sendTelegramMessage(
        `🔄 <b>Walmart Reconcile complete</b>\n` +
        `Matched SKUs: ${matched.length}\n` +
        `💰 Prices corrected: ${priceCorrected}\n` +
        `📦 Inventory pushed: ${inventoryCorrected}\n` +
        `🛑 Held (exposed): ${heldExposed.length}\n` +
        `❓ Skipped (no cost): ${skippedNoCost.length}` +
        errLine,
      );
    }

    return res.status(errors.length ? 207 : 200).json({
      dryRun,
      holdExposed,
      totalMatched:       matched.length,
      processed:          page.length,
      offset,
      limit,
      nextOffset,
      priceCorrected,
      inventoryCorrected,
      heldExposedCount:   heldExposed.length,
      heldExposed:        heldExposed.slice(0, 300),
      skippedNoCostCount: skippedNoCost.length,
      skippedNoCost:      skippedNoCost.slice(0, 200),
      errorCount:         errors.length,
      errors:             errors.slice(0, 50),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[reconcile] Error:', message);
    return res.status(500).json({ error: message });
  }
}

/**
 * api/walmart-reconcile.ts
 *
 * LAYER 2 — Full daily reconciliation.
 *
 * Once a day, force Walmart to match Shopify on BOTH price and inventory
 * for every matched SKU — mirroring Shopify variant.price directly.
 *
 *   GET /api/walmart-reconcile?dryRun=true        — report only, no writes
 *   GET /api/walmart-reconcile                    — reconcile (default page)
 *   GET /api/walmart-reconcile?offset=N&limit=M   — paginated
 *   (cron, x-vercel-cron: 1)                      — process everything in one run
 *
 * Price mirrors Shopify variant.price directly — SKUs with a null/zero price
 * are skipped and logged in skippedNoPrice. Inventory pushes the real Shopify
 * quantity only when it differs from the current Walmart quantity.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { walmartFetch, updateInventory } from './lib/walmart-client.js';
import { fetchAllShopifyVariants } from './lib/shopify.js';
import { sendTelegramMessage } from './lib/telegram.js';

const PAGE_SIZE         = 200;
const PRICE_EPSILON     = 0.01;  // treat sub-cent differences as equal
const WRITE_CONCURRENCY = 6;     // parallel Walmart writes per batch

// ─── Walmart: list every published+active item with its current price + inventory ─

interface WalmartItem {
  sku:               string;
  price:             number | null;
  inventoryQuantity: number | null;
}

async function fetchWalmartItems(): Promise<WalmartItem[]> {
  const items: WalmartItem[] = [];

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
      // Walmart CA /v3/items returns inventory as quantity.amount
      const qty = item.quantity?.amount ?? null;
      if (sku) items.push({
        sku,
        price:             price != null ? parseFloat(price) : null,
        inventoryQuantity: qty   != null ? Number(qty)       : null,
      });
    }
    return page.length;
  };

  const pageUrl = (offset: number) =>
    `/v3/items?limit=${PAGE_SIZE}&offset=${offset}&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`;

  // Page 1 first to learn totalItems, then fetch remaining pages in parallel.
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
    const skippedNoPrice: string[]                     = [];
    const errors: Array<{ sku: string; error: string }> = [];

    // Process one matched SKU: correct price + push inventory (only when different).
    async function processSku(w: WalmartItem): Promise<void> {
      const sv = shopify.get(w.sku)!;

      // ── Price (direct Shopify price mirror) ─────────────────────────────
      // Use walmartFetch directly — bypasses the safeWalmartPrice re-gate
      // inside updatePrice() which would skip writes when cost is null.
      const targetPrice = sv.price != null && sv.price > 0 ? sv.price : null;
      if (targetPrice == null) {
        skippedNoPrice.push(w.sku);
      } else if (w.price == null || Math.abs(targetPrice - w.price) >= PRICE_EPSILON) {
        if (!dryRun) {
          try {
            await walmartFetch<any>('/v3/price', {
              method: 'PUT',
              body: JSON.stringify({
                sku:     w.sku,
                pricing: [{
                  currentPriceType: 'BASE',
                  currentPrice: {
                    currency: 'CAD',
                    amount:   parseFloat(targetPrice.toFixed(2)),
                  },
                }],
              }),
            });
            priceCorrected++;
          } catch (e: unknown) {
            errors.push({ sku: w.sku, error: e instanceof Error ? e.message : String(e) });
          }
        } else {
          priceCorrected++;
        }
      }

      // ── Inventory ──────────────────────────────────────────────────────
      // Push only when Walmart's current quantity differs from Shopify's.
      // No low-stock suppression: 0 is sent only when Shopify genuinely shows 0.
      const shopifyQty  = Math.max(0, sv.inventoryQuantity ?? 0);
      const walmartQty  = w.inventoryQuantity;
      // If Walmart qty is unknown (not in API response) treat as needing update.
      const needsUpdate = walmartQty === null || walmartQty !== shopifyQty;
      if (needsUpdate) {
        if (!dryRun) {
          try {
            await updateInventory({ sku: w.sku, quantity: shopifyQty });
            inventoryCorrected++;
          } catch (e: unknown) {
            errors.push({ sku: w.sku, error: e instanceof Error ? e.message : String(e) });
          }
        } else {
          inventoryCorrected++;
        }
      }
    }

    // Bounded-concurrency sweep so a paginated live run fits in the timeout.
    for (let i = 0; i < page.length; i += WRITE_CONCURRENCY) {
      await Promise.all(page.slice(i, i + WRITE_CONCURRENCY).map(processSku));
    }

    const nextOffset = offset + limit < matched.length ? offset + limit : null;

    console.log(
      `[reconcile] matched=${matched.length} paged=${page.length} priceCorrected=${priceCorrected} ` +
      `inventoryPushed=${inventoryCorrected} skippedNoPrice=${skippedNoPrice.length} errors=${errors.length} dryRun=${dryRun}`,
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
        `❓ Skipped (no price): ${skippedNoPrice.length}` +
        errLine,
      );
    }

    return res.status(errors.length ? 207 : 200).json({
      dryRun,
      totalMatched:        matched.length,
      processed:           page.length,
      offset,
      limit,
      nextOffset,
      priceCorrected,
      inventoryCorrected,
      skippedNoPriceCount: skippedNoPrice.length,
      skippedNoPrice:      skippedNoPrice.slice(0, 200),
      errorCount:          errors.length,
      errors:              errors.slice(0, 50),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[reconcile] Error:', message);
    return res.status(500).json({ error: message });
  }
}

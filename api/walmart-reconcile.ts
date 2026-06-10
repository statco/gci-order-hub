/**
 * api/walmart-reconcile.ts
 *
 * LAYER 2 — Price reconciliation.
 *
 * Once a day, force Walmart to match Shopify variant.price for every
 * matched SKU. Inventory is handled by a separate cron/endpoint —
 * the Walmart CA /v3/items response does not include a quantity field
 * so inventory comparison is not possible from this data source.
 *
 *   GET /api/walmart-reconcile?dryRun=true        — report only, no writes
 *   GET /api/walmart-reconcile                    — reconcile (default page)
 *   GET /api/walmart-reconcile?offset=N&limit=M   — paginated
 *   (cron, x-vercel-cron: 1)                      — process everything in one run
 *
 * Price mirrors Shopify variant.price directly. SKUs with a null/zero
 * Shopify price are skipped and logged in skippedNoPrice.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { walmartFetch } from './lib/walmart-client.js';
import { fetchAllShopifyVariants } from './lib/shopify.js';
import { sendTelegramMessage } from './lib/telegram.js';

const PAGE_SIZE         = 200;
const PRICE_EPSILON     = 0.01;  // treat sub-cent differences as equal
const WRITE_CONCURRENCY = 6;     // parallel Walmart writes per batch

// ─── Walmart: list every published+active item with its current price ─────────
// Note: the CA /v3/items response shape is:
//   { mart, sku, wpid, upc, gtin, productName, shelf, productType,
//     price, publishedStatus, lifecycleStatus }
// There is no quantity/inventory field — inventory sync runs separately.

interface WalmartItem {
  sku:   string;
  price: number | null;
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
      if (sku) items.push({ sku, price: price != null ? parseFloat(price) : null });
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

// ─── Handler ──────────────────────────────────────────────────────────────────

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

    let priceCorrected = 0;
    const skippedNoPrice: string[]                     = [];
    const errors: Array<{ sku: string; error: string }> = [];

    async function processSku(w: WalmartItem): Promise<void> {
      const sv = shopify.get(w.sku)!;

      // Mirror Shopify price directly. Use walmartFetch directly to bypass
      // the safeWalmartPrice re-gate inside updatePrice() (which skips when
      // cost is null, blocking writes on most SKUs after the cost-floor removal).
      const targetPrice = sv.price != null && sv.price > 0 ? sv.price : null;
      if (targetPrice == null) {
        skippedNoPrice.push(w.sku);
        return;
      }

      if (w.price != null && Math.abs(targetPrice - w.price) < PRICE_EPSILON) {
        return; // already correct
      }

      if (!dryRun) {
        try {
          await walmartFetch<any>('/v3/price', {
            method: 'PUT',
            body: JSON.stringify({
              sku:     w.sku,
              pricing: [{
                currentPriceType: 'BASE',
                currentPrice: { currency: 'CAD', amount: parseFloat(targetPrice.toFixed(2)) },
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

    // Bounded-concurrency sweep so a paginated live run fits in the timeout.
    for (let i = 0; i < page.length; i += WRITE_CONCURRENCY) {
      await Promise.all(page.slice(i, i + WRITE_CONCURRENCY).map(processSku));
    }

    const nextOffset = offset + limit < matched.length ? offset + limit : null;

    console.log(
      `[reconcile] matched=${matched.length} paged=${page.length} ` +
      `priceCorrected=${priceCorrected} skippedNoPrice=${skippedNoPrice.length} ` +
      `errors=${errors.length} dryRun=${dryRun}`,
    );

    if (!dryRun && nextOffset === null) {
      const errLine = errors.length
        ? `\n⚠️ <b>Errors:</b> ${errors.length}` +
          `\n${errors.slice(0, 5).map(e => `  • <code>${e.sku}</code>: ${e.error.slice(0, 80)}`).join('\n')}`
        : '';
      await sendTelegramMessage(
        `🔄 <b>Walmart Reconcile complete</b>\n` +
        `Matched SKUs: ${matched.length}\n` +
        `💰 Prices corrected: ${priceCorrected}\n` +
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
      inventoryCorrected:  0,  // inventory sync runs separately (no qty in /v3/items response)
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

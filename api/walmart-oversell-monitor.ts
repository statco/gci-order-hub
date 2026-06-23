// api/walmart-oversell-monitor.ts
// ─────────────────────────────────────────────────────────────
// GET /api/walmart-oversell-monitor
//
// Read-only oversell monitor. Closes the blind spot that hid the 321
// bare listings at 100 during the June 2026 incident: the orphan probe
// only sees unmatched listings, while this endpoint inspects EVERY listed
// Walmart SKU — matched and orphan alike.
//
// For each SKU in the requested chunk:
//   • Fetches the live Walmart inventory quantity (GET /v3/inventory?sku=X)
//   • Resolves Shopify truth: active ct-sync variant quantity, or 0 if the
//     product is archived/draft/absent (same rule as Fix A / mode=listed).
//   • Flags the row as an oversell when walmartQty > shopifyQty.
//
// Also surfaces:
//   • reArmedOrphanCount — orphan SKUs (no active Shopify match) where
//     Walmart qty > 0. These were zeroed by the orphan sweep but re-armed
//     by external catalog ops. An alert condition even when oversellCount=0.
//   • heldExposed — SKUs where the stored price is below true CT cost × floor;
//     the sync skips the price write for these.
//   • skippedNoCost — SKUs where no cost is stored; the sync skips the price
//     write for these.
//
// No writes. No auth required (monitoring data).
//
// Query params:
//   ?offset=N  — start position in the listed-SKU set (default 0)
//   ?limit=N   — chunk size (default 50; ~78s per chunk at Walmart API latency)
//
// Walk the full catalogue by incrementing offset by limit until done:true.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchListedSkus, walmartFetch } from './lib/walmart-client';
import { fetchActiveCtSyncVariants } from './lib/shopify';
import { safeWalmartPrice, PRICE_FLOOR_MULTIPLIER } from './lib/pricing';

export const config = { maxDuration: 300 };

const DEFAULT_LIMIT = 50;

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWalmartQty(sku: string): Promise<number> {
  try {
    const data = await walmartFetch<any>(`/v3/inventory?sku=${encodeURIComponent(sku)}`);
    return Math.max(0, Number(data?.quantity?.amount ?? 0));
  } catch {
    // If the SKU can't be queried (e.g. just retired), treat as 0.
    return 0;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET or POST only' });
  }

  const offsetParam = parseInt((req.query.offset as string) ?? '0', 10) || 0;
  const limitParam  = parseInt((req.query.limit  as string) ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
  const start       = Date.now();

  console.log(`[oversell-monitor] Starting offset=${offsetParam} limit=${limitParam}`);

  // ── Fetch Walmart listed SKUs and active Shopify variant map in parallel ──
  let listedSkusSet:   Set<string>;
  let activeVariantMap: Awaited<ReturnType<typeof fetchActiveCtSyncVariants>>;

  try {
    [listedSkusSet, activeVariantMap] = await Promise.all([
      fetchListedSkus(),
      fetchActiveCtSyncVariants(),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[oversell-monitor] Fetch failed:', msg);
    return res.status(500).json({ error: 'Failed to fetch catalog data', details: msg });
  }

  const allListedSkus = [...listedSkusSet];
  const totalListed   = allListedSkus.length;
  const chunkSkus     = allListedSkus.slice(offsetParam, offsetParam + limitParam);
  const nextOffset    = offsetParam + limitParam < totalListed ? offsetParam + limitParam : null;
  const done          = nextOffset === null;

  console.log(`[oversell-monitor] ${totalListed} listed SKUs total; chunk ${chunkSkus.length} (offset ${offsetParam}); active Shopify: ${activeVariantMap.size}`);

  // ── Per-SKU analysis ────────────────────────────────────────────────────
  interface OversellRow {
    sku:        string;
    walmartQty: number;
    shopifyQty: number;
    delta:      number;
    isOrphan:   boolean; // no active Shopify match
  }

  const oversellRows:   OversellRow[] = [];
  const heldExposed:    string[]      = [];
  const skippedNoCost:  string[]      = [];
  let   checkedCount        = 0;
  let   reArmedOrphanCount  = 0;

  for (const walmartSku of chunkSkus) {
    const bareSku       = walmartSku.startsWith('TIRE-') ? walmartSku.slice(5) : walmartSku;
    const activeVariant = activeVariantMap.get(bareSku);
    const isOrphan      = activeVariant == null;

    const shopifyQty = isOrphan ? 0 : Math.max(0, activeVariant.inventoryQuantity ?? 0);
    const walmartQty = await fetchWalmartQty(walmartSku);

    checkedCount++;

    if (walmartQty > shopifyQty) {
      oversellRows.push({ sku: walmartSku, walmartQty, shopifyQty, delta: walmartQty - shopifyQty, isOrphan });
    }

    if (isOrphan && walmartQty > 0) {
      // Re-armed orphan: was zeroed by sweep but Walmart qty is back above 0.
      // External catalog ops (e.g. SKU rename) can re-arm these silently.
      reArmedOrphanCount++;
    }

    // Surface price-hold signals from the active variant (mirrors walmart-sync logic).
    if (!isOrphan && activeVariant) {
      if (activeVariant.cost == null) {
        skippedNoCost.push(walmartSku);
      } else {
        const ctCost = activeVariant.ctCost;
        if (ctCost != null && ctCost > 0) {
          const safe = safeWalmartPrice({ shopifyPrice: activeVariant.price ?? 0, cost: activeVariant.cost });
          if (safe != null && safe < ctCost * PRICE_FLOOR_MULTIPLIER) {
            heldExposed.push(walmartSku);
          }
        }
      }
    }

    // Brief pause to respect Walmart API rate limits.
    await delay(50);
  }

  // Sort sample by worst offenders (largest delta first), cap at 20.
  const sample = [...oversellRows]
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20);

  const oversellCount = oversellRows.length;

  // Alert conditions:
  //   oversellCount > 0    — Walmart qty exceeds active Shopify truth
  //   reArmedOrphanCount > 0 — orphan re-armed by external catalog op
  const alert = oversellCount > 0 || reArmedOrphanCount > 0;

  console.log(
    `[oversell-monitor] done: checked=${checkedCount} oversell=${oversellCount} ` +
    `reArmedOrphan=${reArmedOrphanCount} heldExposed=${heldExposed.length} ` +
    `skippedNoCost=${skippedNoCost.length} in ${Date.now() - start}ms`,
  );

  return res.status(200).json({
    ok:                   true,
    alert,
    totalListed,
    offset:               offsetParam,
    limit:                limitParam,
    nextOffset,
    done,
    checkedCount,
    oversellCount,
    reArmedOrphanCount,
    sample,
    heldExposedCount:     heldExposed.length,
    heldExposed:          heldExposed.slice(0, 100),
    skippedNoCostCount:   skippedNoCost.length,
    skippedNoCost:        skippedNoCost.slice(0, 100),
    durationMs:           Date.now() - start,
  });
}

/**
 * api/walmart-price-correct.ts
 *
 * LAYER 3 — Bulk correction pass for legacy "$285" stuck listings.
 *
 * Older item-feed submissions listed items at a flat $285 / $284.99 before the
 * cost-floor fix landed. This endpoint finds those still-stuck listings LIVE
 * from Walmart (the CSV in the brief is scoping context only — NOT the source
 * of truth) and corrects each one through safeWalmartPrice().
 *
 *   GET/POST /api/walmart-price-correct?dryRun=true      — preview, no writes
 *   GET/POST /api/walmart-price-correct                  — correct (default page)
 *   GET/POST /api/walmart-price-correct?offset=N&limit=M — paginated batches
 *   (cron, x-vercel-cron: 1)                             — correct everything
 *
 * Matching handles BOTH SKU forms: bare (200E1028) and TIRE- prefixed
 * (TIRE-200E1028). Unmatched SKUs are reported (feeds the ~662 unmatched
 * listings investigation). Price is ONLY ever written via safeWalmartPrice();
 * missing-cost and unmatched SKUs are skipped + logged, never guessed.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken, updatePrice } from './lib/walmart-client.js';
import { fetchAllShopifyVariants, type ShopifyVariantData } from './lib/shopify.js';
import { safeWalmartPrice } from './lib/pricing.js';
import { sendTelegramMessage } from './lib/telegram.js';

const WALMART_BASE = process.env.WALMART_BASE_URL!;
const PAGE_SIZE = 200;
const PRICE_EPSILON = 0.01;

// Legacy stuck prices to detect on the live listing.
const STUCK_PRICES = [285, 284.99];

function isStuckPrice(price: number | null): boolean {
  if (price == null || isNaN(price)) return false;
  return STUCK_PRICES.some((p) => Math.abs(price - p) < PRICE_EPSILON);
}

// ─── Walmart: collect every published item currently stuck at $285/$284.99 ──────

async function fetchStuckItems(token: string): Promise<Array<{ sku: string; price: number }>> {
  const stuck: Array<{ sku: string; price: number }> = [];
  let offset = 0;
  let totalItems = Infinity;

  while (offset < totalItems) {
    const res = await fetch(
      `${WALMART_BASE}/v3/items?limit=${PAGE_SIZE}&offset=${offset}&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`,
      {
        headers: {
          'WM_SEC.ACCESS_TOKEN':   token,
          'WM_GLOBAL_VERSION':     '3.1',
          'WM_MARKET':             'ca',
          'WM_SVC.NAME':           'Walmart Marketplace',
          'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
          Accept:                  'application/json',
        },
      }
    );

    if (!res.ok) throw new Error(`Walmart items API error: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();

    if (offset === 0) totalItems = data.totalItems ?? 0;

    const page: any[] = data.ItemResponse ?? data.items ?? [];
    if (page.length === 0) break;

    for (const item of page) {
      const sku = item.sku ?? item.mart?.sku ?? '';
      const raw =
        item.price?.currentPrice?.price ??
        item.price?.amount ??
        item.pricing?.[0]?.currentPrice?.amount ??
        item.currentPrice?.amount ??
        null;
      const price = raw != null ? parseFloat(raw) : null;
      if (sku && isStuckPrice(price)) stuck.push({ sku, price: price as number });
    }

    offset += PAGE_SIZE;
  }

  return stuck;
}

// ─── Dual-form Shopify match: try the SKU as-is, then toggle the TIRE- prefix ───

function matchShopify(
  walmartSku: string,
  shopify: Map<string, ShopifyVariantData>
): { key: string; variant: ShopifyVariantData } | null {
  const up = walmartSku.toUpperCase();
  const candidates = [up];
  if (up.startsWith('TIRE-')) candidates.push(up.slice(5));
  else candidates.push(`TIRE-${up}`);

  for (const key of candidates) {
    const variant = shopify.get(key);
    if (variant) return { key, variant };
  }
  return null;
}

// ─── Handler ────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dryRun = req.query.dryRun === 'true';
  const isCron = req.headers['x-vercel-cron'] === '1';
  const offset = parseInt((req.query.offset as string) ?? '0', 10) || 0;
  const limit = isCron ? 99999 : (parseInt((req.query.limit as string) ?? '300', 10) || 300);

  try {
    const token = await getWalmartToken();

    console.log('[price-correct] Fetching stuck ($285/$284.99) Walmart items + Shopify variants…');
    const [stuck, shopify] = await Promise.all([
      fetchStuckItems(token),
      fetchAllShopifyVariants(),
    ]);
    console.log(`[price-correct] ${stuck.length} stuck items, ${shopify.size} Shopify variants`);

    const page = stuck.slice(offset, offset + limit);

    let corrected = 0;
    const skippedUnmatched: string[] = [];
    const skippedNoCost: string[] = [];
    const errors: Array<{ sku: string; error: string }> = [];
    const correctedSample: Array<{ sku: string; from: number; to: number }> = [];

    for (const { sku, price } of page) {
      const match = matchShopify(sku, shopify);
      if (!match) {
        skippedUnmatched.push(sku);
        continue;
      }

      // safeWalmartPrice() is the ONLY sanctioned price computation. Missing
      // cost → null → skip (never guess, never default).
      const safe = safeWalmartPrice({ shopifyPrice: match.variant.price, cost: match.variant.cost });
      if (safe == null) {
        skippedNoCost.push(sku);
        continue;
      }

      if (correctedSample.length < 50) correctedSample.push({ sku, from: price, to: safe });

      if (dryRun) {
        corrected++;
        continue;
      }

      try {
        // updatePrice re-runs safeWalmartPrice + assertAboveCost internally and
        // writes to the live Walmart SKU. Returns false only on missing cost
        // (already filtered above), so a true response means written.
        const written = await updatePrice({
          sku,
          price: match.variant.price ?? safe,
          cost: match.variant.cost,
        });
        if (written) corrected++;
        else skippedNoCost.push(sku);
      } catch (e: unknown) {
        errors.push({ sku, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const nextOffset = offset + limit < stuck.length ? offset + limit : null;

    console.log(
      `[price-correct] stuck=${stuck.length} paged=${page.length} corrected=${corrected} ` +
      `unmatched=${skippedUnmatched.length} noCost=${skippedNoCost.length} errors=${errors.length} dryRun=${dryRun}`
    );

    // Telegram summary on completion of a live run (skip dry-runs and
    // intermediate paginated pages). Same pattern as walmart-reconcile.
    if (!dryRun && nextOffset === null) {
      const errLine = errors.length
        ? `\n⚠️ Errors: ${errors.length}`
        : '';
      await sendTelegramMessage(
        `🩹 <b>Walmart $285 correction complete</b>\n` +
        `Stuck listings found: ${stuck.length}\n` +
        `💰 Corrected: ${corrected}\n` +
        `🔍 Unmatched (no Shopify SKU): ${skippedUnmatched.length}\n` +
        `❓ Skipped (no cost): ${skippedNoCost.length}` +
        errLine
      );
    }

    return res.status(errors.length ? 207 : 200).json({
      dryRun,
      totalStuck: stuck.length,
      processed: page.length,
      offset,
      limit,
      nextOffset,
      corrected,
      skippedUnmatchedCount: skippedUnmatched.length,
      skippedNoCostCount: skippedNoCost.length,
      errorCount: errors.length,
      // Full unmatched list — feeds the ~662 unmatched-listings investigation.
      skippedUnmatched,
      skippedNoCost: skippedNoCost.slice(0, 500),
      errors: errors.slice(0, 50),
      correctedSample,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[price-correct] Error:', message);
    return res.status(500).json({ error: message });
  }
}

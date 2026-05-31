/**
 * api/cost-integrity-audit.ts
 *
 * LAYER 4 — Cost-integrity audit (READ-ONLY, no writes).
 *
 * Verifies that the cost data feeding Layer 1's price floor is itself
 * correct and fresh — WITHOUT introducing a second price-write path.
 *
 * The single source of truth is CT → Shopify → Walmart. shopifySync
 * (gci-brain) pulls Canada Tire dealer cost and writes it into Shopify
 * in two places:
 *   • product metafield `canada_tire.cost`  = the raw CT dealer cost
 *   • variant InventoryItem.unitCost        = `netCost` (what the floor reads)
 *
 * This audit reuses that already-synced CT data (no new NetSuite/CT
 * credential path) and flags three conditions:
 *   • Divergence  — unitCost differs from the CT cost by > threshold
 *   • Missing     — variant has no unitCost (the safeWalmartPrice skip set)
 *   • Stale       — `canada_tire.cost_synced_at` older than max age (if present)
 *
 * Output is a report only. It does NOT write prices and does NOT block
 * reconcile — it gives Patrick a daily heads-up before the 10 AM run.
 *
 *   GET /api/cost-integrity-audit
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendTelegramMessage } from './lib/telegram.js';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN ?? '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION   = '2024-01';

const COST_DIVERGENCE_THRESHOLD = 0.10; // 10%
const COST_MAX_AGE_DAYS         = 30;   // stale if cost not synced in > 30 days

// MSRP sanity band (same logic as gci-brain parseCTDealerCost / PR #115):
// a valid dealer cost sits between 25% and 90% of MSRP. Outside → suspect.
const MSRP_BAND_LOW  = 0.25;
const MSRP_BAND_HIGH = 0.90;

// Structured reason codes emitted per flagged SKU.
type ReasonCode =
  | 'MISSING_UNIT_COST'
  | 'MISSING_CT_COST'
  | 'COST_DIVERGENCE'
  | 'COST_OUT_OF_BAND'
  | 'STALE_COST';

interface VariantCost {
  sku: string;
  unitCost: number | null;   // InventoryItem.unitCost — what the floor reads
  ctCost: number | null;     // canada_tire.cost metafield — raw CT dealer cost
  msrp: number | null;       // variant compareAtPrice — list/MSRP for the band check
  costSyncedAt: string | null;
}

async function fetchVariantCosts(): Promise<VariantCost[]> {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    throw new Error('Shopify credentials not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN)');
  }

  const out: VariantCost[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const query: string = `{
      productVariants(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            sku
            compareAtPrice
            inventoryItem { unitCost { amount } }
            product {
              ctCost: metafield(namespace: "canada_tire", key: "cost") { value }
              costSyncedAt: metafield(namespace: "canada_tire", key: "cost_synced_at") { value }
            }
          }
        }
      }
    }`;

    const res: Response = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      },
    );

    if (res.status === 429) { await new Promise(r => setTimeout(r, 2_000)); continue; }
    if (!res.ok) throw new Error(`Shopify GraphQL error: ${res.status} ${(await res.text()).slice(0, 200)}`);

    const data: any = await res.json();
    if (data.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`);

    const variants: any = data?.data?.productVariants;
    if (!variants) throw new Error('Shopify GraphQL: unexpected response shape');

    for (const edge of variants.edges) {
      const node = edge.node;
      const sku = (node.sku ?? '').toUpperCase();
      if (!sku) continue;

      const rawUnit = node.inventoryItem?.unitCost?.amount;
      const rawCt   = node.product?.ctCost?.value;
      const rawMsrp = node.compareAtPrice;
      out.push({
        sku,
        unitCost:     rawUnit != null ? parseFloat(rawUnit) : null,
        ctCost:       rawCt != null ? parseFloat(rawCt) : null,
        msrp:         rawMsrp != null ? parseFloat(rawMsrp) : null,
        costSyncedAt: node.product?.costSyncedAt?.value ?? null,
      });
    }

    hasMore = variants.pageInfo.hasNextPage;
    cursor = variants.pageInfo.endCursor;
  }

  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // GET (cron) + POST (Pat's same-origin console tests). Always read-only.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const variants = await fetchVariantCosts();

    interface FlaggedSku {
      sku: string;
      reasons: ReasonCode[];
      unitCost: number | null;
      ctCost: number | null;
      msrp: number | null;
      pctDiff?: number;        // unitCost vs ctCost, %
      lastSyncedDays?: number; // age of canada_tire.cost_synced_at
    }

    const flagged: FlaggedSku[] = [];

    // Category arrays for at-a-glance reporting (back-compat + drill-down).
    const diverged: Array<{ sku: string; shopifyCost: number; ctCost: number; pctDiff: number }> = [];
    const outOfBand: Array<{ sku: string; cost: number; msrp: number; low: number; high: number }> = [];
    const missingUnitCost: string[] = [];
    const missingCtCost: string[] = [];
    const staleCost: Array<{ sku: string; lastSyncedDays: number }> = [];

    const now = Date.now();

    for (const v of variants) {
      const reasons: ReasonCode[] = [];
      let pctDiff: number | undefined;
      let lastSyncedDays: number | undefined;

      const hasUnit = v.unitCost != null && !isNaN(v.unitCost) && v.unitCost > 0;
      const hasCt   = v.ctCost != null && !isNaN(v.ctCost) && v.ctCost > 0;

      // Missing on EITHER field. Missing unitCost = exactly what safeWalmartPrice() skips.
      if (!hasUnit) { reasons.push('MISSING_UNIT_COST'); missingUnitCost.push(v.sku); }
      if (!hasCt)   { reasons.push('MISSING_CT_COST');   missingCtCost.push(v.sku); }

      // Divergence: the cost feeding the floor vs the authoritative CT cost.
      if (hasUnit && hasCt) {
        const diff = Math.abs(v.unitCost! - v.ctCost!) / v.ctCost!;
        if (diff > COST_DIVERGENCE_THRESHOLD) {
          pctDiff = parseFloat((diff * 100).toFixed(1));
          reasons.push('COST_DIVERGENCE');
          diverged.push({
            sku: v.sku,
            shopifyCost: parseFloat(v.unitCost!.toFixed(2)),
            ctCost: parseFloat(v.ctCost!.toFixed(2)),
            pctDiff,
          });
        }
      }

      // MSRP band check (same logic as parseCTDealerCost / PR #115):
      // a valid dealer cost sits in [msrp×0.25, msrp×0.90). Validate the
      // authoritative CT cost when present, else the operative unitCost.
      const bandCost = hasCt ? v.ctCost! : hasUnit ? v.unitCost! : null;
      if (bandCost != null && v.msrp != null && !isNaN(v.msrp) && v.msrp > 0) {
        const low  = v.msrp * MSRP_BAND_LOW;
        const high = v.msrp * MSRP_BAND_HIGH;
        if (!(bandCost >= low && bandCost < high)) {
          reasons.push('COST_OUT_OF_BAND');
          outOfBand.push({
            sku: v.sku,
            cost: parseFloat(bandCost.toFixed(2)),
            msrp: parseFloat(v.msrp.toFixed(2)),
            low: parseFloat(low.toFixed(2)),
            high: parseFloat(high.toFixed(2)),
          });
        }
      }

      // Staleness (only if shopifySync stamps canada_tire.cost_synced_at).
      if (v.costSyncedAt) {
        const synced = Date.parse(v.costSyncedAt);
        if (!isNaN(synced)) {
          const days = (now - synced) / 86_400_000;
          if (days > COST_MAX_AGE_DAYS) {
            lastSyncedDays = Math.floor(days);
            reasons.push('STALE_COST');
            staleCost.push({ sku: v.sku, lastSyncedDays });
          }
        }
      }

      if (reasons.length > 0) {
        flagged.push({
          sku: v.sku,
          reasons,
          unitCost: v.unitCost,
          ctCost: v.ctCost,
          msrp: v.msrp,
          ...(pctDiff != null ? { pctDiff } : {}),
          ...(lastSyncedDays != null ? { lastSyncedDays } : {}),
        });
      }
    }

    diverged.sort((a, b) => b.pctDiff - a.pctDiff);

    const summary = {
      flaggedCount:        flagged.length,
      divergedCount:       diverged.length,
      outOfBandCount:      outOfBand.length,
      missingUnitCount:    missingUnitCost.length,
      missingCtCount:      missingCtCost.length,
      staleCount:          staleCost.length,
      freshnessTracked:    variants.some(v => v.costSyncedAt != null),
    };

    // Telegram summary ONLY when something is flagged. Read-only audit — this
    // is the sole side effect, a notification (no writes anywhere). GCI Orders bot.
    if (flagged.length > 0) {
      await sendTelegramMessage(
        `🧮 <b>Cost-Integrity Audit</b> — ${flagged.length} SKU(s) flagged\n` +
        `Checked: ${variants.length}\n` +
        `🔀 Divergent (>${COST_DIVERGENCE_THRESHOLD * 100}%): ${diverged.length}\n` +
        `📐 Out of MSRP band: ${outOfBand.length}\n` +
        `❓ Missing unit cost: ${missingUnitCost.length}\n` +
        `❓ Missing CT cost: ${missingCtCost.length}\n` +
        `🕒 Stale (>${COST_MAX_AGE_DAYS}d): ${staleCost.length}\n` +
        `<i>Read-only — review before the reconcile run.</i>`,
      );
    }

    return res.status(200).json({
      totalChecked: variants.length,
      thresholds: {
        divergencePct: COST_DIVERGENCE_THRESHOLD * 100,
        maxAgeDays: COST_MAX_AGE_DAYS,
        msrpBand: { low: MSRP_BAND_LOW, high: MSRP_BAND_HIGH },
      },
      summary,
      flagged: flagged.slice(0, 1000),
      diverged: diverged.slice(0, 500),
      outOfBand: outOfBand.slice(0, 500),
      missingUnitCost: missingUnitCost.slice(0, 1000),
      missingCtCost: missingCtCost.slice(0, 1000),
      staleCost: staleCost.slice(0, 500),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cost-integrity-audit] Error:', message);
    return res.status(500).json({ error: message });
  }
}

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

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN ?? '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION   = '2024-01';

const COST_DIVERGENCE_THRESHOLD = 0.10; // 10%
const COST_MAX_AGE_DAYS         = 14;

interface VariantCost {
  sku: string;
  unitCost: number | null;   // InventoryItem.unitCost — what the floor reads
  ctCost: number | null;     // canada_tire.cost metafield — raw CT dealer cost
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
      out.push({
        sku,
        unitCost:     rawUnit != null ? parseFloat(rawUnit) : null,
        ctCost:       rawCt != null ? parseFloat(rawCt) : null,
        costSyncedAt: node.product?.costSyncedAt?.value ?? null,
      });
    }

    hasMore = variants.pageInfo.hasNextPage;
    cursor = variants.pageInfo.endCursor;
  }

  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const variants = await fetchVariantCosts();

    const diverged: Array<{ sku: string; shopifyCost: number; ctCost: number; pctDiff: number }> = [];
    const missingCost: string[] = [];
    const staleCost: Array<{ sku: string; lastSyncedDays: number }> = [];

    const now = Date.now();

    for (const v of variants) {
      // Missing cost → exactly the SKUs safeWalmartPrice() skips.
      if (v.unitCost == null || isNaN(v.unitCost) || v.unitCost <= 0) {
        missingCost.push(v.sku);
        continue;
      }

      // Divergence: the cost feeding the floor vs the authoritative CT cost.
      if (v.ctCost != null && !isNaN(v.ctCost) && v.ctCost > 0) {
        const pctDiff = Math.abs(v.unitCost - v.ctCost) / v.ctCost;
        if (pctDiff > COST_DIVERGENCE_THRESHOLD) {
          diverged.push({
            sku: v.sku,
            shopifyCost: parseFloat(v.unitCost.toFixed(2)),
            ctCost: parseFloat(v.ctCost.toFixed(2)),
            pctDiff: parseFloat((pctDiff * 100).toFixed(1)),
          });
        }
      }

      // Staleness (only if shopifySync stamps canada_tire.cost_synced_at).
      if (v.costSyncedAt) {
        const synced = Date.parse(v.costSyncedAt);
        if (!isNaN(synced)) {
          const days = (now - synced) / 86_400_000;
          if (days > COST_MAX_AGE_DAYS) {
            staleCost.push({ sku: v.sku, lastSyncedDays: Math.floor(days) });
          }
        }
      }
    }

    diverged.sort((a, b) => b.pctDiff - a.pctDiff);

    return res.status(200).json({
      totalChecked: variants.length,
      thresholds: { divergencePct: COST_DIVERGENCE_THRESHOLD * 100, maxAgeDays: COST_MAX_AGE_DAYS },
      diverged: diverged.slice(0, 500),
      missingCost: missingCost.slice(0, 1000),
      staleCost: staleCost.slice(0, 500),
      summary: {
        divergedCount: diverged.length,
        missingCount: missingCost.length,
        staleCount: staleCost.length,
        freshnessTracked: variants.some(v => v.costSyncedAt != null),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cost-integrity-audit] Error:', message);
    return res.status(500).json({ error: message });
  }
}

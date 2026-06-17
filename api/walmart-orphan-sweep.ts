// api/walmart-orphan-sweep.ts
// ─────────────────────────────────────────────────────────────
// POST|GET /api/walmart-orphan-sweep
//
// Computes orphan SKUs = listed on Walmart but NOT in active ct-sync
// Shopify products. For each orphan:
//   1. Zeros Walmart inventory (quantity 0)
//   2. Zeros Shopify inventory (available 0) for matching variants
//
// NEVER pushes non-zero quantity to Walmart.
//
// Query params:
//   ?dryRun=true|false  — default true (preview only)
//
// Auth: Bearer token must match WALMART_ZERO_SECRET env var.
// Cron: daily at 11 AM UTC (vercel.json)
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchListedSkus,
  bulkInventoryFeed,
  chunkArray,
  type WalmartInventoryItem,
} from './lib/walmart-client';

export const config = { maxDuration: 300 };

// ─── ENV ────────────────────────────────────────────────────────

const SECRET         = process.env.WALMART_ZERO_SECRET ?? '';
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN ?? '';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION    = '2024-01';
const SHOPIFY_BASE   = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}`;

// ─── HELPERS ────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function shopifyRest<T>(path: string): Promise<T> {
  const res = await fetch(`${SHOPIFY_BASE}${path}`, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 429) {
    await delay(2_000);
    return shopifyRest<T>(path);
  }
  if (!res.ok) {
    throw new Error(`Shopify ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function shopifyPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SHOPIFY_BASE}${path}`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    await delay(2_000);
    return shopifyPost<T>(path, body);
  }
  if (!res.ok) {
    throw new Error(`Shopify POST ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Fetch active ct-sync SKU set (same pagination as walmart-sync) ──

async function fetchActiveCtSyncSkus(): Promise<Set<string>> {
  const skus = new Set<string>();
  let sinceId = 0;

  while (true) {
    const q = `tag=ct-sync&status=active&limit=250&fields=id,variants${sinceId ? `&since_id=${sinceId}` : ''}`;
    const data: { products: Array<{ id: number; variants: Array<{ sku: string }> }> } =
      await shopifyRest(`/products.json?${q}`);
    const products = data.products ?? [];

    for (const p of products) {
      for (const v of p.variants) {
        const sku = (v.sku ?? '').toUpperCase();
        if (!sku) continue;
        skus.add(sku);
        if (!sku.startsWith('TIRE-')) {
          skus.add('TIRE-' + sku);
        }
      }
    }

    if (products.length < 250) break;
    sinceId = products[products.length - 1].id;
    await delay(300);
  }

  return skus;
}

// ── Get location ID for inventory zeroing ──

async function getLocationId(): Promise<string> {
  const envId = process.env.SHOPIFY_LOCATION_ID;
  if (envId) return envId;

  const data: { locations: Array<{ id: number; active: boolean }> } =
    await shopifyRest('/locations.json?limit=1');
  const loc = (data.locations ?? []).find(l => l.active) ?? (data.locations ?? [])[0];
  if (!loc) throw new Error('No Shopify location found');
  return String(loc.id);
}

// ── Fetch inventory_item_id for orphan SKUs via GraphQL ──

interface VariantInventoryInfo {
  inventoryItemId: string; // numeric ID (extracted from GID)
  qty: number;
}

async function fetchVariantInventoryIds(
  targetSkus: Set<string>,
): Promise<Map<string, VariantInventoryInfo>> {
  const map = new Map<string, VariantInventoryInfo>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const query = `{
      productVariants(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            sku
            inventoryQuantity
            inventoryItem { id }
          }
        }
      }
    }`;

    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      },
    );

    if (res.status === 429) {
      await delay(2_000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Shopify GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const data: {
      data?: {
        productVariants?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          edges: Array<{
            node: {
              sku: string | null;
              inventoryQuantity: number | null;
              inventoryItem: { id: string } | null;
            };
          }>;
        };
      };
      errors?: unknown;
    } = await res.json();

    if (data.errors) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`);
    }

    const variants = data.data?.productVariants;
    if (!variants) throw new Error('Shopify GraphQL: unexpected response shape');

    for (const edge of variants.edges) {
      const node = edge.node;
      const sku = (node.sku ?? '').toUpperCase();
      if (!sku || !targetSkus.has(sku)) continue;

      const gid = node.inventoryItem?.id ?? '';
      // Extract numeric ID from gid://shopify/InventoryItem/12345
      const numericId = gid.split('/').pop() ?? '';
      if (!numericId) continue;

      map.set(sku, {
        inventoryItemId: numericId,
        qty: node.inventoryQuantity ?? 0,
      });
    }

    hasMore = variants.pageInfo.hasNextPage;
    cursor = variants.pageInfo.endCursor;
  }

  return map;
}

// ─── MAIN HANDLER ───────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'GET or POST only' });
    }

    // ── Auth (skip for Vercel cron — crons don't send Bearer) ────
    // Cron calls come as GET without auth; manual calls require Bearer.
    const isCron = req.method === 'GET' && !req.headers.authorization;
    if (!isCron) {
      if (!SECRET) {
        return res.status(500).json({ error: 'WALMART_ZERO_SECRET not configured' });
      }
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
      return res.status(500).json({ error: 'Shopify credentials not configured' });
    }

    const dryRun = (req.query.dryRun as string ?? 'true') !== 'false';
    const start = Date.now();

    console.log(`[orphan-sweep] Starting${dryRun ? ' [DRY RUN]' : ' [WRITE MODE]'}…`);

    // ── Step 1: Fetch both sides ──────────────────────────────────
    const [walmartListed, shopifyActive] = await Promise.all([
      fetchListedSkus(),
      fetchActiveCtSyncSkus(),
    ]);

    console.log(`[orphan-sweep] Walmart listed: ${walmartListed.size}, Shopify active ct-sync: ${shopifyActive.size}`);

    // ── Step 2: Compute orphans ───────────────────────────────────
    const orphans: string[] = [];
    for (const sku of walmartListed) {
      if (!shopifyActive.has(sku)) {
        orphans.push(sku);
      }
    }
    orphans.sort();

    console.log(`[orphan-sweep] Orphan count: ${orphans.length}`);

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        mode: 'walmart-orphan-sweep',
        dryRun: true,
        walmartListed: walmartListed.size,
        shopifyActiveCtSync: shopifyActive.size,
        orphanCount: orphans.length,
        orphanSample: orphans.slice(0, 50),
        durationMs: Date.now() - start,
      });
    }

    // ── Step 3 (write mode): Zero Walmart inventory for orphans ───
    const walmartItems: WalmartInventoryItem[] = orphans.map(sku => ({
      sku,
      quantity: 0, // ALWAYS zero — NEVER non-zero
    }));

    let wmSuccess = 0;
    let wmFailed = 0;
    for (const chunk of chunkArray(walmartItems, 1000)) {
      try {
        const result = await bulkInventoryFeed(chunk);
        wmSuccess += result.success;
        wmFailed += result.failed;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orphan-sweep] Walmart chunk error: ${msg}`);
        wmFailed += chunk.length;
      }
      await delay(500);
    }

    console.log(`[orphan-sweep] Walmart zeroed: ${wmSuccess} success, ${wmFailed} failed`);

    // ── Step 4 (write mode): Zero Shopify inventory for orphans ───
    // Build set of orphan SKUs (both bare and TIRE- forms for matching)
    const orphanSkuSet = new Set<string>();
    for (const sku of orphans) {
      orphanSkuSet.add(sku);
      const bare = sku.startsWith('TIRE-') ? sku.slice(5) : sku;
      orphanSkuSet.add(bare);
      orphanSkuSet.add('TIRE-' + bare);
    }

    let shopifySuccess = 0;
    let shopifyFailed = 0;
    let shopifySkipped = 0;

    try {
      const locationId = await getLocationId();
      const variantMap = await fetchVariantInventoryIds(orphanSkuSet);

      console.log(`[orphan-sweep] Found ${variantMap.size} Shopify variants matching orphan SKUs`);

      // Zero inventory for orphan variants that have non-zero stock
      for (const [sku, info] of variantMap) {
        if (info.qty === 0) {
          shopifySkipped++;
          continue;
        }
        try {
          await shopifyPost('/inventory_levels/set.json', {
            location_id: locationId,
            inventory_item_id: info.inventoryItemId,
            available: 0,
          });
          shopifySuccess++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[orphan-sweep] Shopify zero failed for ${sku} (item ${info.inventoryItemId}): ${msg}`);
          shopifyFailed++;
        }
        await delay(200); // respect rate limits
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[orphan-sweep] Shopify inventory zeroing failed: ${msg}`);
    }

    console.log(`[orphan-sweep] Shopify zeroed: ${shopifySuccess} success, ${shopifyFailed} failed, ${shopifySkipped} skipped (already 0)`);

    return res.status(200).json({
      ok: true,
      mode: 'walmart-orphan-sweep',
      dryRun: false,
      walmartListed: walmartListed.size,
      shopifyActiveCtSync: shopifyActive.size,
      orphanCount: orphans.length,
      orphanSample: orphans.slice(0, 50),
      walmartZeroed: { success: wmSuccess, failed: wmFailed },
      shopifyZeroed: { success: shopifySuccess, failed: shopifyFailed, skipped: shopifySkipped },
      durationMs: Date.now() - start,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[orphan-sweep] Unhandled error:', message);
    return res.status(500).json({ error: 'Internal error', details: message });
  }
}

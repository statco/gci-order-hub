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
//   ?offset=0&limit=150 — chunk per-SKU work (qty probe / zero push)
//   ?withQty=true       — dry-run: probe Walmart qty per orphan in chunk
//   ?mode=sku-lookup&sku=XXX — targeted single-SKU status check (read-only)
//
// Auth: Bearer token must match WALMART_ZERO_SECRET env var.
// Cron: daily at 11 AM UTC (vercel.json)
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchListedSkus,
  bulkInventoryFeed,
  chunkArray,
  walmartFetch,
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

// ── Fetch current Walmart quantity per SKU (best-effort, concurrency-limited) ──
// Used only in dry-run reporting so we can distinguish live oversell vectors
// (qty > 0) from already-zero/harmless orphans. Never writes. A failed lookup
// is recorded as -1 (unknown) and never blocks the sweep.
async function fetchWalmartQtys(skus: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const CONCURRENCY = 10;
  for (let i = 0; i < skus.length; i += CONCURRENCY) {
    const batch = skus.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async sku => {
      try {
        const data = await walmartFetch<{ quantity?: { amount?: number } }>(
          `/v3/inventory?sku=${encodeURIComponent(sku)}`,
        );
        const amt = data?.quantity?.amount;
        map.set(sku, typeof amt === 'number' ? amt : 0);
      } catch {
        map.set(sku, -1); // unknown — lookup failed, non-fatal
      }
    }));
  }
  return map;
}

// ── Targeted SKU status lookup (read-only, no full scan) ────────
// Returns: Walmart listing status, active Shopify match, any-status Shopify match
async function skuLookup(sku: string): Promise<{
  sku: string;
  walmart: { listed: boolean; forms: string[] };
  shopifyActive: { found: boolean; matchedSku: string | null };
  shopifyAnyStatus: Array<{ sku: string; status: string; inventoryQuantity: number; productId: number }>;
}> {
  const bare = sku.toUpperCase().startsWith('TIRE-') ? sku.toUpperCase().slice(5) : sku.toUpperCase();
  const tireForm = 'TIRE-' + bare;

  // (a) Walmart listing check
  const listedSkus = await fetchListedSkus();
  const walmartForms: string[] = [];
  if (listedSkus.has(bare)) walmartForms.push(bare);
  if (listedSkus.has(tireForm)) walmartForms.push(tireForm);

  // (b) Active ct-sync Shopify product with bare SKU
  let activeMatch: string | null = null;
  try {
    const data: { products: Array<{ id: number; variants: Array<{ sku: string }> }> } =
      await shopifyRest(`/products.json?tag=ct-sync&status=active&limit=250&fields=id,variants`);
    // Search through pages for this specific SKU
    let products = data.products ?? [];
    let sinceId = 0;
    const checkProducts = (prods: typeof products) => {
      for (const p of prods) {
        for (const v of p.variants) {
          const vSku = (v.sku ?? '').toUpperCase();
          if (vSku === bare || vSku === tireForm) {
            activeMatch = vSku;
            return true;
          }
        }
      }
      return false;
    };
    if (!checkProducts(products)) {
      while (products.length === 250) {
        sinceId = products[products.length - 1].id;
        const next: typeof data = await shopifyRest(`/products.json?tag=ct-sync&status=active&limit=250&fields=id,variants&since_id=${sinceId}`);
        products = next.products ?? [];
        if (checkProducts(products)) break;
        await delay(300);
      }
    }
  } catch (e: unknown) {
    console.warn(`[sku-lookup] Active product search error: ${e instanceof Error ? e.message : e}`);
  }

  // (c) Any-status Shopify products holding this SKU (search by title/sku isn't
  //     reliable via REST, so we use GraphQL to find variants by SKU)
  const anyStatus: Array<{ sku: string; status: string; inventoryQuantity: number; productId: number }> = [];
  try {
    for (const searchSku of [bare, tireForm]) {
      const query = `{
        productVariants(first: 10, query: "sku:${searchSku}") {
          edges {
            node {
              sku
              inventoryQuantity
              product { id status }
            }
          }
        }
      }`;
      const gqlRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        },
      );
      if (gqlRes.ok) {
        const gqlData: any = await gqlRes.json();
        for (const edge of gqlData?.data?.productVariants?.edges ?? []) {
          const n = edge.node;
          const nSku = (n.sku ?? '').toUpperCase();
          if (nSku === bare || nSku === tireForm) {
            const pid = parseInt(String(n.product?.id ?? '').split('/').pop() ?? '0', 10);
            anyStatus.push({
              sku: nSku,
              status: (n.product?.status ?? 'unknown').toUpperCase(),
              inventoryQuantity: n.inventoryQuantity ?? 0,
              productId: pid,
            });
          }
        }
      }
    }
  } catch (e: unknown) {
    console.warn(`[sku-lookup] Any-status search error: ${e instanceof Error ? e.message : e}`);
  }

  return {
    sku: sku.toUpperCase(),
    walmart: { listed: walmartForms.length > 0, forms: walmartForms },
    shopifyActive: { found: activeMatch !== null, matchedSku: activeMatch },
    shopifyAnyStatus: anyStatus,
  };
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

    // ── SKU Lookup mode (read-only, fast, no full scan) ───────────
    const mode = req.query.mode as string | undefined;
    if (mode === 'sku-lookup') {
      const skuParam = req.query.sku as string;
      if (!skuParam) {
        return res.status(400).json({ error: 'mode=sku-lookup requires ?sku=XXX' });
      }
      const start = Date.now();
      const result = await skuLookup(skuParam);
      return res.status(200).json({
        ok: true,
        mode: 'sku-lookup',
        ...result,
        durationMs: Date.now() - start,
      });
    }

    const dryRun = (req.query.dryRun as string ?? 'true') !== 'false';
    const offset = Math.max(0, parseInt(req.query.offset as string || '0', 10));
    const limit  = Math.max(1, Math.min(500, parseInt(req.query.limit as string || '150', 10)));
    const start  = Date.now();

    console.log(`[orphan-sweep] Starting${dryRun ? ' [DRY RUN]' : ' [WRITE MODE]'} offset=${offset} limit=${limit}…`);

    // ── Step 1: Fetch both sides (fast — ~6s) ─────────────────────
    const [walmartListed, shopifyActive] = await Promise.all([
      fetchListedSkus(),
      fetchActiveCtSyncSkus(),
    ]);

    console.log(`[orphan-sweep] Walmart listed: ${walmartListed.size}, Shopify active ct-sync: ${shopifyActive.size}`);

    // ── Step 2: Compute full orphan set ───────────────────────────
    const orphans: string[] = [];
    for (const sku of walmartListed) {
      if (!shopifyActive.has(sku)) {
        orphans.push(sku);
      }
    }
    orphans.sort();

    const orphanCount = orphans.length;
    console.log(`[orphan-sweep] Orphan count: ${orphanCount}`);

    // ── Step 3: Slice to chunk ────────────────────────────────────
    const chunk = orphans.slice(offset, offset + limit);
    const chunkSize = chunk.length;
    const nextOffset = (offset + limit < orphanCount) ? offset + limit : null;
    const done = nextOffset === null;

    console.log(`[orphan-sweep] Chunk: offset=${offset} limit=${limit} chunkSize=${chunkSize} nextOffset=${nextOffset} done=${done}`);

    if (dryRun) {
      const withQty = (req.query.withQty as string) === 'true';
      let qtyReport: Record<string, unknown> | undefined;
      if (withQty && chunkSize > 0) {
        console.log(`[orphan-sweep] Probing Walmart qty for ${chunkSize} orphans in chunk…`);
        const qtyMap = await fetchWalmartQtys(chunk);
        const liveVectors = chunk
          .map(sku => ({ sku, qty: qtyMap.get(sku) ?? -1 }))
          .filter(o => o.qty > 0)
          .sort((a, b) => b.qty - a.qty);
        const unknown = [...qtyMap.values()].filter(q => q < 0).length;
        qtyReport = {
          liveVectorCount: liveVectors.length,
          liveVectors,
          alreadyZero: chunkSize - liveVectors.length - unknown,
          qtyLookupFailed: unknown,
        };
      }

      const showOrphans = (req.query.showOrphans as string) === 'true';

      return res.status(200).json({
        ok: true,
        mode: 'walmart-orphan-sweep',
        dryRun: true,
        walmartListed: walmartListed.size,
        shopifyActiveCtSync: shopifyActive.size,
        orphanCount,
        offset,
        limit,
        chunkSize,
        nextOffset,
        done,
        ...(showOrphans ? { orphans } : {}),
        chunkSkus: chunk,
        ...(qtyReport ?? {}),
        durationMs: Date.now() - start,
      });
    }

    // ── Write mode: zero Walmart + Shopify for chunk only ─────────
    if (chunkSize === 0) {
      return res.status(200).json({
        ok: true,
        mode: 'walmart-orphan-sweep',
        dryRun: false,
        orphanCount,
        offset,
        limit,
        chunkSize: 0,
        nextOffset,
        done,
        walmartZeroed: { success: 0, failed: 0 },
        shopifyZeroed: { success: 0, failed: 0, skipped: 0 },
        durationMs: Date.now() - start,
      });
    }

    // ── Zero Walmart inventory for chunk ──────────────────────────
    const walmartItems: WalmartInventoryItem[] = chunk.map(sku => ({
      sku,
      quantity: 0, // ALWAYS zero — NEVER non-zero
    }));

    let wmSuccess = 0;
    let wmFailed = 0;
    for (const wChunk of chunkArray(walmartItems, 1000)) {
      try {
        const result = await bulkInventoryFeed(wChunk);
        wmSuccess += result.success;
        wmFailed += result.failed;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orphan-sweep] Walmart chunk error: ${msg}`);
        wmFailed += wChunk.length;
      }
      await delay(500);
    }

    console.log(`[orphan-sweep] Walmart zeroed: ${wmSuccess} success, ${wmFailed} failed`);

    // ── Zero Shopify inventory for chunk ──────────────────────────
    const orphanSkuSet = new Set<string>();
    for (const sku of chunk) {
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

      console.log(`[orphan-sweep] Found ${variantMap.size} Shopify variants matching chunk SKUs`);

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
        await delay(200);
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
      orphanCount,
      offset,
      limit,
      chunkSize,
      nextOffset,
      done,
      chunkSkuSample: chunk.slice(0, 20),
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

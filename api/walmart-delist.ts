// api/walmart-delist.ts
// ─────────────────────────────────────────────────────────────────────────────
// Bulk retire (permanently remove) Walmart CA SKUs that should no longer be
// sold. General-purpose version of walmart-retire.ts's DELETE /v3/items/{sku}
// mechanism — accepts ANY SKU (bare or TIRE- prefixed), not just TIRE-
// duplicates, and supports Shopify-tag-based bulk targeting in addition to an
// explicit SKU list.
//
// Background: this file originally attempted a REVERSIBLE unpublish/republish
// via the MP_MAINTENANCE feed, per the original task. Extensive live
// investigation against this account (see PR #80 history) confirmed that
// isn't achievable here:
//   - Get Spec / taxonomy APIs are unavailable for this Global Marketplace
//     Partner (GMP) account (GMP_ITEM_QUERY_API / MARKET_NOT_SUPPORTED).
//   - 22 candidate field names against a live MP_MAINTENANCE submission were
//     all rejected as unrecognized fields.
//   - Seller Center's own UI has no Deactivate/Unpublish action at all — only
//     Edit / Retire / Delete / Update lag time — and its "Unpublished" status
//     is Walmart's own automated judgment (confirmed via its own tooltip:
//     "We've removed your item from Marketplace due to its high price."), not
//     a seller-writable flag.
// Per direction, this now retires items outright instead of attempting a
// (non-existent) reversible toggle. Retire is near-permanent — there is no
// "republish"; a retired item must be re-created via the item feed.
//
//   POST /api/walmart-delist?dryRun=false[&offset=N&limit=300]
//     Body: { skus: string[] }  OR  { tag: string }  (exactly one)
//     Auth: Bearer token matching WALMART_UNPUBLISH_SECRET.
//     dryRun defaults to TRUE — must pass dryRun=false explicitly to write.
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchListedSkus,
  retireItem,
  getItemLifecycleStatus,
} from './lib/walmart-client.js';

export const config = { maxDuration: 300 };

const SECRET     = process.env.WALMART_UNPUBLISH_SECRET ?? '';
const CHUNK_SIZE = 300; // matches the repo-wide convention (walmart-retire.ts)

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Shopify tag lookup (reuses the ct-sync fetch pattern, parameterised) ──

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN    ?? '';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION    = '2024-01';

async function fetchSkusByShopifyTag(tag: string): Promise<string[]> {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    throw new Error('Shopify credentials not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN)');
  }

  const skus: string[] = [];
  let nextUrl: string | null =
    `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/products.json` +
    `?limit=250&tag=${encodeURIComponent(tag)}&fields=id,variants`;

  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    });
    if (res.status === 429) { await delay(2_000); continue; }
    if (!res.ok) throw new Error(`Shopify fetch failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

    const data: any = await res.json();
    for (const p of data.products ?? []) {
      for (const v of p.variants ?? []) {
        if (v.sku) skus.push(String(v.sku).toUpperCase().trim());
      }
    }

    const linkHeader: string = res.headers.get('Link') ?? '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  return skus;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST only' });
    }

    // ── Auth ──────────────────────────────────────────────────────
    if (!SECRET) {
      return res.status(500).json({ error: 'WALMART_UNPUBLISH_SECRET not configured' });
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ── Parse body: exactly one of skus / tag ───────────────────────
    const body = req.body as { skus?: unknown; tag?: unknown } | undefined;
    const hasSkus = Array.isArray(body?.skus) && (body!.skus as unknown[]).length > 0;
    const hasTag  = typeof body?.tag === 'string' && body!.tag.trim().length > 0;

    if (hasSkus === hasTag) {
      return res.status(400).json({ error: 'Body must contain exactly one of { skus: string[] } or { tag: string }' });
    }

    let inputSkus: string[];
    if (hasTag) {
      const tag = (body!.tag as string).trim();
      console.log(`[walmart-delist] Resolving SKUs from Shopify tag "${tag}"…`);
      inputSkus = await fetchSkusByShopifyTag(tag);
      console.log(`[walmart-delist] Tag "${tag}" resolved to ${inputSkus.length} SKUs`);
    } else {
      inputSkus = (body!.skus as unknown[]).map(s => String(s).toUpperCase().trim());
    }

    if (inputSkus.length === 0) {
      return res.status(400).json({ error: 'No SKUs resolved (empty skus array or tag matched nothing)' });
    }

    // ── Confirm each SKU is actually listed on Walmart before retiring it ──
    // (bare or TIRE- form — same twin-matching convention as walmart-zero.ts)
    console.log('[walmart-delist] Fetching Walmart-listed SKUs to validate input…');
    const listedSkus = await fetchListedSkus();

    const willRetire: string[] = [];
    const skippedNotListed: string[] = [];

    for (const sku of new Set(inputSkus)) {
      const bare = sku.startsWith('TIRE-') ? sku.slice(5) : sku;
      if (listedSkus.has(bare)) willRetire.push(bare);
      else if (listedSkus.has(`TIRE-${bare}`)) willRetire.push(`TIRE-${bare}`);
      else skippedNotListed.push(sku);
    }

    // ── Pagination ──────────────────────────────────────────────────
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const offset    = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
    const rawLimit  = parseInt(String(req.query.limit ?? String(CHUNK_SIZE)), 10);
    const limit     = Number.isNaN(rawLimit) ? CHUNK_SIZE : Math.max(1, Math.min(CHUNK_SIZE, rawLimit));

    const totalWillRetire = willRetire.length;
    const chunk           = willRetire.slice(offset, offset + limit);
    const nextOffset      = offset + limit < totalWillRetire ? offset + limit : null;
    const done            = nextOffset === null;

    const dryRun = (req.query.dryRun as string | undefined ?? 'true') !== 'false';

    console.log(
      `[walmart-delist] dryRun=${dryRun} totalInput=${inputSkus.length} ` +
      `willRetire=${totalWillRetire} skippedNotListed=${skippedNotListed.length} ` +
      `chunk=${chunk.length} offset=${offset} limit=${limit}`,
    );

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        totalInputSkus: inputSkus.length,
        willRetireCount: totalWillRetire,
        willRetire: chunk,
        skippedNotListed,
        offset, limit, nextOffset, done,
      });
    }

    if (chunk.length === 0) {
      return res.status(200).json({
        ok: true,
        dryRun: false,
        totalInputSkus: inputSkus.length,
        willRetireCount: totalWillRetire,
        skippedNotListed,
        offset, limit, nextOffset, done,
        retired: [],
        failed: [],
      });
    }

    // ── Retire chunk ─────────────────────────────────────────────────
    const accepted: string[]                             = [];
    const failed:   Array<{ sku: string; error: string }> = [];

    for (const sku of chunk) {
      try {
        await retireItem(sku);
        console.log(`[walmart-delist] ✓ accepted ${sku}`);
        accepted.push(sku);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[walmart-delist] ✗ ${sku}: ${msg}`);
        failed.push({ sku, error: msg });
      }
      await delay(150); // avoid hammering the API
    }

    // ── Lifecycle verification: accepted ≠ applied ──────────────────
    // After accepting the DELETEs, re-query each item. A 404/410 response
    // means the item is confirmed removed from the catalogue; anything else
    // means the DELETE was accepted but feed propagation is still pending.
    await delay(2_000);
    const confirmedRetired:   string[] = [];
    const acceptedButPending: string[] = [];

    for (const sku of accepted) {
      const status = await getItemLifecycleStatus(sku);
      if (status === 'NOT_FOUND') {
        console.log(`[walmart-delist] ✓ confirmed retired ${sku}`);
        confirmedRetired.push(sku);
      } else {
        console.log(`[walmart-delist] ⏳ accepted but still live (pending propagation): ${sku}`);
        acceptedButPending.push(sku);
      }
    }

    console.log(
      `[walmart-delist] done chunk: accepted=${accepted.length} confirmedRetired=${confirmedRetired.length} ` +
      `acceptedButPending=${acceptedButPending.length} failed=${failed.length}`,
    );

    return res.status(200).json({
      ok: failed.length === 0,
      dryRun: false,
      totalInputSkus: inputSkus.length,
      willRetireCount: totalWillRetire,
      skippedNotListed,
      offset, limit, nextOffset, done,
      acceptedCount:           accepted.length,
      confirmedRetiredCount:   confirmedRetired.length,
      confirmedRetired,
      acceptedButPendingCount: acceptedButPending.length,
      acceptedButPending,
      failedCount:             failed.length,
      failed,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-delist] Unhandled error:', message);
    return res.status(500).json({ error: 'Internal error', details: message });
  }
}

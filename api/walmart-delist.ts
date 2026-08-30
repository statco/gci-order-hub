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
//   POST /api/walmart-delist?dryRun=false[&offset=N&limit=100]
//     Body: exactly one of:
//       { skus: string[] }     — retire these specific SKUs
//       { tag: string }        — retire everything under this Shopify tag
//       { keepSkus: string[] } — retire everything CURRENTLY LISTED except
//                                these (inverted selection, for "here's my
//                                keep-list, retire the rest" cleanups)
//     Auth: Bearer token matching WALMART_UNPUBLISH_SECRET.
//     dryRun defaults to TRUE — must pass dryRun=false explicitly to write.
//     Real writes page via offset/limit (100/call, repeat with increasing
//     offset until done:true — same convention as walmart-retire.ts; a
//     chunk of 300 was tried and timed out mid-response against Vercel's
//     300s maxDuration). For
//     keepSkus mode specifically: don't page a real (dryRun=false) run
//     directly, since willRetire is recomputed from live data every call and
//     retirement propagation lag can shift the underlying set between calls.
//     Instead run a dry run with no &limit first (returns the FULL list,
//     uncapped) to snapshot it, then feed that exact list back as an
//     explicit { skus: [...] } for the real paged run.
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchListedSkus,
  retireItem,
  getItemLifecycleStatus,
} from './lib/walmart-client.js';

export const config = { maxDuration: 300 };

const SECRET     = process.env.WALMART_UNPUBLISH_SECRET ?? '';
// 100, not 300: walmart-retire.ts's own chunk size for this exact
// retire-then-verify-lifecycle pattern, precisely because a chunk of 300
// (retireItem + a per-SKU lifecycle re-check afterward) doesn't reliably
// finish inside Vercel's 300s maxDuration — confirmed live: a real
// dryRun=false call at 300 timed out mid-response.
const CHUNK_SIZE = 100;

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

    // ── Parse body: exactly one of skus / tag / keepSkus ────────────
    // keepSkus inverts the selection: "retire everything currently listed
    // EXCEPT these" — for bulk catalogue cleanups driven by a keep-list
    // rather than an explicit retire-list.
    const body = req.body as { skus?: unknown; tag?: unknown; keepSkus?: unknown } | undefined;
    const hasSkus     = Array.isArray(body?.skus) && (body!.skus as unknown[]).length > 0;
    const hasTag      = typeof body?.tag === 'string' && body!.tag.trim().length > 0;
    const hasKeepSkus = Array.isArray(body?.keepSkus) && (body!.keepSkus as unknown[]).length > 0;

    if ([hasSkus, hasTag, hasKeepSkus].filter(Boolean).length !== 1) {
      return res.status(400).json({ error: 'Body must contain exactly one of { skus: string[] }, { tag: string }, or { keepSkus: string[] }' });
    }

    console.log('[walmart-delist] Fetching Walmart-listed SKUs…');
    const listedSkus = await fetchListedSkus();

    // candidateSkus is the STABLE universe to page through — built once per
    // request from data that doesn't shrink as SKUs get retired (either the
    // caller's own explicit list, or a keep-diff snapshot). Offset/limit
    // slice THIS array, not a "still listed" filtered one — otherwise, as
    // earlier chunks get retired between separate paged calls, a
    // recomputed "still listed" list shrinks and reindexes, so offset=N no
    // longer means the same items call to call and later chunks silently
    // skip ahead over unprocessed SKUs (confirmed live: this caused a real
    // run to report done:true with ~850 SKUs never actually retired).
    // "Still listed" is only checked per-SKU within the already-sliced
    // chunk, purely to decide skip-vs-retire for that item.
    let candidateSkus: string[];
    let totalInputSkus: number;
    let keepSkusCount: number | undefined;

    if (hasKeepSkus) {
      // Normalise each keep entry to both bare and TIRE- forms so a keep
      // entry protects whichever form the item actually happens to be
      // listed under on Walmart.
      const keepBareSet = new Set<string>();
      const keepSet     = new Set<string>();
      for (const raw of body!.keepSkus as unknown[]) {
        const sku = String(raw).toUpperCase().trim();
        if (!sku) continue;
        const bare = sku.startsWith('TIRE-') ? sku.slice(5) : sku;
        keepBareSet.add(bare);
        keepSet.add(bare);
        keepSet.add(`TIRE-${bare}`);
      }
      keepSkusCount  = keepBareSet.size;
      totalInputSkus = keepSkusCount;
      candidateSkus  = [...listedSkus].filter(sku => !keepSet.has(sku));
    } else {
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
      totalInputSkus = inputSkus.length;
      candidateSkus  = [...new Set(inputSkus)];
    }

    // ── Pagination (slices the STABLE candidateSkus, per the note above) ──
    const dryRun = (req.query.dryRun as string | undefined ?? 'true') !== 'false';

    const totalCandidates = candidateSkus.length;
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const offset    = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);

    // Real writes always cap at CHUNK_SIZE per call (rate-limit + Vercel
    // maxDuration safety — a chunk of 300 was tried live and timed out
    // mid-response). A dry run with no explicit limit returns the FULL
    // candidate list uncapped, e.g. to snapshot a keepSkus-mode result as an
    // explicit { skus: [...] } for a later real run.
    const rawLimitParam = req.query.limit;
    const rawLimit       = rawLimitParam != null ? parseInt(String(rawLimitParam), 10) : NaN;
    const limit = !dryRun
      ? (Number.isNaN(rawLimit) ? CHUNK_SIZE : Math.max(1, Math.min(CHUNK_SIZE, rawLimit)))
      : (Number.isNaN(rawLimit) ? Math.max(totalCandidates, 1) : Math.max(1, rawLimit));

    const candidateChunk = candidateSkus.slice(offset, offset + limit);
    const nextOffset     = offset + limit < totalCandidates ? offset + limit : null;
    const done           = nextOffset === null;

    // Now, and only now, check "still listed" — for the already-fixed
    // chunk only, to resolve each SKU's real bare/TIRE- listed form and
    // decide skip-vs-retire. This never affects what's "in range" for
    // pagination purposes.
    const chunk: string[] = [];
    const skippedNotListed: string[] = [];
    for (const sku of candidateChunk) {
      const bare = sku.startsWith('TIRE-') ? sku.slice(5) : sku;
      if (listedSkus.has(bare)) chunk.push(bare);
      else if (listedSkus.has(`TIRE-${bare}`)) chunk.push(`TIRE-${bare}`);
      else skippedNotListed.push(sku);
    }

    console.log(
      `[walmart-delist] dryRun=${dryRun} totalInput=${totalInputSkus} currentlyListed=${listedSkus.size} ` +
      `totalCandidates=${totalCandidates} skippedNotListed=${skippedNotListed.length} ` +
      `chunk=${chunk.length} offset=${offset} limit=${limit}`,
    );

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        totalInputSkus,
        ...(keepSkusCount !== undefined ? { keepSkusCount } : {}),
        currentlyListedCount: listedSkus.size,
        willRetireCount: totalCandidates,
        willRetire: chunk,
        skippedNotListed,
        offset, limit, nextOffset, done,
      });
    }

    if (chunk.length === 0) {
      return res.status(200).json({
        ok: true,
        dryRun: false,
        totalInputSkus,
        ...(keepSkusCount !== undefined ? { keepSkusCount } : {}),
        currentlyListedCount: listedSkus.size,
        willRetireCount: totalCandidates,
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
      totalInputSkus,
      ...(keepSkusCount !== undefined ? { keepSkusCount } : {}),
      currentlyListedCount: listedSkus.size,
      willRetireCount: totalCandidates,
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

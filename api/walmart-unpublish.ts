// api/walmart-unpublish.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reversible bulk unpublish/republish for Walmart CA SKUs via the MP_MAINTENANCE
// feed. Unlike walmart-retire.ts (DELETE /v3/items/{sku} — near-permanent),
// this endpoint only flips visibility/publish state — the item stays in the
// catalogue and can be flipped back.
//
//   GET  /api/walmart-unpublish?action=get-spec[&version=4.2&productType=Tires]
//     Diagnostic only, no writes. Calls Walmart's Get Spec API for
//     feedType=MP_MAINTENANCE and returns the raw spec plus a heuristic scan
//     for candidate publish/orderable field names. RUN THIS FIRST — see
//     "Schema verification" below.
//
//   POST /api/walmart-unpublish?action=unpublish|republish[&dryRun=false][&offset=N&limit=300]
//     Body: { skus: string[] }  OR  { tag: string }  (exactly one)
//     Auth: Bearer token matching WALMART_UNPUBLISH_SECRET.
//     dryRun defaults to TRUE — must pass dryRun=false explicitly to write.
//
// ── Schema verification (Step 0) ────────────────────────────────────────────
// Walmart's MP_MAINTENANCE field names vary by spec version and are NOT
// guessable — this file assumes the field below pending confirmation from a
// live GET ?action=get-spec call against a deployed environment (the sandbox
// this file was built in has no Walmart credentials and its network egress
// policy blocks marketplace.walmartapis.com / developer.walmart.com, so the
// live spec could not be fetched at build time — see PR description).
//
// CONFIRMED FIELD: **UNVERIFIED — confirm with action=get-spec before first
// real use, then update buildVisibleBlock() below and this comment.**
// Current assumption (Visible.publishedStatus, matching the task's own
// starting-point draft and the Orderable/Visible wrapper every other CA feed
// in this repo already uses) lives in ONE place — buildVisibleBlock() below —
// so correcting it later is a one-function edit, not a rewrite.
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken, fetchListedSkus, walmartFetch } from './lib/walmart-client.js';

export const config = { maxDuration: 300 };

const WALMART_BASE = (process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com').replace(/\/$/, '');
const SECRET       = process.env.WALMART_UNPUBLISH_SECRET ?? '';

const CHUNK_SIZE           = 300; // matches the repo-wide convention (walmart-retire.ts)
const MAINTENANCE_FEED_TYPE = 'MP_MAINTENANCE';
const DEFAULT_SPEC_VERSION  = '4.2'; // CA v4.x — CONFIRM against action=get-spec output
const DEFAULT_PRODUCT_TYPE  = 'Tires';

type PublishAction = 'unpublish' | 'republish';

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function buildHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN':   token,
    'WM_GLOBAL_VERSION':     '3.1',
    'WM_MARKET':             'ca',
    'WM_SVC.NAME':           'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'Accept':                'application/json',
    ...extra,
  };
}

// ─── Step 0: Get Spec diagnostic ───────────────────────────────────────────

/**
 * Recursively collects key paths whose name looks like a publish/orderable
 * toggle, so whoever runs this against the real API can see the real field
 * without guessing. Purely a search aid — never used to build a payload.
 */
function findCandidateFieldPaths(node: unknown, path = '', out: string[] = []): string[] {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (/publish|orderable|visible$|isActive|sellerActive|lifecycle/i.test(key)) {
        out.push(nextPath);
      }
      findCandidateFieldPaths(value, nextPath, out);
    }
  }
  return out;
}

async function handleGetSpec(req: VercelRequest, res: VercelResponse) {
  const version     = (req.query.version as string) || DEFAULT_SPEC_VERSION;
  const productType = (req.query.productType as string) || DEFAULT_PRODUCT_TYPE;

  const token = await getWalmartToken();
  const url   = `${WALMART_BASE}/v3/items/spec`;
  // feedType/version were first tried as query params — Walmart rejected that
  // shape (400 INVALID_REQUEST.GMP_ITEM_QUERY_API, field "feedType"), so all
  // three documented params (feedType, version, productTypes) go in the body.
  const requestBody = { feedType: MAINTENANCE_FEED_TYPE, version, productTypes: [productType] };

  const walmartRes = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(requestBody),
  });

  const bodyText = await walmartRes.text();

  if (!walmartRes.ok) {
    // Surface Walmart's raw error — on a real deploy this usually names the
    // expected request shape directly, which is the fastest way to correct
    // the request above if this guess at its shape is still wrong.
    return res.status(walmartRes.status).json({
      success: false,
      mode: 'get-spec',
      error: `Walmart Get Spec API ${walmartRes.status}`,
      details: bodyText.slice(0, 2000),
      requestedUrl: url,
      requestedBody: requestBody,
    });
  }

  let spec: unknown;
  try { spec = JSON.parse(bodyText); } catch { spec = bodyText; }

  const candidateFieldPaths = findCandidateFieldPaths(spec);

  return res.status(200).json({
    success: true,
    mode: 'get-spec',
    feedType: MAINTENANCE_FEED_TYPE,
    version,
    productType,
    candidateFieldPaths,
    note: candidateFieldPaths.length
      ? 'Inspect candidateFieldPaths against the raw spec below, confirm the real publish/orderable field, then update buildVisibleBlock() in api/walmart-unpublish.ts.'
      : 'No obvious candidates found by name — inspect the raw spec manually.',
    spec,
  });
}

// ─── Payload builder ───────────────────────────────────────────────────────
// SINGLE point of truth for the maintenance field mapping. If action=get-spec
// reveals a different field/path, this is the only function to change.
function buildVisibleBlock(targetStatus: 'PUBLISHED' | 'UNPUBLISHED') {
  return {
    publishedStatus: targetStatus, // UNVERIFIED — see file header
  };
}

function buildMaintenanceItem(sku: string, action: PublishAction) {
  return {
    sku,
    Visible: buildVisibleBlock(action === 'unpublish' ? 'UNPUBLISHED' : 'PUBLISHED'),
  };
}

// ─── Feed submission (multipart/form-data, per Walmart's feed convention) ──

async function submitMaintenanceFeed(items: ReturnType<typeof buildMaintenanceItem>[]): Promise<string> {
  const token = await getWalmartToken();

  const feedPayload = {
    MPItemFeedHeader: {
      locale:         'en',
      version:        DEFAULT_SPEC_VERSION,
      sellingChannel: 'mpsetupbymatch',
    },
    MPItem: items,
  };

  const form = new FormData();
  form.append(
    'file',
    new Blob([JSON.stringify(feedPayload)], { type: 'application/json' }),
    'mp-maintenance-feed.json',
  );

  const res = await fetch(`${WALMART_BASE}/v3/feeds?feedType=${encodeURIComponent(MAINTENANCE_FEED_TYPE)}`, {
    method: 'POST',
    // No Content-Type here — fetch sets the multipart boundary itself.
    headers: buildHeaders(token),
    body: form,
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Walmart MP_MAINTENANCE feed submit failed ${res.status}: ${bodyText.slice(0, 500)}`);
  }

  const data: any = JSON.parse(bodyText);
  const feedId = data.feedId as string | undefined;
  if (!feedId) throw new Error(`Walmart feed accepted but no feedId returned: ${bodyText.slice(0, 300)}`);
  return feedId;
}

// ─── Walmart lookups ────────────────────────────────────────────────────────
// fetchListedSkus() (from lib/walmart-client) only returns publishedStatus=
// PUBLISHED items — correct for validating *unpublish* targets, but wrong for
// *republish*: a SKU we just unpublished would no longer appear there and a
// republish call would wrongly skip it. This fetches ACTIVE items regardless
// of publishedStatus, for republish validation.
async function fetchAllActiveSkus(): Promise<Set<string>> {
  const skus      = new Set<string>();
  const PAGE_SIZE = 200;
  let offset      = 0;
  let totalItems  = Infinity;
  let page        = 0;

  while (offset < totalItems) {
    const data: any = await walmartFetch<any>(
      `/v3/items?limit=${PAGE_SIZE}&offset=${offset}&lifecycleStatus=ACTIVE`,
    );
    const itemList: any[] = data?.ItemResponse ?? [];

    if (page === 0) totalItems = (data?.totalItems as number) ?? itemList.length;
    for (const item of itemList) {
      const sku = (item.sku ?? '') as string;
      if (sku) skus.add(sku.toUpperCase());
    }

    page++;
    if (itemList.length === 0) break;
    offset += PAGE_SIZE;
  }

  return skus;
}

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
    const action = req.query.action as string | undefined;

    if (action === 'get-spec') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'GET or POST only for action=get-spec' });
      }
      return await handleGetSpec(req, res);
    }

    if (action !== 'unpublish' && action !== 'republish') {
      return res.status(400).json({
        error: 'Missing/invalid action — expected ?action=get-spec | unpublish | republish',
      });
    }

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
      console.log(`[walmart-unpublish] Resolving SKUs from Shopify tag "${tag}"…`);
      inputSkus = await fetchSkusByShopifyTag(tag);
      console.log(`[walmart-unpublish] Tag "${tag}" resolved to ${inputSkus.length} SKUs`);
    } else {
      inputSkus = (body!.skus as unknown[]).map(s => String(s).toUpperCase().trim());
    }

    if (inputSkus.length === 0) {
      return res.status(400).json({ error: 'No SKUs resolved (empty skus array or tag matched nothing)' });
    }

    // ── Confirm each SKU is actually on Walmart before touching it ──────────
    // (bare or TIRE- form — same twin-matching convention as walmart-zero.ts)
    // unpublish targets must currently be PUBLISHED; republish targets just
    // need to still be ACTIVE (fetchListedSkus() would wrongly exclude an
    // already-unpublished SKU — see fetchAllActiveSkus() above).
    console.log(`[walmart-unpublish] Fetching Walmart ${action === 'unpublish' ? 'published' : 'active'} SKUs to validate input…`);
    const listedSkus = action === 'unpublish' ? await fetchListedSkus() : await fetchAllActiveSkus();

    const willProcess: string[] = [];
    const skippedNotListed: string[] = [];

    for (const sku of new Set(inputSkus)) {
      const bare = sku.startsWith('TIRE-') ? sku.slice(5) : sku;
      if (listedSkus.has(bare)) willProcess.push(bare);
      else if (listedSkus.has(`TIRE-${bare}`)) willProcess.push(`TIRE-${bare}`);
      else skippedNotListed.push(sku);
    }

    // ── Pagination ──────────────────────────────────────────────────
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const offset    = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
    const rawLimit  = parseInt(String(req.query.limit ?? String(CHUNK_SIZE)), 10);
    const limit     = Number.isNaN(rawLimit) ? CHUNK_SIZE : Math.max(1, Math.min(CHUNK_SIZE, rawLimit));

    const totalWillProcess = willProcess.length;
    const chunk            = willProcess.slice(offset, offset + limit);
    const nextOffset        = offset + limit < totalWillProcess ? offset + limit : null;
    const done              = nextOffset === null;

    const dryRun = (req.query.dryRun as string | undefined ?? 'true') !== 'false';

    console.log(
      `[walmart-unpublish] action=${action} dryRun=${dryRun} totalInput=${inputSkus.length} ` +
      `willProcess=${totalWillProcess} skippedNotListed=${skippedNotListed.length} ` +
      `chunk=${chunk.length} offset=${offset} limit=${limit}`,
    );

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        action,
        totalInputSkus: inputSkus.length,
        willProcessCount: totalWillProcess,
        willProcess: chunk,
        skippedNotListed,
        offset, limit, nextOffset, done,
      });
    }

    if (chunk.length === 0) {
      return res.status(200).json({
        ok: true, dryRun: false, action,
        totalInputSkus: inputSkus.length,
        willProcessCount: totalWillProcess,
        skippedNotListed,
        offset, limit, nextOffset, done,
        feedId: null,
        submitted: 0,
      });
    }

    // ── Build + submit feed ─────────────────────────────────────────
    const feedItems = chunk.map(sku => buildMaintenanceItem(sku, action));
    const feedId    = await submitMaintenanceFeed(feedItems);

    console.log(`[walmart-unpublish] Feed accepted. feedId=${feedId} action=${action} items=${feedItems.length}`);

    return res.status(200).json({
      ok: true,
      dryRun: false,
      action,
      feedId,
      message: `Feed submitted. Poll /api/walmart-feed-status?feedId=${feedId} to confirm — check itemDetails.itemIngestionStatus[] per SKU.`,
      submitted: feedItems.length,
      totalInputSkus: inputSkus.length,
      willProcessCount: totalWillProcess,
      skippedNotListed,
      offset, limit, nextOffset, done,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[walmart-unpublish] Unhandled error:', message);
    return res.status(500).json({ error: 'Internal error', details: message });
  }
}

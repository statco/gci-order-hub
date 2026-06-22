// api/lib/walmart-client.ts
// ─────────────────────────────────────────────────────────────
// Walmart Global Marketplace API client — Canada
//
// Uses the Walmart Global API (WM_GLOBAL_VERSION: 3.1).
// Auth: OAuth2 client-credentials token passed as WM_SEC.ACCESS_TOKEN.
// There is no Authorization header on API calls.
//
// Env vars:
//   WALMART_CLIENT_ID      — seller client ID
//   WALMART_CLIENT_SECRET  — seller client secret
//   WALMART_BASE_URL       — default: https://marketplace.walmartapis.com
//
// Docs: https://developer.walmart.com/global-marketplace
// ─────────────────────────────────────────────────────────────

import { safeWalmartPrice, assertAboveCost } from './pricing.js';

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

// ─── CREDENTIALS ───────────────────────────────────────────────

function basicCredentials(): string {
  const id     = process.env.WALMART_CLIENT_ID     ?? '';
  const secret = process.env.WALMART_CLIENT_SECRET ?? '';
  if (!id || !secret) {
    throw new Error(
      'Walmart credentials not set. Provide WALMART_CLIENT_ID and WALMART_CLIENT_SECRET.',
    );
  }
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

// ─── TOKEN CACHE ───────────────────────────────────────────────

let _token:    string | null = null;
let _tokenExp: number        = 0;

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;

  const MAX_ATTEMPTS = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * Math.pow(2, attempt - 1); // 1 s, 2 s
      console.warn(`[Walmart auth] retry attempt ${attempt + 1} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    const correlationId = crypto.randomUUID();
    const res = await fetch(`${WALMART_BASE}/v3/token`, {
      method: 'POST',
      headers: {
        'Authorization':         `Basic ${basicCredentials()}`,
        'Content-Type':          'application/x-www-form-urlencoded',
        'WM_SVC.NAME':           'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': correlationId,
        'WM_MARKET':             'ca',
        'Accept':                'application/json',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const errBody = await res.text();
      const isTransient = res.status >= 500; // catches 5xx and Cloudflare 520
      console.error(`[Walmart auth] HTTP ${res.status} (attempt ${attempt + 1})`, errBody.slice(0, 200));
      lastError = new Error(`Walmart auth failed HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      if (isTransient && attempt < MAX_ATTEMPTS - 1) continue;
      // Non-transient (4xx) or last attempt: log full headers and bail
      console.error('[Walmart auth] Request headers sent:', {
        'Content-Type':          'application/x-www-form-urlencoded',
        'WM_SVC.NAME':           'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': correlationId,
        'WM_MARKET':             'ca',
        'Accept':                'application/json',
        'Authorization':         'Basic [REDACTED]',
      });
      throw lastError;
    }

    const data: any = await res.json();
    _token          = data.access_token as string;
    const expiresIn = (data.expires_in as number) ?? 900;
    _tokenExp       = Date.now() + expiresIn * 1000;
    console.log(`✅ Walmart token refreshed, expires in ${expiresIn}s`);
    return _token!;
  }

  throw lastError!;
}

// ─── INTERNAL FETCH ──────────────────────────────────────────────

function buildHeaders(token: string, extra: HeadersInit = {}): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN':   token,
    'WM_GLOBAL_VERSION':     '3.1',
    'WM_MARKET':             'ca',
    'WM_SVC.NAME':           'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'Content-Type':          'application/json',
    'Accept':                'application/json',
    ...(extra as Record<string, string>),
  };
}

/**
 * Low-level fetch that returns raw status + body text instead of throwing.
 * Handles 429 retry automatically. Used by bulk functions for full logging.
 */
async function walmartFetchRaw(
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; ok: boolean; body: string }> {
  const token = await getToken();
  const res   = await fetch(`${WALMART_BASE}${path}`, {
    ...options,
    headers: buildHeaders(token, options.headers as HeadersInit),
  });

  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2_000));
    return walmartFetchRaw(path, options);
  }

  const body = res.status === 204 ? '' : await res.text();
  return { status: res.status, ok: res.ok, body };
}

// Exported so diagnostic endpoints can probe raw responses.
export async function walmartFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { status, ok, body } = await walmartFetchRaw(path, options);
  if (!ok) throw new Error(`Walmart API ${status} on ${path}: ${body.slice(0, 300)}`);
  if (!body) return {} as T;
  return JSON.parse(body) as T;
}

// ─── PUBLIC TYPES ───────────────────────────────────────────────

export interface WalmartPriceItem {
  sku:   string;
  price: number;          // CAD — candidate Shopify price (pre-floor)
  cost?: number | null;   // unit cost; required for the floor to apply. Missing → SKIP.
}

export interface WalmartInventoryItem {
  sku:      string;
  quantity: number;  // real Shopify quantity; 0 only when Shopify shows 0
}

export interface BulkFeedResult {
  success: number;
  failed:  number;
  skippedNoCost?: string[];  // SKUs skipped because cost was missing/invalid
}

// ─── PUBLIC METHODS ───────────────────────────────────────────────

/**
 * Update price for a single SKU.
 *
 * LAYER 1: routes through safeWalmartPrice(). If cost is missing/invalid
 * the write is SKIPPED (returns false) — never guess a price. A final
 * assertion blocks any below-cost amount before the PUT.
 *
 * @returns true if the price was written, false if it was skipped.
 */
export async function updatePrice(item: WalmartPriceItem): Promise<boolean> {
  const safe = safeWalmartPrice({ shopifyPrice: item.price, cost: item.cost ?? null });
  if (safe == null) {
    console.warn(`[price] SKIP ${item.sku}: no valid cost — cannot guarantee safe price`);
    return false;
  }

  const amount = parseFloat(safe.toFixed(2));
  assertAboveCost(item.sku, amount, item.cost ?? null);

  await walmartFetch<any>('/v3/price', {
    method: 'PUT',
    body:   JSON.stringify({
      sku:     item.sku,
      pricing: [{
        currentPriceType: 'BASE',
        currentPrice: {
          currency: 'CAD',
          amount,
        },
      }],
    }),
  });
  return true;
}

/**
 * Update inventory for a single SKU.
 * Writes the caller-supplied quantity verbatim (clamped to ≥ 0). Callers
 * pass the real Shopify quantity — no low-stock suppression. Quantity is 0
 * only when Shopify genuinely shows 0.
 */
export async function updateInventory(item: WalmartInventoryItem): Promise<void> {
  await walmartFetch<any>(`/v3/inventory?sku=${encodeURIComponent(item.sku)}`, {
    method: 'PUT',
    body:   JSON.stringify({
      sku:      item.sku,
      quantity: { unit: 'EACH', amount: Math.max(0, item.quantity) },
    }),
  });
}

export async function bulkPriceFeed(
  items: WalmartPriceItem[]
): Promise<BulkFeedResult> {
  let success            = 0;
  let failed             = 0;
  let firstSuccessLogged = false;
  const skippedNoCost: string[] = [];

  for (const i of items) {
    // LAYER 1: the floor is the only way a price is computed.
    const safe = safeWalmartPrice({ shopifyPrice: i.price, cost: i.cost ?? null });
    if (safe == null) {
      skippedNoCost.push(i.sku);
      continue;
    }

    const amount = parseFloat(safe.toFixed(2));
    // Defense in depth — a below-cost amount throws rather than ships.
    assertAboveCost(i.sku, amount, i.cost ?? null);

    const { status, ok, body } = await walmartFetchRaw('/v3/price', {
      method: 'PUT',
      body: JSON.stringify({
        sku: i.sku,
        pricing: [{
          currentPriceType: 'BASE',
          currentPrice: {
            currency: 'CAD',
            amount,
          },
        }],
      }),
    });

    if (ok) {
      if (!firstSuccessLogged) {
        console.log(`[price] first success SKU ${i.sku} status ${status}:`, body);
        firstSuccessLogged = true;
      }
      success++;
    } else {
      console.error(`[price] SKU ${i.sku} failed ${status}:`, body);
      failed++;
    }
  }

  console.log(`✅ Walmart price: ${success} updated, ${failed} failed, ${skippedNoCost.length} skipped (no cost)`);
  return { success, failed, skippedNoCost };
}

export async function bulkInventoryFeed(
  items: WalmartInventoryItem[]
): Promise<BulkFeedResult> {
  let success            = 0;
  let failed             = 0;
  let firstSuccessLogged = false;

  for (const i of items) {
    const { status, ok, body } = await walmartFetchRaw(
      `/v3/inventory?sku=${encodeURIComponent(i.sku)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          sku: i.sku,
          quantity: { unit: 'EACH', amount: Math.max(0, i.quantity) },
        }),
      },
    );

    if (ok) {
      if (!firstSuccessLogged) {
        console.log(`[inventory] first success SKU ${i.sku} status ${status}:`, body);
        firstSuccessLogged = true;
      }
      success++;
    } else {
      console.error(`[inventory] SKU ${i.sku} failed ${status}:`, body);
      failed++;
    }
  }

  console.log(`✅ Walmart inventory: ${success} updated, ${failed} failed`);
  return { success, failed };
}

/**
 * Fetch all published+active SKUs listed on Walmart using offset-based
 * pagination. Page 1 provides totalItems; subsequent pages increment
 * offset by 200 until all SKUs are collected.
 * Returns a Set for O(1) lookup.
 */
export async function fetchListedSkus(): Promise<Set<string>> {
  const skus       = new Set<string>();
  const PAGE_SIZE  = 200;
  let offset       = 0;
  let totalItems   = Infinity;  // will be set from first response
  let page         = 0;

  while (offset < totalItems) {
    const url    = `/v3/items?limit=${PAGE_SIZE}&offset=${offset}&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`;
    const data: any   = await walmartFetch<any>(url);
    const itemList: any[] = data?.ItemResponse ?? [];

    if (page === 0) {
      totalItems = (data?.totalItems as number) ?? itemList.length;
      console.log(`[fetchListedSkus] totalItems reported by Walmart: ${totalItems}`);
    }

    for (const item of itemList) {
      const sku = (item.sku ?? '') as string;
      if (sku) skus.add(sku.toUpperCase());
    }

    page++;
    console.log(`  Walmart items page ${page}: ${itemList.length} items (offset ${offset}), total so far: ${skus.size}`);

    if (itemList.length === 0) break;  // guard against empty pages
    offset += PAGE_SIZE;
  }

  console.log(`[fetchListedSkus] done: ${skus.size} unique SKUs fetched (totalItems=${totalItems})`);
  return skus;
}

/**
 * Poll the status of a submitted feed.
 */
export async function getFeedStatus(feedId: string): Promise<any> {
  return walmartFetch<any>(`/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true`);
}

/** Re-exported for callers that need a raw token for custom fetch calls. */
export const getWalmartToken = getToken;

/**
 * Retire (permanently remove) a single item from the Walmart catalogue.
 * Uses DELETE /v3/items/{sku}. Returns true on success, false on a benign
 * "already gone" response (404/410), and throws on unexpected errors.
 */
export async function retireItem(sku: string): Promise<boolean> {
  const { status, ok, body } = await walmartFetchRaw(
    `/v3/items/${encodeURIComponent(sku)}`,
    { method: 'DELETE' },
  );

  if (ok || status === 204) return true;

  // 404/410 → item already absent; treat as idempotent success
  if (status === 404 || status === 410) {
    console.log(`[retireItem] ${sku} already absent (${status}) — treating as success`);
    return true;
  }

  throw new Error(`Walmart retire ${sku} failed HTTP ${status}: ${body.slice(0, 200)}`);
}

/**
 * Check whether a single Walmart item is still live after a DELETE.
 * Returns 'NOT_FOUND' (404/410 → retire confirmed) or 'LIVE' (still in catalog).
 * A brief propagation delay is expected; callers should treat 'LIVE' as pending,
 * not as a failure — accepted ≠ applied.
 */
export async function getItemLifecycleStatus(sku: string): Promise<'NOT_FOUND' | 'LIVE'> {
  const { status } = await walmartFetchRaw(`/v3/items/${encodeURIComponent(sku)}`);
  if (status === 404 || status === 410) return 'NOT_FOUND';
  return 'LIVE';
}

/**
 * Chunk an array for Walmart's 1 000-item feed limit.
 */
export function chunkArray<T>(arr: T[], size = 1_000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

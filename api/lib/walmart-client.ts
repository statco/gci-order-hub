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

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

// ─── CREDENTIALS ─────────────────────────────────────────────

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

// ─── TOKEN CACHE ─────────────────────────────────────────────

let _token:    string | null = null;
let _tokenExp: number        = 0;

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;

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
    console.error('[Walmart auth] HTTP', res.status, 'Body:', errBody);
    console.error('[Walmart auth] Request headers sent:', {
      'Content-Type':          'application/x-www-form-urlencoded',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': correlationId,
      'WM_MARKET':             'ca',
      'Accept':                'application/json',
      'Authorization':         'Basic [REDACTED]',
    });
    throw new Error(`Walmart auth failed HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data: any = await res.json();
  _token          = data.access_token as string;
  const expiresIn = (data.expires_in as number) ?? 900;
  _tokenExp       = Date.now() + expiresIn * 1000;
  console.log(`✅ Walmart token refreshed, expires in ${expiresIn}s`);
  return _token!;
}

// ─── INTERNAL FETCH ───────────────────────────────────────────

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

async function walmartFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { status, ok, body } = await walmartFetchRaw(path, options);
  if (!ok) throw new Error(`Walmart API ${status} on ${path}: ${body.slice(0, 300)}`);
  if (!body) return {} as T;
  return JSON.parse(body) as T;
}

// ─── PUBLIC TYPES ─────────────────────────────────────────────

export interface WalmartPriceItem {
  sku:   string;
  price: number;   // CAD, two decimal places
}

export interface WalmartInventoryItem {
  sku:      string;
  quantity: number;  // 0 to suppress listing
}

export interface BulkFeedResult {
  success: number;
  failed:  number;
}

// ─── PUBLIC METHODS ───────────────────────────────────────────

/**
 * Update price for a single SKU.
 */
export async function updatePrice(item: WalmartPriceItem): Promise<void> {
  await walmartFetch<any>('/v3/price', {
    method: 'PUT',
    body:   JSON.stringify({
      sku:     item.sku,
      pricing: [{
        currentPriceType: 'BASE',
        currentPrice: {
          currency: 'CAD',
          amount:   parseFloat(item.price.toFixed(2)),
        },
      }],
    }),
  });
}

/**
 * Update inventory for a single SKU.
 * SAFETY: pass qty=0 explicitly when Shopify stock is below threshold.
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

  for (const i of items) {
    const { status, ok, body } = await walmartFetchRaw('/v3/price', {
      method: 'PUT',
      body: JSON.stringify({
        sku: i.sku,
        pricing: [{
          currentPriceType: 'BASE',
          currentPrice: {
            currency: 'CAD',
            amount: parseFloat(i.price.toFixed(2)),
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

  console.log(`✅ Walmart price: ${success} updated, ${failed} failed`);
  return { success, failed };
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
 * Fetch all SKUs that are currently listed on Walmart by paginating
 * GET /v3/items via nextCursor. Returns a Set for O(1) lookup.
 */
export async function fetchListedSkus(): Promise<Set<string>> {
  const skus = new Set<string>();
  let nextCursor: string | null = null;
  let page = 0;

  do {
    const url = `/v3/items?limit=20${nextCursor ? `&nextCursor=${encodeURIComponent(nextCursor)}` : ''}`;
    const data: any = await walmartFetch<any>(url);
    const itemList: any[] = data?.ItemResponse ?? [];
    for (const item of itemList) {
      const sku = (item.sku ?? '') as string;
      if (sku) skus.add(sku);
    }
    nextCursor = (data?.nextCursor as string) || null;
    page++;
    console.log(`  Walmart items page ${page}: ${itemList.length} items, total so far: ${skus.size}${nextCursor ? '' : ' (done)'}`);
  } while (nextCursor);

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
 * Chunk an array for Walmart's 1 000-item feed limit.
 */
export function chunkArray<T>(arr: T[], size = 1_000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

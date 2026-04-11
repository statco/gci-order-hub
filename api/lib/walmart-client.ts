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

async function walmartFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getToken();

  const res = await fetch(`${WALMART_BASE}${path}`, {
    ...options,
    headers: {
      'WM_SEC.ACCESS_TOKEN':   token,
      'WM_GLOBAL_VERSION':     '3.1',
      'WM_MARKET':             'ca',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'Content-Type':          'application/json',
      'Accept':                'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2_000));
    return walmartFetch<T>(path, options);
  }
  if (res.status === 204) return {} as T;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Walmart API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
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

// ─── PUBLIC METHODS ───────────────────────────────────────────

/**
 * Update price for a single SKU.
 */
export async function updatePrice(item: WalmartPriceItem): Promise<void> {
  await walmartFetch<any>('/v3/price', {
    method: 'PUT',
    body:   JSON.stringify({
      sku:     item.sku,
      pricing: {
        currentPrice: {
          currency: 'CAD',
          amount:   parseFloat(item.price.toFixed(2)),
        },
      },
    }),
  });
}

/**
 * Update inventory for a single SKU.
 * SAFETY: pass qty=0 explicitly when Shopify stock is below threshold.
 */
export async function updateInventory(item: WalmartInventoryItem): Promise<void> {
  await walmartFetch<any>('/v3/inventory', {
    method: 'PUT',
    body:   JSON.stringify({
      sku:      item.sku,
      quantity: { unit: 'EACH', amount: Math.max(0, item.quantity) },
    }),
  });
}

export async function bulkInventoryFeed(
  items: WalmartInventoryItem[]
): Promise<string> {
  let success = 0;
  let failed = 0;
  for (const i of items) {
    try {
      await walmartFetch<any>('/v3/inventory', {
        method: 'PUT',
        body: JSON.stringify({
          sku: i.sku,
          quantity: { unit: 'EACH', amount: Math.max(0, i.quantity) },
        }),
      });
      success++;
      // small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 50));
    } catch (err: any) {
      console.error(`❌ inventory failed for ${i.sku}: ${err.message}`);
      failed++;
    }
  }
  console.log(`✅ Walmart inventory: ${success} updated, ${failed} failed`);
  return `inventory-done-${success}-${failed}`;
}

export async function bulkPriceFeed(
  items: WalmartPriceItem[]
): Promise<string> {
  let success = 0;
  let failed = 0;
  for (const i of items) {
    try {
      await walmartFetch<any>('/v3/price', {
        method: 'PUT',
        body: JSON.stringify({
          sku: i.sku,
          pricing: {
            currentPrice: {
              currency: 'CAD',
              amount: parseFloat(i.price.toFixed(2)),
            },
          },
        }),
      });
      success++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err: any) {
      console.error(`❌ price failed for ${i.sku}: ${err.message}`);
      failed++;
    }
  }
  console.log(`✅ Walmart price: ${success} updated, ${failed} failed`);
  return `price-done-${success}-${failed}`;
}

/**
 * Poll the status of a submitted feed.
 */
export async function getFeedStatus(feedId: string): Promise<any> {
  return walmartFetch<any>(`/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true`);
}

/**
 * Chunk an array for Walmart's 1 000-item feed limit.
 */
export function chunkArray<T>(arr: T[], size = 1_000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

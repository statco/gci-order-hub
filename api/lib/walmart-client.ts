// api/lib/walmart-client.ts
// ─────────────────────────────────────────────────────────────
// Walmart Marketplace API client — Canada V3
//
// Auth strategy (tried in order per request):
//   1. Bearer token via OAuth2 client-credentials flow
//   2. Basic auth fallback (Base64 clientId:clientSecret)
//
// Both paths include the Canada-required headers:
//   WM_TENANT_ID, WM_LOCALE_ID, WM_MARKET
//
// Env vars:
//   WALMART_CLIENT_ID      — seller client ID
//   WALMART_CLIENT_SECRET  — seller client secret
//   WALMART_BASE_URL       — default: https://marketplace.walmartapis.com
//   WALMART_MARKET         — default: CA
//
// Docs: https://developer.walmart.com/doc/ca/mp/
// ─────────────────────────────────────────────────────────────

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

// ─── CREDENTIALS ─────────────────────────────────────────────

function getCredentials(): { id: string; secret: string } {
  const id     = process.env.WALMART_CLIENT_ID     ?? '';
  const secret = process.env.WALMART_CLIENT_SECRET ?? '';
  if (!id || !secret) {
    throw new Error(
      'Walmart credentials not set. Provide WALMART_CLIENT_ID and WALMART_CLIENT_SECRET.',
    );
  }
  return { id, secret };
}

function basicCredentials(): string {
  const { id, secret } = getCredentials();
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

// ─── TOKEN CACHE ─────────────────────────────────────────────

let _token:    string | null = null;
let _tokenExp: number        = 0;

async function getToken(): Promise<string | null> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;

  try {
    const correlationId = crypto.randomUUID();
    const res = await fetch(`${WALMART_BASE}/v3/token`, {
      method: 'POST',
      headers: {
        'Authorization':         `Basic ${basicCredentials()}`,
        'Content-Type':          'application/x-www-form-urlencoded',
        'WM_SVC.NAME':           'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': correlationId,
        'WM_MARKET':             process.env.WALMART_MARKET || 'CA',
        'Accept':                'application/json',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.warn('[Walmart auth] Token fetch failed HTTP', res.status, errBody.slice(0, 200));
      return null;
    }

    const data: any = await res.json();
    _token          = data.access_token as string;
    const expiresIn = (data.expires_in as number) ?? 900;
    _tokenExp       = Date.now() + expiresIn * 1000;
    console.log(`✅ Walmart token refreshed, expires in ${expiresIn}s`);
    return _token!;
  } catch (err) {
    console.warn('[Walmart auth] Token fetch threw:', err);
    return null;
  }
}

// ─── CANADA-REQUIRED HEADERS ─────────────────────────────────

const CA_HEADERS = {
  'WM_SVC.NAME':   'Walmart Marketplace',
  'WM_MARKET':     process.env.WALMART_MARKET || 'CA',
  'WM_TENANT_ID':  'WALMART.CA',
  'WM_LOCALE_ID':  'en_CA',
  'Accept':        'application/json',
} as const;

// ─── INTERNAL FETCH ───────────────────────────────────────────

async function walmartFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token         = await getToken();
  const correlationId = crypto.randomUUID();

  // Attempt 1: Bearer token (if available)
  if (token) {
    const res = await fetch(`${WALMART_BASE}${path}`, {
      ...options,
      headers: {
        'Authorization':         `Bearer ${token}`,
        'Content-Type':          'application/json',
        'WM_QOS.CORRELATION_ID': correlationId,
        ...CA_HEADERS,
        ...(options.headers ?? {}),
      },
    });

    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2_000));
      return walmartFetch<T>(path, options);
    }
    if (res.status === 204) return {} as T;
    if (res.ok)             return res.json() as Promise<T>;

    // 401/403 — fall through to Basic auth retry
    if (res.status !== 401 && res.status !== 403) {
      const body = await res.text();
      throw new Error(`Walmart API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    console.warn(`[Walmart] Bearer auth got ${res.status}, retrying with Basic auth`);
  }

  // Attempt 2 (fallback): Basic auth
  const res = await fetch(`${WALMART_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization':         `Basic ${basicCredentials()}`,
      'Content-Type':          'application/json',
      'WM_QOS.CORRELATION_ID': correlationId,
      ...CA_HEADERS,
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
  await walmartFetch<any>(`/v3/inventory?sku=${encodeURIComponent(item.sku)}`, {
    method: 'PUT',
    body:   JSON.stringify({
      sku:      item.sku,
      quantity: { unit: 'EACH', amount: Math.max(0, item.quantity) },
    }),
  });
}

/**
 * Bulk inventory feed — up to 1 000 items per call.
 * Returns the Walmart feed ID for status polling.
 */
export async function bulkInventoryFeed(items: WalmartInventoryItem[]): Promise<string> {
  const body = {
    InventoryHeader: { version: '1.4' },
    item: items.map(i => ({
      sku:      i.sku,
      quantity: { unit: 'EACH', amount: Math.max(0, i.quantity) },
    })),
  };

  const data: any = await walmartFetch<any>('/v3/inventory', {
    method: 'PUT',
    body:   JSON.stringify(body),
  });

  const feedId = (data?.feedId ?? data?.FeedId ?? 'unknown') as string;
  console.log(`✅ Walmart bulk inventory feed: feedId=${feedId}, items=${items.length}`);
  return feedId;
}

/**
 * Bulk price feed — up to 1 000 items per call.
 * Returns the Walmart feed ID for status polling.
 */
export async function bulkPriceFeed(items: WalmartPriceItem[]): Promise<string> {
  const body = {
    PriceHeader: { version: '1.7' },
    Price: items.map(i => ({
      sku:     i.sku,
      pricing: {
        currentPrice: {
          currency: 'CAD',
          amount:   parseFloat(i.price.toFixed(2)),
        },
      },
    })),
  };

  const data: any = await walmartFetch<any>('/v3/price', {
    method: 'PUT',
    body:   JSON.stringify(body),
  });

  const feedId = (data?.feedId ?? data?.FeedId ?? 'unknown') as string;
  console.log(`✅ Walmart bulk price feed: feedId=${feedId}, items=${items.length}`);
  return feedId;
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

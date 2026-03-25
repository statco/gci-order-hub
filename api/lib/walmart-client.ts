// api/lib/walmart-client.ts
// ─────────────────────────────────────────────────────────────
// Walmart Marketplace API client — Basic auth (Canada)
//
// Walmart Canada requires Basic auth (Base64 clientId:clientSecret)
// on every request. There is no OAuth token flow for this market.
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

// ─── INTERNAL FETCH ───────────────────────────────────────────

async function walmartFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${WALMART_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization':         `Basic ${basicCredentials()}`,
      'Content-Type':          'application/json',
      'Accept':                'application/json',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'WM_MARKET':             process.env.WALMART_MARKET || 'CA',
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

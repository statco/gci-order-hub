// api/lib/cj-client.ts
// ─────────────────────────────────────────────────────────────
// CJ Dropshipping API v2 client
//
// Auth strategy (in priority order):
//   1. CJ_API_KEY  — static key from CJ developer portal (never expires)
//   2. CJ_EMAIL + CJ_PASSWORD — email/password auth, token auto-refreshed
//
// Token is cached in-process and refreshed transparently before expiry.
//
// API docs: https://developers.cjdropshipping.com/api2.0/v1/
// ─────────────────────────────────────────────────────────────

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// ─── TOKEN CACHE ─────────────────────────────────────────────

let _token:    string | null = null;
let _tokenExp: number        = 0;    // unix ms

async function getAccessToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;

  // Option A — static API key
  const apiKey = process.env.CJ_API_KEY || '';
  if (apiKey) {
    _token    = apiKey;
    _tokenExp = Date.now() + 365 * 24 * 60 * 60 * 1000;
    return _token;
  }

  // Option B — email / password
  const email    = process.env.CJ_EMAIL    || '';
  const password = process.env.CJ_PASSWORD || '';
  if (!email || !password) {
    throw new Error(
      'CJ Dropshipping credentials not set. ' +
      'Provide CJ_API_KEY or both CJ_EMAIL and CJ_PASSWORD.',
    );
  }

  const res  = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password }),
  });
  const data: any = await res.json();

  if (!data.result || !data.data?.accessToken) {
    throw new Error(`CJ auth failed: ${JSON.stringify(data.message ?? data)}`);
  }

  _token    = data.data.accessToken as string;
  _tokenExp = Date.now() + 55 * 60 * 1000; // CJ tokens last ~1h; refresh at 55m
  console.log('✅ CJ Dropshipping token refreshed');
  return _token!;
}

// ─── INTERNAL FETCH ───────────────────────────────────────────

async function cjFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res   = await fetch(`${CJ_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type':    'application/json',
      'CJ-Access-Token': token,
      ...(options.headers ?? {}),
    },
  });
  const data: any = await res.json();
  if (!data.result) {
    throw new Error(`CJ API error on ${path}: ${JSON.stringify(data.message ?? data)}`);
  }
  return data.data as T;
}

// ─── PUBLIC TYPES ─────────────────────────────────────────────

export interface CJProduct {
  /** CJ variant ID (vid). For NUPROZ- SKUs, vid = SKU.replace('NUPROZ-', '') */
  vid:      string;
  quantity: number;
}

export interface CJOrderInput {
  orderNumber:          string;   // Shopify order name e.g. "#1042"
  shippingCountry:      string;   // ISO-2 e.g. "CA"
  shippingCustomerName: string;
  shippingPhone:        string;
  shippingAddress:      string;
  shippingAddress2?:    string;
  shippingCity:         string;
  shippingProvince:     string;
  shippingZip:          string;
  products:             CJProduct[];
}

export interface CJOrderResult {
  orderId:     string;
  orderNumber: string;
  status:      string;
}

// ─── PUBLIC METHODS ───────────────────────────────────────────

/**
 * Create a PENDING CJ order — NOT yet submitted to the supplier.
 * Call submitOrder() after manual authorization to confirm.
 */
export async function createOrder(input: CJOrderInput): Promise<CJOrderResult> {
  const result = await cjFetch<any>('/shopping/order/createOrderV2', {
    method: 'POST',
    body:   JSON.stringify({
      orderNumber:          input.orderNumber,
      shippingCountry:      input.shippingCountry,
      shippingCustomerName: input.shippingCustomerName,
      shippingPhone:        input.shippingPhone,
      shippingAddress:      input.shippingAddress,
      shippingAddress2:     input.shippingAddress2 ?? '',
      shippingCity:         input.shippingCity,
      shippingProvince:     input.shippingProvince,
      shippingZip:          input.shippingZip,
      products:             input.products,
      payType:              'NORMAL',
      iossNumber:           '',
    }),
  });

  return {
    orderId:     result.orderId     ?? result.id ?? '',
    orderNumber: result.orderNumber ?? input.orderNumber,
    status:      result.orderStatus ?? 'PENDING',
  };
}

/**
 * Submit a previously-created PENDING order to the supplier.
 * Called by /api/authorize-order after manual payment authorization.
 */
export async function submitOrder(cjOrderId: string): Promise<void> {
  await cjFetch<any>('/shopping/order/confirmOrder', {
    method: 'POST',
    body:   JSON.stringify({ orderId: cjOrderId }),
  });
  console.log(`✅ CJ order ${cjOrderId} confirmed and submitted to supplier`);
}

/**
 * Get the current status of a CJ order.
 */
export async function getOrderStatus(cjOrderId: string): Promise<string> {
  const data = await cjFetch<any>(
    `/shopping/order/getOrderDetail?orderId=${encodeURIComponent(cjOrderId)}`,
  );
  return (data?.orderStatus as string) ?? 'UNKNOWN';
}

/**
 * Look up a CJ variant ID by SKU (useful for validation).
 */
export async function findVariantBySku(sku: string): Promise<string | null> {
  try {
    const data = await cjFetch<any>(
      `/product/variant/queryBySkuId?skuId=${encodeURIComponent(sku)}`,
    );
    return (data?.vid as string) ?? null;
  } catch {
    return null;
  }
}

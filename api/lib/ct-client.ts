// api/lib/ct-client.ts
//
// Canada Tire Customer API client — implements the REAL contract from
// "Canada Tire Customer API Guide V1.4" (released 11/04/2025).
//
// ─── WHAT CHANGED AND WHY ────────────────────────────────────────────────────
// The previous version of this file was written BEFORE CT supplied any
// documentation. Its submitPurchaseOrder() payload was an explicitly-labelled
// guess at "typical NetSuite PO fields". Every one of those guesses except
// `partNumber`/`quantity` was wrong. This file replaces the guess with the
// documented contract:
//
//   guessed                     →  actual (V1.4)
//   ─────────────────────────────────────────────────────────────────────
//   externalRefId               →  orderDetails.poNumber
//   lines[]                     →  orderDetails.items[]
//   shipTo{ address1, ... }     →  orderDetails.shipping{ addr1, ... }
//   (absent)                    →  orderDetails.location   ← MANDATORY
//   data.ctPurchaseOrderId      →  data.id + data.orderNumber
//
// ─── SAFETY MODEL (read before enabling anything) ────────────────────────────
// Three independent gates must ALL be satisfied before a real order is placed:
//
//   1. CT_AUTO_PO_ENABLED = 'true'      (unchanged from before; default off)
//   2. CT_DRY_RUN         = 'false'     (NEW; defaults to TRUE = never submits)
//   3. CT_ENVIRONMENT     = 'production' (NEW; defaults to 'sandbox')
//
// Defaults are deliberately the safe ones. Deploying this file with no env
// changes results in byte-for-byte identical behavior to today: order-router.ts
// never calls into here, and if it did, it would dry-run against sandbox.
//
// ─── CRITICAL: HTTP 200 DOES NOT MEAN SUCCESS ────────────────────────────────
// Per the guide (Errors §): a 200 means OAuth 1.0 authentication succeeded and
// the request was received — it says NOTHING about whether the request worked.
// Every response carries { success: Boolean, error: { code, errorMsg } } and
// MUST be checked on that, never on res.ok alone. Notably, error.code 401
// inside a 200 body means the Customer Token and Customer ID do not match.
// assertCtOk() below enforces this on every single call.
//
// ─── DO NOT TOUCH gci-brain/api/shopifySync.ts ───────────────────────────────
// That file holds the live, working, production catalog integration. This
// client is standalone and does not import from or modify it. If CT's auth
// ever changes, change it there first, verify in production, then port here.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

// ─── Environment / configuration ─────────────────────────────────────────────

export type CTEnvironment = 'sandbox' | 'production';

/** Defaults to 'sandbox'. Production requires an explicit opt-in. */
export const CT_ENVIRONMENT: CTEnvironment =
  (process.env.CT_ENVIRONMENT || '').toLowerCase() === 'production' ? 'production' : 'sandbox';

/** Master switch, unchanged from the previous version. Default OFF. */
export const CT_AUTO_PO_ENABLED = process.env.CT_AUTO_PO_ENABLED === 'true';

/**
 * Dry run. Defaults to TRUE — you must explicitly set CT_DRY_RUN='false' to
 * transmit anything. In dry-run the fully-built payload is returned and logged
 * but never sent, so it can be eyeballed against a known-good manual PO.
 */
export const CT_DRY_RUN = process.env.CT_DRY_RUN !== 'false';

// Account IDs are documented constants (guide, Authentication §). Overridable
// via env purely so a future account migration doesn't require a code change.
const ACCOUNT_ID =
  CT_ENVIRONMENT === 'production'
    ? process.env.CT_ACCOUNT_ID_PROD || '8031691'
    : process.env.CT_ACCOUNT_ID_SANDBOX || '8031691_SB1';

// Realm is the account id as-is (with underscore). Hostname lowercases it and
// replaces '_' with '-'  →  8031691_SB1  ⇒  8031691-sb1.restlets...
const REALM = ACCOUNT_ID;
const HOST = `${ACCOUNT_ID.toLowerCase().replace(/_/g, '-')}.restlets.api.netsuite.com`;
const RESTLET_URL = `https://${HOST}/app/site/hosting/restlet.nl`;

/**
 * Sandbox may use different TBA credentials than production — per the guide,
 * sandbox credentials are issued separately by your CT sales rep. If the
 * CT_SANDBOX_* vars are absent we fall back to the main ones, which is correct
 * for the (common) case where CT issued a single credential set.
 */
function creds() {
  const sb = CT_ENVIRONMENT === 'sandbox';
  return {
    consumerKey:    (sb && process.env.CT_SANDBOX_CONSUMER_KEY)    || process.env.CT_CONSUMER_KEY    || '',
    consumerSecret: (sb && process.env.CT_SANDBOX_CONSUMER_SECRET) || process.env.CT_CONSUMER_SECRET || '',
    tokenId:        (sb && process.env.CT_SANDBOX_TOKEN_ID)        || process.env.CT_TOKEN_ID        || '',
    tokenSecret:    (sb && process.env.CT_SANDBOX_TOKEN_SECRET)    || process.env.CT_TOKEN_SECRET    || '',
    customerId:     (sb && process.env.CT_SANDBOX_CUSTOMER_ID)     || process.env.CT_CUSTOMER_ID     || process.env.CT_CUSTOMER_NUMBER || '19997',
    customerToken:  (sb && process.env.CT_SANDBOX_CUSTOMER_TOKEN)  || process.env.CT_CUSTOMER_API_TOKEN || '',
  };
}

// RESTlet script/deploy pairs — all documented in V1.4. These are stable
// identifiers, not secrets; env overrides exist only for future-proofing.
const SCRIPTS = {
  productSearch: {
    script: process.env.CT_SCRIPT        || 'customscript_item_search_rl',
    deploy: process.env.CT_DEPLOY        || 'customdeploy_item_search_rl',
  },
  wheelSearch: {
    script: process.env.CT_WHEEL_SCRIPT  || 'customscript_cda_wheel_search_rl',
    deploy: process.env.CT_WHEEL_DEPLOY  || 'customdeploycda_wheel_search_rl',
  },
  shipToSearch: {
    script: process.env.CT_ADDR_SCRIPT   || 'customscript_get_cust_addr_rl',
    deploy: process.env.CT_ADDR_DEPLOY   || 'customdeploy_get_cust_addr_rl',
  },
  createOrder: {
    script: process.env.CT_PO_SCRIPT     || 'customscript_create_sales_order_rl',
    deploy: process.env.CT_PO_DEPLOY     || 'customdeploy_create_sales_order_rl',
  },
  updateOrderAddr: {
    script: process.env.CT_UPD_ADDR_SCRIPT || 'customscript_update_order_addr_rl',
    deploy: process.env.CT_UPD_ADDR_DEPLOY || 'customdeploy_update_order_addr_rl',
  },
} as const;

const TIMEOUT_MS = Number(process.env.CT_TIMEOUT_MS || 30_000);

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Kept for backward compatibility — order-router.ts catches this by name. */
export class CTNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CTNotConfiguredError';
  }
}

/** OAuth failed (HTTP 401), or customerId/customerToken mismatch (body 401). */
export class CTAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CTAuthError';
  }
}

/** CT rejected the payload (body error.code 400). Do NOT retry — it will fail identically. */
export class CTValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CTValidationError';
  }
}

/** CT-side failure (body error.code 500) or transport failure. Retryable — but see submitOrder(). */
export class CTServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CTServerError';
  }
}

// ─── OAuth 1.0a (TBA) ────────────────────────────────────────────────────────
// Per the guide: HMAC-SHA256, and the signature base must include `script` and
// `deploy` alongside the oauth_* params, sorted alphabetically. Sorting the
// merged map handles this — 'deploy' < 'oauth_*' < 'script' falls out naturally.

const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function buildAuthHeader(script: string, deploy: string): string {
  const c = creds();
  const oauth: Record<string, string> = {
    oauth_consumer_key:     c.consumerKey,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            c.tokenId,
    oauth_version:          '1.0',
  };

  const all: Record<string, string> = { deploy, script, ...oauth };
  const paramString = Object.keys(all).sort().map(k => `${pct(k)}=${pct(all[k])}`).join('&');
  const baseString  = ['POST', pct(RESTLET_URL), pct(paramString)].join('&');
  const signingKey  = `${pct(c.consumerSecret)}&${pct(c.tokenSecret)}`;
  const signature   = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  const parts = { ...oauth, oauth_signature: signature };
  return `OAuth realm="${pct(REALM)}", ` +
    Object.keys(parts).map(k => `${pct(k)}="${pct(parts[k as keyof typeof parts])}"`).join(', ');
}

// ─── Transport ───────────────────────────────────────────────────────────────

interface CTEnvelope<T> {
  data: T;
  success: boolean;
  error?: { code?: number | string; errorMsg?: string };
}

function assertConfigured() {
  const c = creds();
  const missing: string[] = [];
  if (!c.consumerKey)    missing.push('CT_CONSUMER_KEY');
  if (!c.consumerSecret) missing.push('CT_CONSUMER_SECRET');
  if (!c.tokenId)        missing.push('CT_TOKEN_ID');
  if (!c.tokenSecret)    missing.push('CT_TOKEN_SECRET');
  if (!c.customerToken)  missing.push('CT_CUSTOMER_API_TOKEN');
  if (missing.length) {
    throw new CTNotConfiguredError(
      `Canada Tire credentials not configured for env='${CT_ENVIRONMENT}'. Missing: ${missing.join(', ')}.`
    );
  }
}

/**
 * The `success` flag — not the HTTP status — is the source of truth.
 * See the header comment: a 200 only confirms OAuth succeeded.
 */
function assertCtOk<T>(endpoint: string, httpStatus: number, body: CTEnvelope<T>): T {
  if (body?.success === true) return body.data;

  const code = body?.error?.code;
  const msg  = body?.error?.errorMsg || '(no errorMsg returned)';
  const detail = `CT ${endpoint} failed (http ${httpStatus}, ct code ${code ?? 'none'}): ${msg}`;

  if (String(code) === '401') {
    throw new CTAuthError(
      `${detail} — per CT's guide this specifically means customerId and customerToken do not match. ` +
      `Currently sending customerId='${creds().customerId}' against env='${CT_ENVIRONMENT}'.`
    );
  }
  if (String(code) === '400') throw new CTValidationError(detail);
  if (String(code) === '500') throw new CTServerError(detail);
  throw new CTServerError(detail);
}

async function ctPost<T>(
  endpoint: keyof typeof SCRIPTS,
  payload: Record<string, unknown>,
): Promise<T> {
  assertConfigured();
  const { script, deploy } = SCRIPTS[endpoint];
  const url = `${RESTLET_URL}?script=${encodeURIComponent(script)}&deploy=${encodeURIComponent(deploy)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  buildAuthHeader(script, deploy),
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new CTServerError(
      `CT ${endpoint}: transport failure (${err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err?.message}).`
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  // HTTP 401 = OAuth itself failed, before CT looked at the body at all.
  if (res.status === 401) {
    throw new CTAuthError(
      `CT ${endpoint}: OAuth 1.0 authentication rejected (HTTP 401) against realm='${REALM}'. ` +
      `Check TBA credentials and that they belong to env='${CT_ENVIRONMENT}'. Body: ${text.slice(0, 300)}`
    );
  }

  let body: CTEnvelope<T>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CTServerError(`CT ${endpoint}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  return assertCtOk<T>(endpoint, res.status, body);
}

// ─── Normalization helpers ───────────────────────────────────────────────────
// The guide is explicit: province and country must be UPPERCASE shorthand
// codes and are case sensitive. Shopify already gives us province_code, but
// Walmart payloads and manual entry do not reliably.

const PROVINCE_CODES: Record<string, string> = {
  'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'COLOMBIE-BRITANNIQUE': 'BC',
  'MANITOBA': 'MB', 'NEW BRUNSWICK': 'NB', 'NOUVEAU-BRUNSWICK': 'NB',
  'NEWFOUNDLAND AND LABRADOR': 'NL', 'TERRE-NEUVE-ET-LABRADOR': 'NL',
  'NORTHWEST TERRITORIES': 'NT', 'NOVA SCOTIA': 'NS', 'NOUVELLE-ÉCOSSE': 'NS',
  'NUNAVUT': 'NU', 'ONTARIO': 'ON', 'PRINCE EDWARD ISLAND': 'PE',
  'ÎLE-DU-PRINCE-ÉDOUARD': 'PE', 'QUEBEC': 'QC', 'QUÉBEC': 'QC',
  'SASKATCHEWAN': 'SK', 'YUKON': 'YT',
};

export function normalizeProvince(input: string): string {
  const v = (input || '').trim();
  if (!v) return '';
  if (v.length === 2) return v.toUpperCase();
  return PROVINCE_CODES[v.toUpperCase()] || v.toUpperCase();
}

export function normalizeCountry(input: string): string {
  const v = (input || '').trim().toUpperCase();
  if (!v) return 'CA';
  if (v === 'CANADA') return 'CA';
  if (v === 'UNITED STATES' || v === 'USA' || v === 'UNITED STATES OF AMERICA') return 'US';
  return v.slice(0, 2);
}

// ─── Product search (read-only) ──────────────────────────────────────────────

export interface CTInventoryLevel { location: string; quantity: number; }

export interface CTProduct {
  partNumber: string;
  name: string;
  performanceCategory?: string;
  brand?: string;
  model?: string;
  size?: string;
  isWinter?: boolean;
  isRunFlat?: boolean;
  isTire?: boolean;
  isWheel?: boolean;
  cost: string;
  msrp: string;
  inventory: CTInventoryLevel[];
}

export interface CTProductFilters {
  width?: number;
  rimSize?: number;
  aspectRatio?: number;
  size?: string;
  partNumber?: string[];
  brand?: string;
  searchKey?: string;
  isWinter?: boolean;
  isRunFlat?: boolean;
  isTire?: boolean;
  isWheel?: boolean;
  page?: number;
}

/**
 * Search CT's catalog. Returns real `cost` and per-location inventory — this
 * is what makes location selection and margin checks possible, and it removes
 * the need for the hardcoded TIRE_COST_RATIO guess in order-router.ts.
 */
export async function searchProducts(filters: CTProductFilters): Promise<CTProduct[]> {
  const c = creds();
  const data = await ctPost<CTProduct[]>('productSearch', {
    customerId:    c.customerId,
    customerToken: c.customerToken,
    filters,
  });
  return data || [];
}

/** Convenience: look up exactly one part number. Returns null if not found. */
export async function findPart(partNumber: string): Promise<CTProduct | null> {
  const results = await searchProducts({ partNumber: [partNumber] });
  return results.find(p => p.partNumber === partNumber) || results[0] || null;
}

// ─── Ship-to address book (read-only) ────────────────────────────────────────

export interface CTShipToAddress {
  addrId: number;
  attention?: string;
  addressee?: string;
  addr1: string;
  addr2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
}

/** Your account's saved ship-to addresses. Useful for installer drop-ship later. */
export async function getShipToAddresses(): Promise<CTShipToAddress[]> {
  const c = creds();
  const data = await ctPost<CTShipToAddress[]>('shipToSearch', {
    customerId:    c.customerId,
    customerToken: c.customerToken,
  });
  return data || [];
}

// ─── Location selection ──────────────────────────────────────────────────────
// `location` is the ONLY field the guide marks mandatory on Submit Order, and
// the old code never sent it at all. Preference order is configurable so you
// can bias toward warehouses that serve Ontario/Quebec fastest.

const DEFAULT_LOCATION_PREFERENCE = ['Valleyfield', 'Sherbrooke', 'Levis', 'Mississauga', 'Dartmouth', 'Moncton', 'Mount Pearl'];

function locationPreference(): string[] {
  const raw = process.env.CT_LOCATION_PREFERENCE;
  if (!raw) return DEFAULT_LOCATION_PREFERENCE;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export class CTInsufficientStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CTInsufficientStockError';
  }
}

/**
 * Pick a single CT warehouse that can fill EVERY line of the order.
 * CT's Submit Order takes one location for the whole order, so a split order
 * is not expressible — if no single location has all lines in stock we throw
 * rather than submit something CT will partially fail or backorder silently.
 */
export async function resolveLocation(
  items: { partNumber: string; quantity: number }[],
): Promise<string> {
  const forced = process.env.CT_FORCE_LOCATION;
  if (forced) return forced;

  const products = await searchProducts({ partNumber: items.map(i => i.partNumber) });
  const byPart = new Map(products.map(p => [p.partNumber, p]));

  const missing = items.filter(i => !byPart.has(i.partNumber));
  if (missing.length) {
    throw new CTInsufficientStockError(
      `CT catalog has no such part number(s): ${missing.map(m => m.partNumber).join(', ')}`
    );
  }

  const candidates = new Set<string>();
  for (const p of byPart.values()) for (const inv of p.inventory || []) candidates.add(inv.location);

  const canFill = (loc: string) =>
    items.every(i => {
      const inv = byPart.get(i.partNumber)!.inventory?.find(x => x.location === loc);
      return !!inv && inv.quantity >= i.quantity;
    });

  for (const preferred of locationPreference()) {
    if (candidates.has(preferred) && canFill(preferred)) return preferred;
  }
  for (const loc of candidates) if (canFill(loc)) return loc;

  const detail = items.map(i => {
    const inv = byPart.get(i.partNumber)!.inventory || [];
    const best = inv.map(x => `${x.location}:${x.quantity}`).join(', ') || 'no stock anywhere';
    return `${i.partNumber} (need ${i.quantity}) → ${best}`;
  }).join(' | ');

  throw new CTInsufficientStockError(
    `No single CT location can fill this order in full. ${detail}`
  );
}

// ─── Submit Order ────────────────────────────────────────────────────────────

export interface CTOrderShipping {
  addrId?: number;
  addr1?: string;
  addr2?: string;
  attention?: string;
  addressee?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
}

export interface CTSubmitOrderInput {
  /** Our order reference. Becomes CT's poNumber. Must be stable per source order. */
  poNumber: string;
  /** CT warehouse. Omit to auto-resolve via resolveLocation(). */
  location?: string;
  email?: string;
  phone?: string;
  shipping: CTOrderShipping;
  items: { partNumber: string; quantity: number }[];
}

export interface CTSubmitOrderResult {
  /** CT internal id — required by updateOrderAddress(). Persist this. */
  id: string;
  /** Human-facing sales order number, e.g. "SO123456". */
  orderNumber: string;
  orderTotal: string;
  salesTax: string;
  tireTax: string;
  shippingCost: string;
  items: { partNumber: string; quantity: number | string; itemTotal: string }[];
  /** True when CT_DRY_RUN was on — NOTHING was sent to CT. */
  dryRun: boolean;
  /** Exact payload built. Log this in dry-run to diff against a manual PO. */
  requestPayload: unknown;
  locationUsed: string;
}

/**
 * Validate shipping per the guide: either addrId, OR the full set
 * (addr1 + province + postalCode + country). This is the check that catches
 * the known order-router bug where the ship-to-installer branch sent empty
 * address fields — better a loud throw here than a real order shipped nowhere.
 */
function validateShipping(s: CTOrderShipping): CTOrderShipping {
  if (s.addrId) {
    // Guide: when both are supplied, addrId wins. Send it alone to avoid ambiguity.
    return { addrId: s.addrId };
  }
  const province   = normalizeProvince(s.province || '');
  const country    = normalizeCountry(s.country || '');
  const missing: string[] = [];
  if (!s.addr1?.trim())      missing.push('addr1');
  if (!province)             missing.push('province');
  if (!s.postalCode?.trim()) missing.push('postalCode');
  if (!country)              missing.push('country');
  if (missing.length) {
    throw new CTValidationError(
      `Shipping address incomplete — CT requires either addrId, or all of ` +
      `addr1 + province + postalCode + country. Missing: ${missing.join(', ')}.`
    );
  }
  return {
    addr1:      s.addr1!.trim(),
    addr2:      s.addr2?.trim() || '',
    attention:  s.attention?.trim() || '',
    addressee:  s.addressee?.trim() || '',
    city:       s.city?.trim() || '',
    province,
    postalCode: s.postalCode!.trim().toUpperCase(),
    country,
  };
}

/**
 * Create a sales order at Canada Tire.
 *
 * NOT AUTO-RETRIED, DELIBERATELY. A timeout or 5xx after CT has already
 * committed the order would, on retry, create a duplicate real order against
 * your credit line. On CTServerError the caller must reconcile (check whether
 * the order exists) before ever resubmitting — that's what the ct_orders
 * ledger is for.
 */
export async function submitOrder(input: CTSubmitOrderInput): Promise<CTSubmitOrderResult> {
  assertConfigured();

  if (!input.poNumber?.trim()) {
    throw new CTValidationError('poNumber is required — it is our idempotency handle against CT.');
  }
  if (!input.items?.length) {
    throw new CTValidationError('At least one item is required.');
  }
  for (const it of input.items) {
    if (!it.partNumber?.trim()) throw new CTValidationError('Every item needs a CT partNumber.');
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      throw new CTValidationError(`Invalid quantity for ${it.partNumber}: ${it.quantity}`);
    }
  }

  const shipping = validateShipping(input.shipping);
  const location = input.location || (await resolveLocation(input.items));

  const c = creds();
  const payload = {
    customerId:    c.customerId,
    customerToken: c.customerToken,
    orderDetails: {
      poNumber: input.poNumber,
      location,
      email:    input.email || process.env.CT_ORDER_EMAIL || '',
      phone:    input.phone || process.env.CT_ORDER_PHONE || '',
      shipping,
      items:    input.items.map(i => ({ partNumber: i.partNumber, quantity: i.quantity })),
    },
  };

  // Redacted copy for logging — never log the customer token.
  const loggable = { ...payload, customerToken: '***REDACTED***' };

  if (CT_DRY_RUN) {
    console.log('🧪 CT_DRY_RUN=true — order NOT submitted. Payload that would be sent:');
    console.log(JSON.stringify(loggable, null, 2));
    return {
      id: '', orderNumber: 'DRY-RUN', orderTotal: '0.00', salesTax: '0.00',
      tireTax: '0.00', shippingCost: '0.00',
      items: input.items.map(i => ({ partNumber: i.partNumber, quantity: i.quantity, itemTotal: '0.00' })),
      dryRun: true, requestPayload: loggable, locationUsed: location,
    };
  }

  if (CT_ENVIRONMENT === 'production') {
    console.log(`⚠️  Submitting REAL order to Canada Tire PRODUCTION — poNumber=${input.poNumber}, location=${location}`);
  }

  const data = await ctPost<Omit<CTSubmitOrderResult, 'dryRun' | 'requestPayload' | 'locationUsed'>>(
    'createOrder',
    payload,
  );

  if (!data?.id) {
    throw new CTServerError(
      `CT reported success but returned no order id — treat as INDETERMINATE and reconcile before resubmitting. Raw: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return { ...data, dryRun: false, requestPayload: loggable, locationUsed: location };
}

// ─── Update Order Address ────────────────────────────────────────────────────

export async function updateOrderAddress(
  soId: number | string,
  shipping: CTOrderShipping,
): Promise<{ soId: number | string }> {
  const c = creds();
  const validated = validateShipping(shipping);
  const data = await ctPost<{ soId?: number | string; SoId?: number | string }>('updateOrderAddr', {
    customerId:    c.customerId,
    customerToken: c.customerToken,
    orderDetails: { soId: Number(soId), shipping: validated },
  });
  // Guide shows the field as "SoId" in the schema and "soId" in the example.
  return { soId: data?.soId ?? data?.SoId ?? soId };
}

// ─── Connectivity check ──────────────────────────────────────────────────────

/** Read-only. Confirms credentials + signing work end-to-end. Creates nothing. */
export async function healthCheck(): Promise<{ ok: boolean; environment: CTEnvironment; account: string; detail: string }> {
  try {
    const addrs = await getShipToAddresses();
    return {
      ok: true, environment: CT_ENVIRONMENT, account: ACCOUNT_ID,
      detail: `Auth OK. ${addrs.length} ship-to address(es) on file. Host: ${HOST}`,
    };
  } catch (err: any) {
    return { ok: false, environment: CT_ENVIRONMENT, account: ACCOUNT_ID, detail: `${err.name}: ${err.message}` };
  }
}

// ─── BACKWARD-COMPATIBLE SHIM ────────────────────────────────────────────────
// order-router.ts already imports submitPurchaseOrder / CTNotConfiguredError /
// CT_AUTO_PO_ENABLED. Those three keep their exact names and call signatures so
// the existing (dormant) branch still compiles and behaves identically. The old
// input shape is translated to the real V1.4 contract here.
//
// New code should call submitOrder() directly.

export interface CTPurchaseOrderInput {
  gciOrderNumber: string;
  lines: { partNumber: string; quantity: number }[];
  shipTo: {
    name?: string;
    address1: string;
    address2?: string;
    city: string;
    province: string;
    postalCode: string;
    country: string;
    /**
     * order-router.ts sends phone inside shipTo (the pre-V1.4 shape). CT's
     * V1.4 contract has phone at the order level, not on the address — the
     * mapping happens in submitPurchaseOrder() below. Kept optional here so
     * order-router.ts compiles unmodified.
     */
    phone?: string;
    note?: string;
  };
  email?: string;
  phone?: string;
  location?: string;
}

export interface CTPurchaseOrderResult {
  /** Preserved for existing callers. Now carries CT's real orderNumber. */
  ctPurchaseOrderId: string;
  /** CT internal id — persist this; updateOrderAddress() needs it. */
  ctInternalId: string;
  raw: unknown;
}

/** @deprecated Use submitOrder(). Retained so order-router.ts is unchanged. */
export async function submitPurchaseOrder(po: CTPurchaseOrderInput): Promise<CTPurchaseOrderResult> {
  const result = await submitOrder({
    poNumber: po.gciOrderNumber,
    location: po.location,
    email:    po.email,
    // Old shape carried phone on the address; V1.4 carries it on the order.
    // Prefer an explicit order-level phone, fall back to the shipTo one.
    phone:    po.phone || po.shipTo.phone,
    items:    po.lines,
    shipping: {
      addr1:     po.shipTo.address1,
      addr2:     po.shipTo.address2,
      addressee: po.shipTo.name,
      // The old shape had a free-text `note`; CT's API has no notes field at
      // all, so it is mapped to `attention` rather than silently dropped.
      attention:  po.shipTo.note,
      city:       po.shipTo.city,
      province:   po.shipTo.province,
      postalCode: po.shipTo.postalCode,
      country:    po.shipTo.country,
    },
  });

  return {
    ctPurchaseOrderId: result.orderNumber,
    ctInternalId:      result.id,
    raw:               result,
  };
}

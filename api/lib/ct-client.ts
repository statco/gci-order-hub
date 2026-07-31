// api/lib/ct-client.ts
//
// Canada Tire Customer API client — implements the contract from
// "Canada Tire Customer API Guide V1.4" (released 11/04/2025).
//
// ─── VERIFICATION STATUS ─────────────────────────────────────────────────────
// 2026-07-27, verified live against PRODUCTION (realm 8031691) via ct-verify.mjs:
//   ✅ OAuth 1.0a HMAC-SHA256 signing in buildAuthHeader() — WORKS
//   ✅ customerId 19997 accepted. Dealer number 7329 is NOT a separate API
//      customer; it appears as ship-to addrId 378931 under customer 19997.
//      CT's "credentials for customer 7329" email used the dealer-facing name.
//   ✅ Product Search returns real cost (200E1059 → $97.50, matching the
//      manual PO of 2026-07-26) and per-location inventory.
//   ⛔ Submit Order — NEVER exercised. Still unverified against a live endpoint.
//      Do not enable without sandbox credentials or a deliberate low-value test.
//
// ─── SAFETY MODEL ────────────────────────────────────────────────────────────
// Three independent gates must ALL pass before a real order is placed:
//   1. CT_AUTO_PO_ENABLED = 'true'       (default off)
//   2. CT_DRY_RUN         = 'false'      (default TRUE — never submits)
//   3. CT_ENVIRONMENT     = 'production' (default 'sandbox')
// Deploying with no env changes is behaviorally identical to today.
//
// ─── HTTP 200 DOES NOT MEAN SUCCESS ──────────────────────────────────────────
// Per the guide, 200 only confirms OAuth succeeded. Every response carries
// { success, error{code,errorMsg} } and MUST be checked on that. error.code 401
// inside a 200 means customerId/customerToken mismatch. assertCtOk() enforces
// this on every call.
//
// ─── DO NOT TOUCH gci-brain/api/shopifySync.ts ───────────────────────────────
// That is the live production catalog integration. This client is standalone.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

// ─── Environment / configuration ─────────────────────────────────────────────

export type CTEnvironment = 'sandbox' | 'production';

export const CT_ENVIRONMENT: CTEnvironment =
  (process.env.CT_ENVIRONMENT || '').toLowerCase() === 'production' ? 'production' : 'sandbox';

export const CT_AUTO_PO_ENABLED = process.env.CT_AUTO_PO_ENABLED === 'true';

/** Defaults TRUE. Must be explicitly 'false' to transmit anything. */
export const CT_DRY_RUN = process.env.CT_DRY_RUN !== 'false';

const ACCOUNT_ID =
  CT_ENVIRONMENT === 'production'
    ? process.env.CT_ACCOUNT_ID_PROD || '8031691'
    : process.env.CT_ACCOUNT_ID_SANDBOX || '8031691_SB1';

const REALM = ACCOUNT_ID;
const HOST = `${ACCOUNT_ID.toLowerCase().replace(/_/g, '-')}.restlets.api.netsuite.com`;
const RESTLET_URL = `https://${HOST}/app/site/hosting/restlet.nl`;

/**
 * 19997 is VERIFIED correct (2026-07-27). Kept as the default rather than made
 * mandatory — I had planned to require an explicit value while it was unclear
 * whether 7329 was a separate account, but that ambiguity is now resolved, so a
 * hard requirement would be friction without a corresponding risk. A warning
 * fires once if it was never set explicitly.
 */
let warnedCustomerId = false;
function resolveCustomerId(sandbox: boolean): string {
  const explicit = (sandbox && process.env.CT_SANDBOX_CUSTOMER_ID) || process.env.CT_CUSTOMER_ID;
  if (explicit) return explicit;
  const legacy = process.env.CT_CUSTOMER_NUMBER;
  if (legacy) return legacy;
  if (!warnedCustomerId) {
    warnedCustomerId = true;
    console.warn('⚠️  CT_CUSTOMER_ID not set — defaulting to 19997 (verified 2026-07-27). Set it explicitly.');
  }
  return '19997';
}

function creds() {
  const sb = CT_ENVIRONMENT === 'sandbox';
  return {
    consumerKey:    (sb && process.env.CT_SANDBOX_CONSUMER_KEY)    || process.env.CT_CONSUMER_KEY    || '',
    consumerSecret: (sb && process.env.CT_SANDBOX_CONSUMER_SECRET) || process.env.CT_CONSUMER_SECRET || '',
    tokenId:        (sb && process.env.CT_SANDBOX_TOKEN_ID)        || process.env.CT_TOKEN_ID        || '',
    tokenSecret:    (sb && process.env.CT_SANDBOX_TOKEN_SECRET)    || process.env.CT_TOKEN_SECRET    || '',
    customerId:     resolveCustomerId(sb),
    customerToken:  (sb && process.env.CT_SANDBOX_CUSTOMER_TOKEN)  || process.env.CT_CUSTOMER_API_TOKEN || '',
  };
}

const SCRIPTS = {
  productSearch:   { script: process.env.CT_SCRIPT          || 'customscript_item_search_rl',        deploy: process.env.CT_DEPLOY          || 'customdeploy_item_search_rl' },
  wheelSearch:     { script: process.env.CT_WHEEL_SCRIPT    || 'customscript_cda_wheel_search_rl',   deploy: process.env.CT_WHEEL_DEPLOY    || 'customdeploycda_wheel_search_rl' },
  shipToSearch:    { script: process.env.CT_ADDR_SCRIPT     || 'customscript_get_cust_addr_rl',      deploy: process.env.CT_ADDR_DEPLOY     || 'customdeploy_get_cust_addr_rl' },
  createOrder:     { script: process.env.CT_PO_SCRIPT       || 'customscript_create_sales_order_rl', deploy: process.env.CT_PO_DEPLOY       || 'customdeploy_create_sales_order_rl' },
  updateOrderAddr: { script: process.env.CT_UPD_ADDR_SCRIPT || 'customscript_update_order_addr_rl',  deploy: process.env.CT_UPD_ADDR_DEPLOY || 'customdeploy_update_order_addr_rl' },
} as const;

const TIMEOUT_MS = Number(process.env.CT_TIMEOUT_MS || 30_000);

// ─── Errors ──────────────────────────────────────────────────────────────────

export class CTNotConfiguredError extends Error {
  constructor(m: string) { super(m); this.name = 'CTNotConfiguredError'; }
}
export class CTAuthError extends Error {
  constructor(m: string) { super(m); this.name = 'CTAuthError'; }
}
/** CT rejected the payload (body code 400). Never retry — it will fail identically. */
export class CTValidationError extends Error {
  constructor(m: string) { super(m); this.name = 'CTValidationError'; }
}
export class CTServerError extends Error {
  constructor(m: string) { super(m); this.name = 'CTServerError'; }
}
/**
 * No single CT warehouse can fill the whole order.
 * EXPECTED AND ROUTINE, not exceptional — live data shows thin stock
 * (e.g. 200E1059: Toronto 1, Montreal 7, Mount Pearl 11, everywhere else 0).
 * Callers must fall back to the manual-notify flow, never hard-fail the webhook.
 */
export class CTInsufficientStockError extends Error {
  readonly detail: string;
  constructor(m: string, detail = '') { super(m); this.name = 'CTInsufficientStockError'; this.detail = detail; }
}

// ─── OAuth 1.0a (TBA) — VERIFIED WORKING 2026-07-27 ──────────────────────────
// Guide: HMAC-SHA256; signature base includes `script` and `deploy` alongside
// the oauth_* params, sorted alphabetically. Sorting the merged map gives that
// for free ('deploy' < 'oauth_*' < 'script').

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

function assertCtOk<T>(endpoint: string, httpStatus: number, body: CTEnvelope<T>): T {
  if (body?.success === true) return body.data;
  const code = body?.error?.code;
  const msg  = body?.error?.errorMsg || '(no errorMsg returned)';
  const detail = `CT ${endpoint} failed (http ${httpStatus}, ct code ${code ?? 'none'}): ${msg}`;
  if (String(code) === '401') {
    throw new CTAuthError(
      `${detail} — per CT's guide this means customerId and customerToken do not match. ` +
      `Sending customerId='${creds().customerId}' against env='${CT_ENVIRONMENT}'.`
    );
  }
  if (String(code) === '400') throw new CTValidationError(detail);
  throw new CTServerError(detail);
}

async function ctPost<T>(endpoint: keyof typeof SCRIPTS, payload: Record<string, unknown>): Promise<T> {
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

  if (res.status === 401) {
    throw new CTAuthError(
      `CT ${endpoint}: OAuth rejected (HTTP 401) against realm='${REALM}'. ` +
      `Check TBA credentials belong to env='${CT_ENVIRONMENT}'. Body: ${text.slice(0, 300)}`
    );
  }

  let body: CTEnvelope<T>;
  try { body = JSON.parse(text); }
  catch { throw new CTServerError(`CT ${endpoint}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`); }

  return assertCtOk<T>(endpoint, res.status, body);
}

// ─── Normalization ───────────────────────────────────────────────────────────

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

// ─── SKU classification ──────────────────────────────────────────────────────
// Live data shows CT part numbers follow NO pattern: 200E1059, MW015247,
// 10199NXK, X46556. No regex can classify them — CT's catalog is the only
// source of truth. Shopify/Walmart SKUs are MIXED: some carry a legacy TIRE-
// prefix (TIRE-166028008), some are bare CT part numbers (200E1059).

const TIRE_PREFIX = /^TIRE-/i;

/** Non-CT SKUs, excluded before we ever call the catalog. */
const NON_CT_SKU_PATTERNS: RegExp[] = [
  /^INSTALL-FEE-/i,   // INSTALL-FEE-20 / -25 / -30 / -35
  /^INSTALLATION/i,
  /^WARRANTY-/i,
];

/** Strip the optional legacy TIRE- prefix. Both forms collapse to the CT part number. */
export function normalizePartNumber(sku: string): string {
  return (sku || '').trim().replace(TIRE_PREFIX, '').trim();
}

/** True if this SKU should be checked against CT's catalog at all. */
export function isCandidateForCT(sku: string): boolean {
  const s = (sku || '').trim();
  if (!s) return false;
  return !NON_CT_SKU_PATTERNS.some(re => re.test(s));
}

export interface CTClassification {
  ctItems:      { sku: string; partNumber: string; quantity: number; product: CTProduct }[];
  excluded:     { sku: string; quantity: number; reason: string }[];
  unknownItems: { sku: string; partNumber: string; quantity: number; reason: string }[];
}

/**
 * Classify order line items against CT's live catalog. ONE search call handles
 * classification, real cost, and (via resolveLocation) warehouse selection.
 * Anything CT doesn't return is `unknown` — surfaced, never silently dropped.
 */
export async function classifyLineItems(
  lineItems: { sku: string; quantity: number }[],
): Promise<CTClassification> {
  const excluded: CTClassification['excluded'] = [];
  const candidates: { sku: string; partNumber: string; quantity: number }[] = [];

  for (const li of lineItems) {
    const sku = (li.sku || '').trim();
    if (!sku) { excluded.push({ sku: '(blank)', quantity: li.quantity, reason: 'no SKU on line item' }); continue; }
    if (!isCandidateForCT(sku)) { excluded.push({ sku, quantity: li.quantity, reason: 'non-CT SKU (installation fee / warranty)' }); continue; }
    candidates.push({ sku, partNumber: normalizePartNumber(sku), quantity: li.quantity });
  }

  if (!candidates.length) return { ctItems: [], excluded, unknownItems: [] };

  const products = await searchProducts({ partNumber: candidates.map(c => c.partNumber) });
  const byPart = new Map(products.map(p => [p.partNumber.toUpperCase(), p]));

  const ctItems: CTClassification['ctItems'] = [];
  const unknownItems: CTClassification['unknownItems'] = [];

  for (const c of candidates) {
    const product = byPart.get(c.partNumber.toUpperCase());
    if (product) ctItems.push({ ...c, product });
    else unknownItems.push({ ...c, reason: 'not found in CT catalog' });
  }

  return { ctItems, excluded, unknownItems };
}

// ─── Product search ──────────────────────────────────────────────────────────

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
  width?: number; rimSize?: number; aspectRatio?: number; size?: string;
  partNumber?: string[]; brand?: string; searchKey?: string;
  isWinter?: boolean; isRunFlat?: boolean; isTire?: boolean; isWheel?: boolean;
  page?: number;
}

export async function searchProducts(filters: CTProductFilters): Promise<CTProduct[]> {
  const c = creds();
  const data = await ctPost<CTProduct[]>('productSearch', {
    customerId: c.customerId, customerToken: c.customerToken, filters,
  });
  return data || [];
}

export async function findPart(partNumber: string): Promise<CTProduct | null> {
  const results = await searchProducts({ partNumber: [partNumber] });
  return results.find(p => p.partNumber === partNumber) || results[0] || null;
}

// ─── Ship-to address book ────────────────────────────────────────────────────

export interface CTShipToAddress {
  addrId: number; attention?: string; addressee?: string;
  addr1: string; addr2?: string; city?: string;
  province?: string; postalCode?: string; country?: string;
}

export async function getShipToAddresses(): Promise<CTShipToAddress[]> {
  const c = creds();
  const data = await ctPost<CTShipToAddress[]>('shipToSearch', {
    customerId: c.customerId, customerToken: c.customerToken,
  });
  return data || [];
}

// ─── Location selection ──────────────────────────────────────────────────────
//
// CORRECTED 2026-07-27. v1 used warehouse names taken from the API guide's
// examples ('Valleyfield', 'Mississauga', bare 'Sherbrooke'). NONE of those
// match what the live API returns, and the guide states location values are
// CASE SENSITIVE. Every preference entry silently failed to match, making
// warehouse choice effectively random. These are the verified live values:

export const CT_LOCATIONS = [
  'Toronto, ON',
  'Montreal, QC',
  'Sherbrooke, QC',
  'Levis, QC',
  'Dartmouth, NS',
  'Moncton, NB',
  'Mount Pearl, NFLD',
] as const;

/**
 * Destination province → warehouse preference, nearest-first. Chosen to
 * minimise transit time, which drives Walmart's delivery SLA.
 */
const PROVINCE_ROUTING: Record<string, string[]> = {
  QC: ['Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Toronto, ON', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  ON: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  NB: ['Moncton, NB', 'Dartmouth, NS', 'Levis, QC', 'Montreal, QC', 'Sherbrooke, QC', 'Toronto, ON', 'Mount Pearl, NFLD'],
  NS: ['Dartmouth, NS', 'Moncton, NB', 'Levis, QC', 'Montreal, QC', 'Sherbrooke, QC', 'Toronto, ON', 'Mount Pearl, NFLD'],
  PE: ['Dartmouth, NS', 'Moncton, NB', 'Levis, QC', 'Montreal, QC', 'Sherbrooke, QC', 'Toronto, ON', 'Mount Pearl, NFLD'],
  NL: ['Mount Pearl, NFLD', 'Dartmouth, NS', 'Moncton, NB', 'Montreal, QC', 'Levis, QC', 'Sherbrooke, QC', 'Toronto, ON'],
  // Everything west of Ontario ships from Toronto first — it is the westernmost
  // CT warehouse, so it is nearest for BC/AB/SK/MB and the territories.
  MB: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  SK: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  AB: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  BC: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  YT: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  NT: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
  NU: ['Toronto, ON', 'Montreal, QC', 'Sherbrooke, QC', 'Levis, QC', 'Moncton, NB', 'Dartmouth, NS', 'Mount Pearl, NFLD'],
};

const FALLBACK_ROUTING = [...CT_LOCATIONS];

export function preferenceForProvince(province?: string): string[] {
  const override = process.env.CT_LOCATION_PREFERENCE;
  if (override) return override.split(',').map(s => s.trim()).filter(Boolean);
  const p = normalizeProvince(province || '');
  return PROVINCE_ROUTING[p] || FALLBACK_ROUTING;
}

/**
 * Pick ONE warehouse that can fill EVERY line. CT's Submit Order accepts a
 * single location per order, so a split shipment is not expressible — if no
 * one location can fill it, throw CTInsufficientStockError so the caller can
 * fall back to manual handling rather than let CT silently backorder.
 */
export async function resolveLocation(
  items: { partNumber: string; quantity: number }[],
  destinationProvince?: string,
  prefetched?: Map<string, CTProduct>,
): Promise<string> {
  const forced = process.env.CT_FORCE_LOCATION;
  if (forced) return forced;

  let byPart = prefetched;
  if (!byPart) {
    const products = await searchProducts({ partNumber: items.map(i => i.partNumber) });
    byPart = new Map(products.map(p => [p.partNumber.toUpperCase(), p]));
  }

  const missing = items.filter(i => !byPart!.has(i.partNumber.toUpperCase()));
  if (missing.length) {
    throw new CTInsufficientStockError(
      `CT catalog has no such part number(s): ${missing.map(m => m.partNumber).join(', ')}`
    );
  }

  const canFill = (loc: string) =>
    items.every(i => {
      const inv = byPart!.get(i.partNumber.toUpperCase())!.inventory?.find(x => x.location === loc);
      return !!inv && inv.quantity >= i.quantity;
    });

  for (const preferred of preferenceForProvince(destinationProvince)) {
    if (canFill(preferred)) return preferred;
  }

  const seen = new Set<string>();
  for (const p of byPart.values()) for (const inv of p.inventory || []) seen.add(inv.location);
  for (const loc of seen) if (canFill(loc)) return loc;

  const detail = items.map(i => {
    const inv = byPart!.get(i.partNumber.toUpperCase())!.inventory || [];
    const stocked = inv.filter(x => x.quantity > 0).map(x => `${x.location}:${x.quantity}`).join(', ') || 'no stock anywhere';
    return `${i.partNumber} (need ${i.quantity}) → ${stocked}`;
  }).join(' | ');

  throw new CTInsufficientStockError(
    `No single CT location can fill this order in full — route to manual handling.`,
    detail,
  );
}

// ─── Submit Order ────────────────────────────────────────────────────────────

export interface CTOrderShipping {
  addrId?: number; addr1?: string; addr2?: string;
  attention?: string; addressee?: string; city?: string;
  province?: string; postalCode?: string; country?: string;
}

export interface CTSubmitOrderInput {
  poNumber: string;
  location?: string;
  email?: string;
  phone?: string;
  shipping: CTOrderShipping;
  items: { partNumber: string; quantity: number }[];
}

export interface CTSubmitOrderResult {
  id: string;
  orderNumber: string;
  orderTotal: string;
  salesTax: string;
  tireTax: string;
  shippingCost: string;
  items: { partNumber: string; quantity: number | string; itemTotal: string }[];
  dryRun: boolean;
  requestPayload: unknown;
  locationUsed: string;
}

function validateShipping(s: CTOrderShipping): CTOrderShipping {
  if (s.addrId) return { addrId: s.addrId };
  const province = normalizeProvince(s.province || '');
  const country  = normalizeCountry(s.country || '');
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
    province, postalCode: s.postalCode!.trim().toUpperCase(), country,
  };
}

/**
 * Create a sales order at Canada Tire.
 *
 * NOT AUTO-RETRIED, DELIBERATELY. A timeout or 5xx after CT has committed the
 * order would, on retry, create a duplicate real order against your credit
 * line. On CTServerError the caller must reconcile before resubmitting — that
 * is what the ct_orders ledger exists for.
 */
export async function submitOrder(input: CTSubmitOrderInput): Promise<CTSubmitOrderResult> {
  assertConfigured();

  if (!input.poNumber?.trim()) throw new CTValidationError('poNumber is required — it is our idempotency handle.');
  if (!input.items?.length)    throw new CTValidationError('At least one item is required.');
  for (const it of input.items) {
    if (!it.partNumber?.trim()) throw new CTValidationError('Every item needs a CT partNumber.');
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      throw new CTValidationError(`Invalid quantity for ${it.partNumber}: ${it.quantity}`);
    }
  }

  const shipping = validateShipping(input.shipping);
  const location = input.location || (await resolveLocation(input.items, shipping.province));

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

  const data = await ctPost<Omit<CTSubmitOrderResult, 'dryRun' | 'requestPayload' | 'locationUsed'>>('createOrder', payload);

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
    customerId: c.customerId, customerToken: c.customerToken,
    orderDetails: { soId: Number(soId), shipping: validated },
  });
  // Guide shows "SoId" in the schema and "soId" in the example — accept both.
  return { soId: data?.soId ?? data?.SoId ?? soId };
}

// ─── Health check ────────────────────────────────────────────────────────────

export async function healthCheck(): Promise<{ ok: boolean; environment: CTEnvironment; account: string; detail: string }> {
  try {
    const addrs = await getShipToAddresses();
    return { ok: true, environment: CT_ENVIRONMENT, account: ACCOUNT_ID,
      detail: `Auth OK. ${addrs.length} ship-to address(es) on file. Host: ${HOST}` };
  } catch (err: any) {
    return { ok: false, environment: CT_ENVIRONMENT, account: ACCOUNT_ID, detail: `${err.name}: ${err.message}` };
  }
}

// ─── BACKWARD-COMPATIBLE SHIM ────────────────────────────────────────────────
// order-router.ts now goes through ct-order-routing.ts's routeOrderToCT()
// (classify → claim → submit via the ct_orders ledger) instead of calling
// this directly — that path bypassed claimOrder()/buildPoNumber() entirely.
// Nothing in this repo calls submitPurchaseOrder() anymore. Retained,
// unmodified, in case anything external still depends on it; safe to delete
// once that's confirmed. New code should call submitOrder() directly.

export interface CTPurchaseOrderInput {
  gciOrderNumber: string;
  lines: { partNumber: string; quantity: number }[];
  shipTo: {
    name?: string; address1: string; address2?: string; city: string;
    province: string; postalCode: string; country: string;
    note?: string;
    /** Retained: order-router.ts:250 passes phone inside shipTo. */
    phone?: string;
  };
  email?: string;
  phone?: string;
  location?: string;
}

export interface CTPurchaseOrderResult {
  ctPurchaseOrderId: string;
  ctInternalId: string;
  raw: unknown;
}

/** @deprecated Use submitOrder(). Retained so order-router.ts stays unmodified. */
export async function submitPurchaseOrder(po: CTPurchaseOrderInput): Promise<CTPurchaseOrderResult> {
  const result = await submitOrder({
    poNumber: po.gciOrderNumber,
    location: po.location,
    email:    po.email,
    phone:    po.phone || po.shipTo.phone,
    items:    po.lines,
    shipping: {
      addr1:      po.shipTo.address1,
      addr2:      po.shipTo.address2,
      addressee:  po.shipTo.name,
      // CT's API has no notes field; map rather than silently drop.
      attention:  po.shipTo.note,
      city:       po.shipTo.city,
      province:   po.shipTo.province,
      postalCode: po.shipTo.postalCode,
      country:    po.shipTo.country,
    },
  });
  return { ctPurchaseOrderId: result.orderNumber, ctInternalId: result.id, raw: result };
}

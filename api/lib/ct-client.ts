// api/lib/ct-client.ts
//
// Canada Tire (NetSuite RESTlet) client. OAuth 1.0a signing ported EXACTLY
// from gci-brain/api/shopifySync.ts's buildAuthHeader() -- that's the
// confirmed-working implementation already used in production for CT
// catalog/price reads. Do not modify the signing logic independently of
// that file; if CT's auth ever changes, port the change from there first.
//
// -- The switch --------------------------------------------------------
// CT's existing RESTlet (customscript_item_search_rl) is READ-ONLY --
// catalog/price search only. There is currently NO order-creation endpoint
// on CT's side. submitPurchaseOrder() below is a real, ready-to-use client
// function, but it targets a RESTlet that doesn't exist yet (CT_PO_SCRIPT /
// CT_PO_DEPLOY are unset).
//
// CT_AUTO_PO_ENABLED gates whether order-router.ts even attempts to call
// submitPurchaseOrder() at all. Default OFF. Turning it on before CT
// provides real script/deploy IDs and a credit line will just make every
// TIRE- order fail this call (caught, logged, falls back to the existing
// manual-PO notification flow -- see order-router.ts) -- it will not break
// anything, but there's no reason to enable it until CT is ready.
//
// To activate once CT delivers their side:
//   1. Set CT_AUTO_PO_ENABLED=true
//   2. Set CT_PO_SCRIPT / CT_PO_DEPLOY to whatever CT's rep provides
//   3. Confirm the payload shape in submitPurchaseOrder() below against
//      CT's actual RESTlet contract -- the field names here are a
//      reasonable guess (mirrors typical NetSuite PO fields) but CANNOT be
//      verified until CT's endpoint actually exists. Treat this as a
//      starting point to adjust, not a finished integration.

import crypto from 'crypto';

const CT_USE_SANDBOX = process.env.CT_USE_SANDBOX !== 'false';

const CT = {
  consumerKey:    process.env.CT_CONSUMER_KEY       || '',
  consumerSecret: process.env.CT_CONSUMER_SECRET    || '',
  tokenId:        process.env.CT_TOKEN_ID           || '',
  tokenSecret:    process.env.CT_TOKEN_SECRET       || '',
  realm:          process.env.CT_REALM              || '8031691',
  get baseUrl() {
    return CT_USE_SANDBOX
      ? 'https://8031691-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl'
      : 'https://8031691.restlets.api.netsuite.com/app/site/hosting/restlet.nl';
  },
};

// Unset until CT's rep provides them -- see header comment.
const CT_PO_SCRIPT = process.env.CT_PO_SCRIPT || '';
const CT_PO_DEPLOY = process.env.CT_PO_DEPLOY || '';

export const CT_AUTO_PO_ENABLED = process.env.CT_AUTO_PO_ENABLED === 'true';

// -- OAuth 1.0a signing (ported from gci-brain/api/shopifySync.ts) -----

function pct(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

function buildAuthHeader(script: string, deploy: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nc = crypto.randomBytes(16).toString('hex');
  const sigParams: Record<string, string> = {
    deploy,
    oauth_consumer_key:     CT.consumerKey,
    oauth_nonce:            nc,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        ts,
    oauth_token:            CT.tokenId,
    oauth_version:          '1.0',
    script,
  };
  const paramStr   = Object.keys(sigParams).sort().map(k => `${pct(k)}=${pct(sigParams[k])}`).join('&');
  const base       = ['POST', pct(CT.baseUrl), pct(paramStr)].join('&');
  const signingKey = `${pct(CT.consumerSecret)}&${pct(CT.tokenSecret)}`;
  const sig        = crypto.createHmac('sha256', signingKey).update(base).digest('base64');
  return [
    `OAuth realm="${CT.realm}"`,
    `oauth_consumer_key="${CT.consumerKey}"`,
    `oauth_token="${CT.tokenId}"`,
    `oauth_signature_method="HMAC-SHA256"`,
    `oauth_timestamp="${ts}"`,
    `oauth_nonce="${nc}"`,
    `oauth_version="1.0"`,
    `oauth_signature="${pct(sig)}"`,
  ].join(', ');
}

// -- Purchase order submission (dormant until CT_PO_SCRIPT/DEPLOY are set) --

export interface CTPurchaseOrderLine {
  partNumber: string;
  quantity:   number;
}

export interface CTPurchaseOrderInput {
  gciOrderNumber: string;      // Shopify order name, e.g. "#1042" -- for CT-side reference/dedup
  lines:          CTPurchaseOrderLine[];
  shipTo: {
    name:        string;
    address1:    string;
    address2?:   string;
    city:        string;
    province:    string;
    postalCode:  string;
    country:     string;
    phone?:      string;
    note?:       string;      // e.g. "Ship to installer: <name>"
  };
}

export interface CTPurchaseOrderResult {
  ctPurchaseOrderId: string;
  raw: unknown;
}

export class CTNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CTNotConfiguredError';
  }
}

/**
 * Submit a purchase order to Canada Tire via their (future) order-creation
 * RESTlet. Throws CTNotConfiguredError if CT_PO_SCRIPT/CT_PO_DEPLOY aren't
 * set yet -- callers should catch this specifically and fall back to the
 * existing manual-PO notification flow, not treat it as a hard failure.
 */
export async function submitPurchaseOrder(po: CTPurchaseOrderInput): Promise<CTPurchaseOrderResult> {
  if (!CT_PO_SCRIPT || !CT_PO_DEPLOY) {
    throw new CTNotConfiguredError(
      'CT_PO_SCRIPT / CT_PO_DEPLOY not set -- Canada Tire has not yet provided an ' +
      'order-creation RESTlet. This is expected until CT delivers their side; ' +
      'the manual-PO flow remains the source of truth until then.'
    );
  }
  if (!CT.consumerKey || !CT.tokenId) {
    throw new CTNotConfiguredError('CT OAuth credentials not configured (CT_CONSUMER_KEY / CT_TOKEN_ID).');
  }

  const fullUrl = `${CT.baseUrl}?script=${CT_PO_SCRIPT}&deploy=${CT_PO_DEPLOY}`;

  // NOTE: field names below are a starting-point guess (typical NetSuite PO
  // shape), NOT confirmed against a real CT endpoint -- adjust once CT
  // shares their actual RESTlet contract.
  const body = {
    customerId:      process.env.CT_CUSTOMER_NUMBER || '19997',
    customerToken:   process.env.CT_CUSTOMER_API_TOKEN || '',
    externalRefId:   po.gciOrderNumber,
    lines:           po.lines.map(l => ({ partNumber: l.partNumber, quantity: l.quantity })),
    shipTo:          po.shipTo,
  };

  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      'Authorization': buildAuthHeader(CT_PO_SCRIPT, CT_PO_DEPLOY),
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`CT PO submit: non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok || data?.success === false) {
    throw new Error(`CT PO submit failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Field name guessed (ctPurchaseOrderId / poId / id) -- adjust once CT's
  // real response shape is known.
  const ctPurchaseOrderId = data.ctPurchaseOrderId || data.poId || data.id || '';
  return { ctPurchaseOrderId, raw: data };
}

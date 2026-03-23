// api/authorize-order.ts
// ─────────────────────────────────────────────────────────────
// GET /api/authorize-order?data=<base64url>&sig=<hex>
//
// Called when you click the "Authorize & Submit" link from the
// Telegram or email notification.
//
// Behaviour by supplier type:
//   TIRE   — logs PO authorization (manual Canada Tire order follows
//             your existing supplier process; extend the TODO block
//             below to auto-email your rep when ready)
//   NUPROZ — calls CJ Dropshipping confirmOrder to submit to supplier
//
// Security:
//   • Link payload is HMAC-SHA256 signed with ORDER_ROUTER_SECRET
//   • Link expires after 24h (exp field embedded in payload)
//   • Timing-safe comparison prevents timing attacks
// ─────────────────────────────────────────────────────────────

import crypto                                        from 'crypto';
import type { VercelRequest, VercelResponse }         from '@vercel/node';
import { submitOrder }                                from './lib/cj-client.js';
import type { AuthToken }                             from './order-router.js';

export const config = { maxDuration: 30 };

const ROUTER_SECRET = process.env.ORDER_ROUTER_SECRET ?? '';

// ─── TOKEN VERIFICATION ───────────────────────────────────────

function verifyToken(data: string, sig: string): AuthToken | null {
  if (!ROUTER_SECRET) {
    console.error('❌ ORDER_ROUTER_SECRET not set');
    return null;
  }
  const expected = crypto.createHmac('sha256', ROUTER_SECRET).update(data).digest('hex');
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(
      new Uint8Array(Buffer.from(expected, 'hex')),
      new Uint8Array(Buffer.from(sig,      'hex')),
    );
  } catch { return null; }

  if (!ok) return null;

  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as AuthToken;
  } catch { return null; }
}

// ─── HTML PAGE HELPER ─────────────────────────────────────────

function page(title: string, body: string, success = true): string {
  const accent = success ? '#10b981' : '#ef4444';
  const icon   = success ? '✅' : '❌';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — GCI Order Hub</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#f3f4f6;
         display:flex;align-items:center;justify-content:center;
         min-height:100vh;padding:20px}
    .card{background:#fff;border-radius:12px;padding:40px;max-width:480px;
          width:100%;box-shadow:0 4px 16px rgba(0,0,0,.1);text-align:center}
    .icon{font-size:52px;margin-bottom:16px}
    h1{font-size:22px;color:#111827;margin-bottom:12px}
    p{color:#4b5563;line-height:1.6;margin-bottom:8px}
    code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px}
    .badge{display:inline-block;background:${accent};color:#fff;
           border-radius:6px;padding:4px 14px;font-size:13px;
           font-weight:bold;margin-top:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>`;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = (req.query.data as string) ?? '';
  const sig  = (req.query.sig  as string) ?? '';

  if (!data || !sig) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(
      page('Invalid Link', '<p>This link is missing required parameters.</p>', false),
    );
  }

  const payload = verifyToken(data, sig);
  if (!payload) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(401).send(
      page('Invalid Signature',
        '<p>This authorization link is invalid or has been tampered with.</p>', false),
    );
  }

  if (Date.now() > payload.exp) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(410).send(
      page('Link Expired',
        `<p>The authorization link for order <strong>${payload.orderNumber}</strong> has expired.</p>
         <p>Links are valid for 24 hours. Replay the webhook from Shopify Admin to generate a new link.</p>`,
        false),
    );
  }

  // ── TIRE: manual Canada Tire PO ──────────────────────────────
  if (payload.supplierType === 'TIRE') {
    console.log(
      `✅ TIRE PO AUTHORIZED — ${payload.orderNumber} (Shopify id: ${payload.orderId})`,
    );
    // TODO: extend here to auto-email your Canada Tire rep or call a PO API
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(
      page('Tire Order Authorized',
        `<p>Order <strong>${payload.orderNumber}</strong> has been authorized.</p>
         <p>Proceed with placing the Canada Tire purchase order via your standard process.</p>
         <span class="badge">TIRE — Canada Tire PO</span>`),
    );
  }

  // ── NUPROZ: auto-submit to CJ Dropshipping ───────────────────
  if (payload.supplierType === 'NUPROZ') {
    if (!payload.cjOrderId) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(
        page('Missing CJ Order ID',
          '<p>This NUPROZ token is missing the CJ order reference.</p>', false),
      );
    }

    try {
      await submitOrder(payload.cjOrderId);
      console.log(
        `✅ NUPROZ AUTHORIZED & SUBMITTED — CJ order ${payload.cjOrderId}, ` +
        `Shopify order ${payload.orderNumber}`,
      );
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(
        page('Nuproz Order Submitted',
          `<p>Order <strong>${payload.orderNumber}</strong> has been authorized and submitted to CJ Dropshipping.</p>
           <p>CJ Order ID: <code>${payload.cjOrderId}</code></p>
           <span class="badge">NUPROZ — CJDropshipping</span>`),
      );
    } catch (err: any) {
      console.error(`❌ CJ submit failed for ${payload.cjOrderId}:`, err);
      res.setHeader('Content-Type', 'text/html');
      return res.status(500).send(
        page('Submission Failed',
          `<p>Authorization confirmed but CJ submission failed for order <code>${payload.cjOrderId}</code>:</p>
           <p style="color:#ef4444;font-family:monospace;font-size:13px;">${err.message}</p>
           <p>Log into CJ Dropshipping and confirm the order manually.</p>`,
          false),
      );
    }
  }

  res.setHeader('Content-Type', 'text/html');
  return res.status(400).send(
    page('Unknown Supplier Type',
      `<p>Unrecognised supplier type: <code>${payload.supplierType}</code></p>`, false),
  );
}

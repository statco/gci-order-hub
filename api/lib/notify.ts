// api/lib/notify.ts
// ─────────────────────────────────────────────────────────────
// Dual-channel order notification: Telegram bot (primary) +
// Resend email (fallback).  Both channels run concurrently;
// a failure in one does not block the other.
//
// Env vars:
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — your personal chat or group chat id
//   RESEND_API_KEY      — from resend.com
//   NOTIFY_EMAIL_TO     — destination address for alerts
//   NOTIFY_EMAIL_FROM   — sender address (default provided)
// ─────────────────────────────────────────────────────────────

import { Resend } from 'resend';

// ─── CONFIG ──────────────────────────────────────────────────

const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID   || '';
const RESEND_KEY      = process.env.RESEND_API_KEY     || '';
const EMAIL_TO        = process.env.NOTIFY_EMAIL_TO    || '';
const EMAIL_FROM      = process.env.NOTIFY_EMAIL_FROM
  || 'GCI Orders <orders@updates.gcitires.ca>';

// ─── PUBLIC TYPES ────────────────────────────────────────────

export interface NotifyItem {
  sku:      string;
  title:    string;
  quantity: number;
  unitCost: number;   // your cost in CAD
}

export interface NotifyPayload {
  shopifyOrderId:   number;
  orderNumber:      string;            // "#1234"
  supplierType:     'TIRE' | 'NUPROZ';
  items:            NotifyItem[];
  totalCost:        number;            // sum of unitCost × qty
  authorizeUrl:     string;            // HMAC-signed link
  customerName:     string;
  shippingCity:     string;
  shippingProvince: string;
  installerName?:   string;
  appointmentDate?: string;
  cjOrderId?:       string;            // set for NUPROZ orders
}

// ─── TELEGRAM ────────────────────────────────────────────────

async function sendTelegram(p: NotifyPayload): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;

  const label = p.supplierType === 'TIRE' ? '🛞 Canada Tire PO' : '📦 CJDropshipping';
  const lines  = p.items
    .map(i =>
      `  • \`${i.sku}\`  ×${i.quantity}  @ $${i.unitCost.toFixed(2)}` +
      `  = *$${(i.unitCost * i.quantity).toFixed(2)}*`,
    )
    .join('\n');

  const installerLine = p.installerName
    ? `\n🔧 *Installer:* ${p.installerName}${p.appointmentDate ? ` (${p.appointmentDate})` : ''}`
    : '';

  const cjLine = p.cjOrderId ? `\n🆔 *CJ Order ID:* \`${p.cjOrderId}\`` : '';

  const text = [
    `🚨 *GCI New Order — ${label}*`,
    '',
    `*Order:* ${p.orderNumber}`,
    `*Customer:* ${p.customerName}`,
    `*Ship to:* ${p.shippingCity}, ${p.shippingProvince}${installerLine}${cjLine}`,
    '',
    '*Items:*',
    lines,
    '',
    `*Total cost to GCI:* *$${p.totalCost.toFixed(2)} CAD*`,
    '',
    `✅ [AUTHORIZE & SUBMIT](${p.authorizeUrl})`,
    '',
    '_Link expires in 24 hours._',
  ].join('\n');

  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:                  TELEGRAM_CHAT,
        text,
        parse_mode:               'Markdown',
        disable_web_page_preview: true,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ Telegram notify failed ${res.status}:`, body.slice(0, 200));
  } else {
    console.log(`✅ Telegram notification sent — order ${p.orderNumber}`);
  }
}

// ─── EMAIL (RESEND) ───────────────────────────────────────────

async function sendEmail(p: NotifyPayload): Promise<void> {
  if (!RESEND_KEY || !EMAIL_TO) return;

  const resend       = new Resend(RESEND_KEY);
  const supplierLabel = p.supplierType === 'TIRE'
    ? 'Canada Tire Purchase Order'
    : 'CJDropshipping Pending Order';

  const itemRows = p.items.map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${i.sku}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">${i.title}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${i.quantity}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">$${i.unitCost.toFixed(2)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:bold;">$${(i.unitCost * i.quantity).toFixed(2)}</td>
    </tr>`).join('');

  const installerHtml = p.installerName ? `
    <p style="margin:8px 0;color:#374151;">
      <strong>Installer:</strong> ${p.installerName}
      ${p.appointmentDate ? `<br><strong>Appointment:</strong> ${p.appointmentDate}` : ''}
    </p>` : '';

  const cjHtml = p.cjOrderId
    ? `<p style="margin:8px 0;color:#374151;"><strong>CJ Order ID:</strong> <code>${p.cjOrderId}</code></p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f3f4f6;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="background-color:#B8192E; padding:20px 32px;">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right:14px; vertical-align:middle;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 56" width="28" height="36">
                  <polygon points="0,14 22,14 22,0 44,28 22,56 22,42 0,42" fill="#FFFFFF"/>
                </svg>
              </td>
              <td style="vertical-align:middle;">
                <div style="font-family:'Arial Black',Arial,sans-serif; font-size:20px; font-weight:900; color:#FFFFFF; letter-spacing:1px; line-height:1;">GCI TIRES</div>
                <div style="font-family:'Arial Narrow',Arial,sans-serif; font-size:11px; color:rgba(255,255,255,0.55); letter-spacing:4px; margin-top:3px;">gcitires.com</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 12px;font-size:18px;font-weight:bold;color:#111827;">Order Alert — Action Required</p>
      <p style="margin:0 0 4px;font-size:18px;font-weight:bold;color:#111827;">Order ${p.orderNumber}</p>
      <p style="margin:4px 0;color:#374151;"><strong>Supplier:</strong> ${supplierLabel}</p>
      <p style="margin:4px 0;color:#374151;"><strong>Customer:</strong> ${p.customerName}</p>
      <p style="margin:4px 0 12px;color:#374151;"><strong>Ship to:</strong> ${p.shippingCity}, ${p.shippingProvince}</p>
      ${installerHtml}${cjHtml}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:16px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">SKU</th>
            <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Product</th>
            <th style="padding:8px;text-align:center;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Qty</th>
            <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Unit Cost</th>
            <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Line Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="4" style="padding:12px 8px;text-align:right;font-weight:bold;color:#111827;border-top:2px solid #e5e7eb;">Total Cost to GCI:</td>
            <td style="padding:12px 8px;text-align:right;font-weight:bold;color:#10b981;font-size:20px;border-top:2px solid #e5e7eb;">$${p.totalCost.toFixed(2)} CAD</td>
          </tr>
        </tfoot>
      </table>
      <div style="margin-top:28px;text-align:center;">
        <a href="${p.authorizeUrl}"
           style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-weight:bold;font-size:16px;">
          ✅ Authorize &amp; Submit Order
        </a>
        <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;">This link expires in 24 hours.</p>
      </div>
    </div>
  </div>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from:    EMAIL_FROM,
    to:      [EMAIL_TO],
    subject: `[GCI] Action Required: Order ${p.orderNumber} — ${supplierLabel}`,
    html,
  });

  if (error) {
    console.error(`❌ Resend notify failed for order ${p.orderNumber}:`, error);
  } else {
    console.log(`✅ Email notification sent — order ${p.orderNumber}`);
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────

/**
 * Send order notification via all configured channels.
 * Failures in one channel do not block the other.
 */
export async function sendOrderNotification(payload: NotifyPayload): Promise<void> {
  await Promise.allSettled([
    sendTelegram(payload),
    sendEmail(payload),
  ]);
}

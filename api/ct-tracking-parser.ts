import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import { getOrderIdByPoNumber, getOrderStatus } from './lib/sheets-client.js';
import { CANONICAL_PO_NUMBER_SHAPE } from './lib/ct-order-ledger.js';
import { sendTelegramMessage } from './lib/telegram.js';

const PDFParser = require('pdf2json');

export const config = { maxDuration: 60 };

const SHEET_ID = process.env.WALMART_ORDER_LOG_SHEET_ID!;
const SHIP_ENDPOINT = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}/api/walmart-ship`
  : 'https://gci-order-hub.vercel.app/api/walmart-ship';

// ── Gmail auth ────────────────────────────────────────────────────────────

function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID!,
    process.env.GMAIL_CLIENT_SECRET!
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN! });
  return google.gmail({ version: 'v1', auth });
}

// ── PDF parser ─────────────────────────────────────────────────────────────

function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataReady', (data: any) => {
      const pages = data?.Pages ?? [];
      const extracted = pages
        .flatMap((page: any) => page.Texts ?? [])
        .map((t: any) => decodeURIComponent(t.R?.[0]?.T ?? ''))
        .join(' ');
      resolve(extracted);
    });
    parser.on('pdfParser_dataError', (err: any) => reject(err));
    parser.parseBuffer(pdfBuffer);
  });
}

interface ParsedInvoice {
  poNumber: string | null;
  trackingNumber: string | null;
  carrier: string;
  rawCarrier: string;
  // Set only when carrier resolves to OTHER and a confirmed public tracking
  // URL pattern exists for that specific carrier (currently: Midland
  // Courier only). null for a mapped Walmart carrier (walmart-ship.ts
  // derives its own URL for those) or for an OTHER carrier with no known
  // pattern — the latter is treated as an explicit parse failure by the
  // caller, not silently defaulted to a wrong tracking link.
  trackingUrl: string | null;
}

// PO # — canonical: "GCI-2026-447269" (GCI-<year>-<seq>, the only format CT
// recognises going forward — see CANONICAL_PO_NUMBER_SHAPE in
// ct-order-ledger.ts, the single source of truth this pattern is built from
// so producer and consumer can never quietly drift apart). CT renders the
// SAME PO number with different separators depending on document type —
// confirmed live 2026-07-29: "GCI-2026-447269" on an Invoice vs
// "GCI_2026_447268" on a Sales Order for the very same order. The shape
// (CANONICAL_PO_NUMBER_SHAPE) accepts either; the extracted value is then
// normalized to the canonical hyphenated form (see below) before use, since
// that's what's stored in the Sheet's PO-number column and what
// getOrderIdByPoNumber() does an exact-string lookup against — normalizing
// here means that lookup (deliberately left untouched) still succeeds
// regardless of which separator the source document happened to use.
// Legacy: "GCI0003" — no separators at all, already present in CT invoice
// history, still matched here so older invoices keep working.
//
// pdf2json (extractPdfText, below) joins text runs with a single space,
// which can leave a stray space between "PO #" and the value (e.g.
// "PO #: GCI0003"). The old regex smuggled that space into the capture
// group's own character class ([ A-Z]{2,4}) instead of consuming it as
// separator whitespace — handled deliberately here instead: whitespace (and
// a possible colon) between the label and the value is consumed by
// `[\s:]*`, and the source text is whitespace-normalized before matching so
// runs of spaces/newlines collapse to a single space.
const LEGACY_PO_NUMBER_SHAPE = '[A-Z]{2,4}\\d{3,6}';
const PO_NUMBER_PATTERN = new RegExp(
  `PO\\s*#[\\s:]*(${CANONICAL_PO_NUMBER_SHAPE}|${LEGACY_PO_NUMBER_SHAPE})`,
  'i',
);

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Midland Courier has no native Walmart carrier code (Walmart classifies it
// OTHER), but its public tracking portal has a confirmed, stable URL
// pattern — verified live 2026-07-29 against a real tracking number.
function midlandTrackingUrl(trackingNumber: string): string {
  return `https://ship.midlandtransport.com/Tracking/TrackClientTrackings?TrackingNumber=${encodeURIComponent(trackingNumber)}&Lang=0`;
}

export function parseInvoicePdf(text: string): ParsedInvoice {
  const normalized = normalizeWhitespace(text);

  const poMatch = normalized.match(PO_NUMBER_PATTERN);
  // Normalize to the canonical hyphenated form regardless of which
  // separator the source document used — see the shape comment above.
  // The legacy no-separator shape (e.g. "GCI0003") has nothing to
  // normalize and passes through unchanged.
  const poNumber = poMatch ? poMatch[1].toUpperCase().replace(/^(GCI)[-_](\d{4})[-_](\d{4,8})$/, '$1-$2-$3') : null;

  // Tracking Number — labeled field in CT invoice
  const trackingMatch = normalized.match(/Tracking\s*Number[\s:]*([A-Z0-9]{6,30})/i);
  const trackingNumber = trackingMatch ? trackingMatch[1] : null;

  // Carrier — from Mode of Delivery field
  const carrierMatch = normalized.match(/Mode\s*of\s*Delivery[\s:]*\*?([A-Z]+)/i);
  const rawCarrier = carrierMatch ? carrierMatch[1].toLowerCase() : 'purolator';

  const carrierMap: Record<string, string> = {
    gls: 'OTHER',
    purolator: 'PUROLATOR',
    ups: 'UPS',
    fedex: 'FEDEX',
    dhl: 'DHL',
    canadapost: 'CANADA_POST',
    midland: 'OTHER',
  };
  const carrier = carrierMap[rawCarrier] ?? 'OTHER';

  const trackingUrl =
    carrier === 'OTHER' && rawCarrier === 'midland' && trackingNumber
      ? midlandTrackingUrl(trackingNumber)
      : null;

  return { poNumber, trackingNumber, carrier, rawCarrier, trackingUrl };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const gmail = getGmailClient();

    // Search for unread CT invoices from last 48 hours. Was
    // subject:"Invoice CS" — an exact phrase that never matches CT's real
    // subject line ("Canada Tire Company Inc.: Invoice #INV178961"),
    // confirmed against a live invoice received 2026-07-29. subject:Invoice
    // matches any subject containing that word (Gmail search is
    // case-insensitive), which is all this filter is meant to narrow down —
    // from:/has:attachment already scope it to CT's own emailed invoices.
    const searchRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:info@cdatire.com subject:Invoice has:attachment newer_than:2d is:unread',
      maxResults: 10,
    });

    const messages = searchRes.data.messages ?? [];
    console.log(`[ct-parser] Found ${messages.length} unread CT invoice(s)`);

    if (messages.length === 0) {
      return res.status(200).json({ message: 'No new CT invoices', processed: 0 });
    }

    let processed = 0;
    let failed = 0;

    for (const msg of messages) {
      const msgId = msg.id!;

      try {
        // Get full message
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'full',
        });

        const parts = full.data.payload?.parts ?? [];

        // Find PDF attachment
        const pdfPart = parts.find(
          (p) =>
            p.mimeType === 'application/pdf' ||
            p.filename?.toLowerCase().endsWith('.pdf')
        );

        if (!pdfPart?.body?.attachmentId) {
          console.warn(`[ct-parser] No PDF attachment in message ${msgId}`);
          await sendTelegramMessage(
            `⚠️ <b>CT Invoice: No PDF found</b>\nMessage ID: <code>${msgId}</code>\nCheck manually.`,
            'actionable',
          );
          continue;
        }

        // Download attachment
        const attachment = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msgId,
          id: pdfPart.body.attachmentId,
        });

        const base64Data = attachment.data.data!.replace(/-/g, '+').replace(/_/g, '/');
        const pdfBuffer = Buffer.from(base64Data, 'base64');

        // Parse PDF text
        const text = await extractPdfText(pdfBuffer);
        console.log(`[ct-parser] PDF text extracted, length: ${text.length}`);

        const { poNumber, trackingNumber, carrier, rawCarrier, trackingUrl } = parseInvoicePdf(text);
        console.log(`[ct-parser] Parsed — PO: ${poNumber}, Tracking: ${trackingNumber}, Carrier: ${carrier} (raw: ${rawCarrier})`);

        // Validate parsed fields
        if (!poNumber || !trackingNumber) {
          await sendTelegramMessage(
            `⚠️ <b>CT Invoice: Parse Failed</b>\n` +
            `PO #: ${poNumber ?? 'NOT FOUND'}\n` +
            `Tracking: ${trackingNumber ?? 'NOT FOUND'}\n` +
            `Please enter manually via Brain dashboard.`,
            'actionable',
          );
          failed++;
          continue;
        }

        // Walmart's ship API requires a tracking URL when the carrier is
        // OTHER. Only Midland Courier's OTHER case has a confirmed URL
        // pattern (set in parseInvoicePdf); any other carrier that resolves
        // to OTHER has no known pattern here and must fail explicitly
        // rather than silently falling through to walmart-ship.ts's
        // generic OTHER default (GLS's tracker — a real but wrong link for
        // a carrier that isn't GLS).
        if (carrier === 'OTHER' && !trackingUrl) {
          await sendTelegramMessage(
            `⚠️ <b>CT Invoice: Unknown OTHER-carrier tracking URL</b>\n` +
            `PO #: <code>${poNumber}</code>\n` +
            `Tracking: <code>${trackingNumber}</code>\n` +
            `Carrier text: <code>${rawCarrier}</code> (resolved to OTHER; no confirmed tracking-URL pattern)\n` +
            `Please enter tracking manually via Brain dashboard — do not let this ship with a placeholder URL.`,
            'actionable',
          );
          failed++;
          continue;
        }

        // Look up Walmart order ID by PO number
        const orderId = await getOrderIdByPoNumber(SHEET_ID, poNumber);

        if (!orderId) {
          await sendTelegramMessage(
            `⚠️ <b>CT Invoice: Order Not Found</b>\n` +
            `PO #: <code>${poNumber}</code> not in Sheet.\n` +
            `Tracking: <code>${trackingNumber}</code>\n` +
            `Please match manually.`,
            'actionable',
          );
          failed++;
          continue;
        }

        // Already shipped? No order-level dedup existed before this check —
        // the only prior protection was this email's own is:unread state,
        // which is fragile (see item 6 in the accompanying report) and
        // gives no protection at all for an order shipped through a side
        // channel (e.g. manually via Walmart Seller Center) whose Sheet row
        // was never updated to SHIPPED. This guard covers the case where
        // the Sheet DOES already say SHIPPED; it does not cover the
        // side-channel case — see the PR description for what still needs
        // manual verification before merge.
        const existingStatus = await getOrderStatus(SHEET_ID, orderId);
        if (existingStatus === 'SHIPPED') {
          console.log(`[ct-parser] Order ${orderId} already marked SHIPPED in sheet — skipping re-ship`);
          await gmail.users.messages.modify({
            userId: 'me',
            id: msgId,
            requestBody: { removeLabelIds: ['UNREAD'] },
          });
          continue;
        }

        // Call walmart-ship endpoint
        const shipRes = await fetch(
          `${SHIP_ENDPOINT}?orderId=${encodeURIComponent(orderId)}&trackingNumber=${encodeURIComponent(trackingNumber)}&carrier=${encodeURIComponent(carrier)}` +
          (trackingUrl ? `&trackingUrl=${encodeURIComponent(trackingUrl)}` : '')
        );

        if (!shipRes.ok) {
          const errText = await shipRes.text();
          throw new Error(`walmart-ship failed: ${shipRes.status} ${errText}`);
        }

        console.log(`[ct-parser] Order ${orderId} shipped successfully`);
        processed++;

        // Mark email as read
        await gmail.users.messages.modify({
          userId: 'me',
          id: msgId,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });

      } catch (msgErr: any) {
        console.error(`[ct-parser] Error processing message ${msgId}:`, msgErr);
        await sendTelegramMessage(
          `⚠️ <b>CT Parser ERROR</b>\nMessage: ${msgId}\n${msgErr.message}\nPlease process manually.`,
          'actionable',
        ).catch(() => {});
        failed++;
      }
    }

    return res.status(200).json({ processed, failed, total: messages.length });

  } catch (err: any) {
    console.error('[ct-parser] Fatal error:', err);
    await sendTelegramMessage(`⚠️ <b>ct-tracking-parser FATAL ERROR</b>\n${err.message}`, 'actionable').catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import { getOrderIdByPoNumber } from './lib/sheets-client.js';

const PDFParser = require('pdf2json');

export const config = { maxDuration: 60 };

const SHEET_ID = process.env.WALMART_ORDER_LOG_SHEET_ID!;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
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

// ── Telegram ───────────────────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    }),
  });
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
}

function parseInvoicePdf(text: string): ParsedInvoice {
  // PO # — e.g. "GCI0003"
  const poMatch = text.match(/PO\s*#[\s:]*([ A-Z]{2,4}\d{3,6})/i);
  const poNumber = poMatch ? poMatch[1].toUpperCase() : null;

  // Tracking Number — labeled field in CT invoice
  const trackingMatch = text.match(/Tracking\s*Number[\s:]*([A-Z0-9]{6,30})/i);
  const trackingNumber = trackingMatch ? trackingMatch[1] : null;

  // Carrier — from Mode of Delivery field
  const carrierMatch = text.match(/Mode\s*of\s*Delivery[\s:]*\*?([A-Z]+)/i);
  const rawCarrier = carrierMatch ? carrierMatch[1].toLowerCase() : 'purolator';

  const carrierMap: Record<string, string> = {
    gls: 'OTHER',
    purolator: 'PUROLATOR',
    ups: 'UPS',
    fedex: 'FEDEX',
    dhl: 'DHL',
    canadapost: 'CANADA_POST',
  };
  const carrier = carrierMap[rawCarrier] ?? 'OTHER';

  return { poNumber, trackingNumber, carrier };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const gmail = getGmailClient();

    // Search for unread CT invoices from last 48 hours
    const searchRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:info@cdatire.com subject:"Invoice CS" has:attachment newer_than:2d is:unread',
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
          await sendTelegram(
            `⚠️ <b>CT Invoice: No PDF found</b>\nMessage ID: <code>${msgId}</code>\nCheck manually.`
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

        const { poNumber, trackingNumber, carrier } = parseInvoicePdf(text);
        console.log(`[ct-parser] Parsed — PO: ${poNumber}, Tracking: ${trackingNumber}, Carrier: ${carrier}`);

        // Validate parsed fields
        if (!poNumber || !trackingNumber) {
          await sendTelegram(
            `⚠️ <b>CT Invoice: Parse Failed</b>\n` +
            `PO #: ${poNumber ?? 'NOT FOUND'}\n` +
            `Tracking: ${trackingNumber ?? 'NOT FOUND'}\n` +
            `Please enter manually via Brain dashboard.`
          );
          failed++;
          continue;
        }

        // Look up Walmart order ID by PO number
        const orderId = await getOrderIdByPoNumber(SHEET_ID, poNumber);

        if (!orderId) {
          await sendTelegram(
            `⚠️ <b>CT Invoice: Order Not Found</b>\n` +
            `PO #: <code>${poNumber}</code> not in Sheet.\n` +
            `Tracking: <code>${trackingNumber}</code>\n` +
            `Please match manually.`
          );
          failed++;
          continue;
        }

        // Call walmart-ship endpoint
        const shipRes = await fetch(
          `${SHIP_ENDPOINT}?orderId=${encodeURIComponent(orderId)}&trackingNumber=${encodeURIComponent(trackingNumber)}&carrier=${encodeURIComponent(carrier)}`
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
        await sendTelegram(
          `⚠️ <b>CT Parser ERROR</b>\nMessage: ${msgId}\n${msgErr.message}\nPlease process manually.`
        ).catch(() => {});
        failed++;
      }
    }

    return res.status(200).json({ processed, failed, total: messages.length });

  } catch (err: any) {
    console.error('[ct-parser] Fatal error:', err);
    await sendTelegram(`⚠️ <b>ct-tracking-parser FATAL ERROR</b>\n${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}

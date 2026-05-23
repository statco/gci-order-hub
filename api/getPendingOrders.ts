import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';

export const maxDuration = 30;

const SHEET_ID = process.env.WALMART_ORDER_LOG_SHEET_ID!;

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (_req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:N',
    });

    const rows = response.data.values ?? [];
    if (rows.length === 0) return res.status(200).json({ orders: [] });

    const pending = rows
      .slice(1)
      .filter((row) => row[7] === 'PENDING_CT')
      .map((row) => ({
        order_id:         row[0] ?? '',
        created_at:       row[1] ?? '',
        sku:              row[2] ?? '',
        qty:              row[3] ?? '',
        customer_name:    row[4] ?? '',
        customer_address: row[5] ?? '',
        price:            row[6] ?? '',
        status:           row[7] ?? '',
        walmart_ack:      row[11] ?? '',
        po_number:        row[13] ?? '',
      }));

    const seen = new Map<string, any>();
    for (const row of pending) {
      if (!seen.has(row.order_id)) {
        seen.set(row.order_id, { ...row, skus: [{ sku: row.sku, qty: row.qty, price: row.price }] });
      } else {
        seen.get(row.order_id).skus.push({ sku: row.sku, qty: row.qty, price: row.price });
      }
    }

    return res.status(200).json({ orders: Array.from(seen.values()) });
  } catch (err: any) {
    console.error('[getPendingOrders]', err);
    return res.status(500).json({ error: err.message });
  }
}
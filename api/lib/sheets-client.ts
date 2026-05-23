import { google } from 'googleapis';

const SHEET_TAB = 'Sheet1';

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function getSheetOrderIds(sheetId: string): Promise<Set<string>> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A:A`,
  });

  const values = response.data.values ?? [];
  const ids = values.slice(1).map((row) => row[0]).filter(Boolean);
  return new Set(ids);
}

export async function appendSheetRows(
  sheetId: string,
  rows: string[][]
): Promise<void> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A:N`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

export async function updateSheetRow(
  sheetId: string,
  rowIndex: number,
  updates: Partial<{
    status: string;
    tracking_number: string;
    carrier: string;
    shipped_at: string;
    notes: string;
  }>
): Promise<void> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const columnMap: Record<string, string> = {
    status: 'H',
    tracking_number: 'I',
    carrier: 'J',
    shipped_at: 'K',
    notes: 'M',
  };

  for (const [field, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const col = columnMap[field];
    if (!col) continue;

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_TAB}!${col}${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  }
}

export async function updateSheetRowByOrderId(
  sheetId: string,
  orderId: string,
  updates: Partial<{
    status: string;
    tracking_number: string;
    carrier: string;
    shipped_at: string;
    notes: string;
  }>
): Promise<void> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A:A`,
  });

  const rows = response.data.values ?? [];
  const matchingRows: number[] = [];
  rows.forEach((row, index) => {
    if (index === 0) return;
    if (row[0] === orderId) matchingRows.push(index + 1);
  });

  if (matchingRows.length === 0) {
    console.warn(`[sheets] No rows found for orderId ${orderId}`);
    return;
  }

  const columnMap: Record<string, string> = {
    status: 'H',
    tracking_number: 'I',
    carrier: 'J',
    shipped_at: 'K',
    notes: 'M',
  };

  for (const rowIndex of matchingRows) {
    for (const [field, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      const col = columnMap[field];
      if (!col) continue;

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${SHEET_TAB}!${col}${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[value]] },
      });
    }
  }
}

// ── PO Number helpers ──────────────────────────────────────────────────────

export async function getNextPoNumber(sheetId: string): Promise<string> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!N:N`,
  });

  const values = response.data.values ?? [];
  // Extract numeric parts from existing GCI#### entries
  const numbers = values
    .slice(1)
    .map((row) => row[0])
    .filter((v) => v && /^GCI\d+$/.test(v))
    .map((v) => parseInt(v.replace('GCI', ''), 10));

  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  const next = max + 1;
  return `GCI${String(next).padStart(4, '0')}`;
}

export async function getOrderIdByPoNumber(
  sheetId: string,
  poNumber: string
): Promise<string | null> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Fetch columns A (order_id) and N (po_number)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A:N`,
  });

  const rows = response.data.values ?? [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const po = row[13]; // column N (0-indexed)
    if (po === poNumber) {
      return row[0] ?? null; // column A = order_id
    }
  }

  return null;
}
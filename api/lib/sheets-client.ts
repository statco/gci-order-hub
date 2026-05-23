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
    range: `${SHEET_TAB}!A:M`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

export async function updateSheetRow(
  sheetId: string,
  rowIndex: number, // 1-based, accounting for header
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

  // Column map (1-based): status=H, tracking=I, carrier=J, shipped_at=K, notes=M
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
      range: `${SHEET_TAB}!${col}${rowIndex + 1}`, // +1 for header
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  }
}
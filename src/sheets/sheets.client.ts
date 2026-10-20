import { google, sheets_v4 } from 'googleapis';
import type { SyncColumn } from './sheet-row';
import type { SheetsSettings } from './sheets.config';

/** What the sync processor needs from the sheet; faked in tests. */
export interface SheetsClient {
  /** Column A top to bottom (row 1 first), '' for empty cells. */
  readKeys(): Promise<string[]>;
  /** Writes the given cells of one row (1-based). */
  updateCells(
    row: number,
    cells: Partial<Record<SyncColumn, string>>,
  ): Promise<void>;
  /** Appends a new row, values for A onwards. */
  appendRow(values: string[]): Promise<void>;
}

export const SHEETS_CLIENT = 'SHEETS_CLIENT';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Sheets API v4 over the service account. Only the sync processor uses it. */
export class GoogleSheetsClient implements SheetsClient {
  private readonly api: sheets_v4.Sheets;

  constructor(private readonly settings: SheetsSettings) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: settings.clientEmail,
        private_key: settings.privateKey,
      },
      scopes: [SCOPE],
    });
    this.api = google.sheets({ version: 'v4', auth });
  }

  /** `'My tab'!A1` — tab names are quoted, inner quotes doubled. */
  private range(a1: string): string {
    return `'${this.settings.sheetName.replace(/'/g, "''")}'!${a1}`;
  }

  async readKeys(): Promise<string[]> {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.settings.spreadsheetId,
      range: this.range('A:A'),
      majorDimension: 'ROWS',
    });
    const rows = (res.data.values ?? []) as unknown[][];
    return rows.map((r) => {
      const cell = r[0];
      return typeof cell === 'string' || typeof cell === 'number'
        ? String(cell)
        : '';
    });
  }

  async updateCells(
    row: number,
    cells: Partial<Record<SyncColumn, string>>,
  ): Promise<void> {
    const data = Object.entries(cells).map(([column, value]) => ({
      range: this.range(`${column}${row}`),
      values: [[value]],
    }));
    if (data.length === 0) return;
    await this.api.spreadsheets.values.batchUpdate({
      spreadsheetId: this.settings.spreadsheetId,
      // RAW: a name like "=HYPERLINK(…)" is stored as text, never evaluated.
      requestBody: { valueInputOption: 'RAW', data },
    });
  }

  async appendRow(values: string[]): Promise<void> {
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.settings.spreadsheetId,
      range: this.range('A:I'),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';

export interface SheetsSettings {
  spreadsheetId: string;
  /** The tab holding the A–J table. */
  sheetName: string;
  clientEmail: string;
  privateKey: string;
}

export class SheetsNotConfiguredError extends Error {
  constructor(readonly invalid: string[]) {
    super(
      `Google Sheets is not configured: missing/invalid ${invalid.join(', ')}`,
    );
    this.name = 'SheetsNotConfiguredError';
  }
}

/** The key file's fields we need, from inline JSON or a path to the file. */
function readServiceAccount(
  value: string,
): { clientEmail: string; privateKey: string } | null {
  try {
    const json = value.startsWith('{')
      ? value
      : existsSync(value)
        ? readFileSync(value, 'utf8')
        : null;
    if (json === null) return null;
    const parsed = JSON.parse(json) as {
      client_email?: unknown;
      private_key?: unknown;
    };
    if (
      typeof parsed.client_email !== 'string' ||
      typeof parsed.private_key !== 'string'
    ) {
      return null;
    }
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  } catch {
    return null; // never echo the value: it holds the private key
  }
}

/**
 * Sheets env, validated on first use rather than at boot, so the bot runs
 * without Google credentials (sync jobs then wait in the queue).
 */
@Injectable()
export class SheetsConfig {
  private cached?: SheetsSettings;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    try {
      this.get();
      return true;
    } catch (err) {
      if (err instanceof SheetsNotConfiguredError) return false;
      throw err;
    }
  }

  /** @throws SheetsNotConfiguredError */
  get(): SheetsSettings {
    if (this.cached) return this.cached;

    const read = (key: string) =>
      String(this.config.get<string>(key) ?? '').trim();
    const spreadsheetId = read('GOOGLE_SHEETS_SPREADSHEET_ID');
    const sheetName = read('GOOGLE_SHEETS_SHEET_NAME') || 'Sheet1';
    const account = readServiceAccount(read('GOOGLE_SERVICE_ACCOUNT_JSON'));

    const invalid: string[] = [];
    if (!/^[\w-]{20,}$/.test(spreadsheetId)) {
      invalid.push('GOOGLE_SHEETS_SPREADSHEET_ID');
    }
    if (!account) invalid.push('GOOGLE_SERVICE_ACCOUNT_JSON');
    if (invalid.length > 0 || !account) {
      throw new SheetsNotConfiguredError(invalid);
    }

    this.cached = { spreadsheetId, sheetName, ...account };
    return this.cached;
  }
}

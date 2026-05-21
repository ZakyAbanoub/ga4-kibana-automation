/** Central configuration. Secrets come from env; non-secret constants are inline. */

export const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? '482794016';

/** Spreadsheet the automation writes to (our editable refactored copy). */
export const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID ?? '1GM3EAQgtGH93YQggku98C6SO9C_JFVaiqvyE_pAPwVA';

export const KIBANA_BASE_URL = process.env.KIBANA_BASE_URL ?? 'https://stats.loquis.com';
export const KIBANA_INDEX = process.env.KIBANA_INDEX ?? 'plays';
export const KIBANA_USER = process.env.KIBANA_USER ?? '';
/**
 * The Kibana password contains characters ('"#) that are awkward in .env files,
 * so it is supplied base64-encoded via KIBANA_PASS_B64. Plain KIBANA_PASS still wins.
 */
export const KIBANA_PASS =
  process.env.KIBANA_PASS ??
  (process.env.KIBANA_PASS_B64
    ? Buffer.from(process.env.KIBANA_PASS_B64, 'base64').toString('utf8')
    : '');

/** Substring identifying Lastminute plays inside Kibana `source_ref`. */
export const KIBANA_SOURCE_REF_MATCH = 'lastminute';

/**
 * Google service-account credentials.
 * Locally: GOOGLE_APPLICATION_CREDENTIALS points at the JSON key file.
 * On Vercel: GOOGLE_CREDENTIALS_JSON holds the key file contents as a string.
 */
export function googleCredentials(): { keyFile?: string; credentials?: object } {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) };
  }
  return { keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? 'secrets/ga4-service-account.json' };
}

/** History window. The report starts at ISO week 52/2025. */
export const REPORT_START = { isoYear: 2025, isoWeek: 52 };

/** Earliest calendar date to query (a few days before week 52/2025). */
export const HISTORY_START_DATE = '2025-12-22';

function required(name: string, value: string): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function assertKibanaConfigured(): void {
  required('KIBANA_USER', KIBANA_USER);
  required('KIBANA_PASS', KIBANA_PASS);
}

/**
 * Google Sheets writer.
 *
 * Safety contract:
 *  - Writes only raw_* tabs and the presentation tabs listed in transform.ts.
 *  - Never touches "CRM Email Metrics" (manual client data).
 *  - "CRM Clicks" values already present in the weekly tabs are read back and
 *    re-placed, so reordering rows never loses manually entered client data.
 */

import { accessToken } from './google.js';
import { SPREADSHEET_ID } from './config.js';
import { crmKey } from './transform.js';
import type { TabPayload } from './transform.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Rows are cleared up to here to remove stale data from previous runs. */
const MAX_ROWS = 5000;

interface SheetMeta {
  title: string;
  sheetId: number;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const token = await accessToken();
  const res = await fetch(`${API}/${SPREADSHEET_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Sheets API ${init?.method ?? 'GET'} ${path} failed ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/** A1 range for a whole tab, quoting the title (handles spaces and unicode). */
function tabRange(title: string, a1 = 'A1:ZZ' + MAX_ROWS): string {
  return encodeURIComponent(`'${title.replace(/'/g, "''")}'!${a1}`);
}

export async function listTabs(): Promise<SheetMeta[]> {
  const data = await api('?fields=sheets.properties(title,sheetId)');
  return (data.sheets ?? []).map((s: any) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
  }));
}

/** Create any missing tabs from the payload list. */
async function ensureTabs(payloads: TabPayload[], existing: SheetMeta[]): Promise<void> {
  const have = new Set(existing.map((t) => t.title));
  const toAdd = payloads.filter((p) => !have.has(p.tab)).map((p) => p.tab);
  if (toAdd.length === 0) return;
  await api(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })),
    }),
  });
}

/**
 * Read the "CRM Clicks" column already present in a weekly tab, keyed by
 * (market, year, week), so it survives a row reorder.
 */
export async function readExistingCrmClicks(tabTitle: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let data: any;
  try {
    data = await api(`/values/${tabRange(tabTitle, 'A2:D' + MAX_ROWS)}`);
  } catch {
    return map; // tab not present yet — nothing to preserve
  }
  for (const row of data.values ?? []) {
    const [market, year, week, clicks] = row;
    if (!market || clicks === undefined || clicks === '') continue;
    const n = Number(String(clicks).replace(',', '.'));
    if (!Number.isNaN(n)) map.set(crmKey(market, Number(year), Number(week)), n);
  }
  return map;
}

/** Write one tab: header at A1, data from A2, stale trailing rows cleared. */
async function writeTab(payload: TabPayload): Promise<void> {
  const values = [payload.header, ...payload.rows];
  const lastRow = values.length;

  // Clear the whole data area first (covers shrinking data and changed widths).
  await api(`/values/${tabRange(payload.tab)}:clear`, { method: 'POST', body: '{}' });

  await api(
    `/values/${tabRange(payload.tab, 'A1')}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values }) },
  );
  void lastRow;
}

export interface WriteSummary {
  tab: string;
  rows: number;
}

/**
 * Update the derived KPI cells on "Summary Dashboard".
 * Only the unambiguously computed cells are touched — Generated date,
 * Active Markets, Total Audio Plays. Coverage/inventory cells are left manual.
 */
export async function updateSummaryKpis(args: {
  generatedAt: Date;
  activeMarkets: number;
  totalAudioPlays: number;
}): Promise<void> {
  const tab = 'Summary Dashboard';
  // Single "Last Update" row (was "Generated") — date only, in Europe/Rome.
  const lastUpdate = args.generatedAt.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'Europe/Rome',
  });
  const updates: Array<{ a1: string; value: string | number }> = [
    { a1: 'A4', value: 'Last Update' },
    { a1: 'B4', value: lastUpdate },
    // Clear the row 5 leftover from when "Last Update" lived below "Generated".
    { a1: 'A5', value: '' },
    { a1: 'B5', value: '' },
    { a1: 'E8', value: args.activeMarkets },
    { a1: 'G8', value: args.totalAudioPlays },
  ];
  for (const u of updates) {
    await api(
      `/values/${tabRange(tab, u.a1)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [[u.value]] }) },
    );
  }
}

/** Push every tab payload to the spreadsheet. Returns a per-tab row count. */
export async function writeAllTabs(payloads: TabPayload[]): Promise<WriteSummary[]> {
  const existing = await listTabs();
  await ensureTabs(payloads, existing);
  const summary: WriteSummary[] = [];
  for (const p of payloads) {
    await writeTab(p);
    summary.push({ tab: p.tab, rows: p.rows.length });
  }
  return summary;
}

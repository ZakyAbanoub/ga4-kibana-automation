/**
 * Google Sheets writer.
 *
 * Safety contract:
 *  - Writes only raw_* tabs and the presentation tabs listed in transform.ts.
 *  - Never touches "CRM Email Metrics" (manual client data).
 *  - "CRM Clicks" values already present in the weekly tabs are read back and
 *    re-placed, so reordering rows never loses manually entered client data.
 *
 * Every public function is parameterised on `spreadsheetId` so the same
 * pipeline run can write to multiple files (e.g. internal + client copy).
 */

import { accessToken } from './google.js';
import { crmKey } from './transform.js';
import type { TabPayload } from './transform.js';
import type { RawTabsMode } from './config.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Rows are cleared up to here to remove stale data from previous runs. */
const MAX_ROWS = 5000;
/** Extra pixels added to each side of every column after autoResize. */
const COLUMN_PADDING_PX = 18;

interface SheetMeta {
  title: string;
  sheetId: number;
}

async function api(
  spreadsheetId: string,
  path: string,
  init?: RequestInit,
): Promise<any> {
  const token = await accessToken();
  const res = await fetch(`${API}/${spreadsheetId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      `Sheets API ${init?.method ?? 'GET'} ${path} failed ${res.status}: ${await res.text()}`,
    );
  }
  return res.status === 204 ? null : res.json();
}

/** A1 range for a whole tab, quoting the title (handles spaces and unicode). */
function tabRange(title: string, a1 = 'A1:ZZ' + MAX_ROWS): string {
  return encodeURIComponent(`'${title.replace(/'/g, "''")}'!${a1}`);
}

export async function listTabs(spreadsheetId: string): Promise<SheetMeta[]> {
  const data = await api(spreadsheetId, '?fields=sheets.properties(title,sheetId)');
  return (data.sheets ?? []).map((s: any) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
  }));
}

/** Create any missing tabs from the payload list. */
async function ensureTabs(
  spreadsheetId: string,
  payloads: TabPayload[],
  existing: SheetMeta[],
): Promise<void> {
  const have = new Set(existing.map((t) => t.title));
  const toAdd = payloads.filter((p) => !have.has(p.tab)).map((p) => p.tab);
  if (toAdd.length === 0) return;
  await api(spreadsheetId, ':batchUpdate', {
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
export async function readExistingCrmClicks(
  spreadsheetId: string,
  tabTitle: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let data: any;
  try {
    data = await api(spreadsheetId, `/values/${tabRange(tabTitle, 'A2:D' + MAX_ROWS)}`);
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
async function writeTab(spreadsheetId: string, payload: TabPayload): Promise<void> {
  const values = [payload.header, ...payload.rows];
  // Clear the whole data area first (covers shrinking data and changed widths).
  await api(spreadsheetId, `/values/${tabRange(payload.tab)}:clear`, {
    method: 'POST',
    body: '{}',
  });
  await api(
    spreadsheetId,
    `/values/${tabRange(payload.tab, 'A1')}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values }) },
  );
}

export interface WriteSummary {
  tab: string;
  rows: number;
}

/**
 * Update the derived KPI cells on "Summary Dashboard".
 * Only the unambiguously computed cells are touched — Last Update, Report
 * Period, Active Markets, Total Audio Plays. Coverage/inventory cells stay manual.
 */
export async function updateSummaryKpis(args: {
  spreadsheetId: string;
  generatedAt: Date;
  reportPeriod: string;
  activeMarkets: number;
  totalAudioPlays: number;
}): Promise<void> {
  const tab = 'Summary Dashboard';
  const lastUpdate = args.generatedAt.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'Europe/Rome',
  });
  const updates: Array<{ a1: string; value: string | number; formula?: boolean }> = [
    { a1: 'B3', value: args.reportPeriod },
    { a1: 'A4', value: 'Last Update' },
    { a1: 'B4', value: lastUpdate },
    // Clear the row 5 leftover from when "Last Update" lived below "Generated".
    { a1: 'A5', value: '' },
    { a1: 'B5', value: '' },
    { a1: 'E8', value: args.activeMarkets },
    { a1: 'G8', value: args.totalAudioPlays },
    // Language Availability — % Coverage column. Computed dynamically from
    // B<row> (destinations implemented for this language) divided by A8
    // (universe of destinations from KEY METRICS). Single-argument division
    // avoids the locale-specific argument separator (en uses ',', it uses ';').
    // The cells get numberFormat=PERCENT applied separately below.
    { a1: 'C13', value: '=B13/$A$8', formula: true },
    { a1: 'C14', value: '=B14/$A$8', formula: true },
    { a1: 'C15', value: '=B15/$A$8', formula: true },
    { a1: 'C16', value: '=B16/$A$8', formula: true },
    { a1: 'C17', value: '=B17/$A$8', formula: true },
  ];
  for (const u of updates) {
    const opt = u.formula ? 'USER_ENTERED' : 'RAW';
    await api(
      args.spreadsheetId,
      `/values/${tabRange(tab, u.a1)}?valueInputOption=${opt}`,
      { method: 'PUT', body: JSON.stringify({ values: [[u.value]] }) },
    );
  }

  // Apply PERCENT number format to C13:C17 so the division formula renders
  // as "100%" instead of "1". Needs the sheetId, hence the listTabs lookup.
  const tabs = await listTabs(args.spreadsheetId);
  const summary = tabs.find((t) => t.title === tab);
  if (summary) {
    await api(args.spreadsheetId, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: summary.sheetId,
                startRowIndex: 12, endRowIndex: 17, // rows 13..17 (zero-based)
                startColumnIndex: 2, endColumnIndex: 3, // column C
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'PERCENT', pattern: '0%' },
                },
              },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
        ],
      }),
    });
  }
}

/**
 * Tile the formatting of one source column across a destination column range.
 * Used for "Widget Performance" — the tab gains a column whenever a new
 * widget type appears in Kibana, and the new columns ship unstyled. Copying
 * format from an existing numeric column (Total Audio) brings the dark-blue
 * header and Arial data styling along automatically.
 */
async function copyColumnFormat(
  spreadsheetId: string,
  sheetId: number,
  srcCol: number,
  destStartCol: number,
  destEndCol: number,
  lastRow: number,
): Promise<void> {
  if (destEndCol <= destStartCol) return;
  await api(spreadsheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: 0, endRowIndex: lastRow,
              startColumnIndex: srcCol, endColumnIndex: srcCol + 1,
            },
            destination: {
              sheetId,
              startRowIndex: 0, endRowIndex: lastRow,
              startColumnIndex: destStartCol, endColumnIndex: destEndCol,
            },
            pasteType: 'PASTE_FORMAT',
            pasteOrientation: 'NORMAL',
          },
        },
      ],
    }),
  });
}

/**
 * Reset basicFilter on a presentation tab to span the freshly written data
 * with no hiddenValues. Without this the existing filter (1) keeps a stale
 * endRowIndex so newly added rows are invisible to the dropdown, and (2) can
 * keep markets hidden from a previous manual filter.
 */
async function setFullRangeFilter(
  spreadsheetId: string,
  sheetId: number,
  rows: number,
  cols: number,
): Promise<void> {
  await api(spreadsheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        { clearBasicFilter: { sheetId } },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: rows,
                startColumnIndex: 0,
                endColumnIndex: cols,
              },
            },
          },
        },
      ],
    }),
  });
}

/**
 * Auto-resize every column to the widest cell text, then add side padding and
 * centre-align the contents so the header isn't flush against the cell edge.
 * Headers are forced to wrapStrategy=OVERFLOW_CELL so autoResize sees the full
 * label width (with WRAP it sizes to the widest *word*).
 */
async function autoResizeAll(
  spreadsheetId: string,
  payloads: TabPayload[],
  allTabs: SheetMeta[],
): Promise<void> {
  const widthByTab = new Map<string, number>();
  for (const p of payloads) widthByTab.set(p.tab, p.header.length);

  const step1: object[] = [];
  for (const t of allTabs) {
    const endColumnIndex = widthByTab.get(t.title) ?? 10;
    step1.push({
      repeatCell: {
        range: {
          sheetId: t.sheetId,
          startRowIndex: 0, endRowIndex: 1,
          startColumnIndex: 0, endColumnIndex,
        },
        cell: { userEnteredFormat: { wrapStrategy: 'OVERFLOW_CELL' } },
        fields: 'userEnteredFormat.wrapStrategy',
      },
    });
    step1.push({
      repeatCell: {
        range: {
          sheetId: t.sheetId,
          startRowIndex: 0,
          startColumnIndex: 0, endColumnIndex,
        },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    });
    step1.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: t.sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: endColumnIndex,
        },
      },
    });
  }
  if (step1.length === 0) return;
  await api(spreadsheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: step1 }),
  });

  // Step 2 — read back the autoResize-derived widths and pad each column.
  const ranges = allTabs
    .map((t) => `ranges=${encodeURIComponent(`'${t.title.replace(/'/g, "''")}'!A1:Z1`)}`)
    .join('&');
  const meta = await api(
    spreadsheetId,
    `?${ranges}&fields=sheets(properties(title),data(columnMetadata(pixelSize)))&includeGridData=true`,
  );
  const widthsByTitle = new Map<string, number[]>();
  for (const s of meta.sheets ?? []) {
    const cols = s.data?.[0]?.columnMetadata ?? [];
    widthsByTitle.set(s.properties.title, cols.map((c: any) => c.pixelSize ?? 0));
  }

  const step2: object[] = [];
  for (const t of allTabs) {
    const widths = widthsByTitle.get(t.title) ?? [];
    const cols = widthByTab.get(t.title) ?? 10;
    for (let i = 0; i < cols; i++) {
      const current = widths[i] ?? 100;
      step2.push({
        updateDimensionProperties: {
          range: {
            sheetId: t.sheetId,
            dimension: 'COLUMNS',
            startIndex: i,
            endIndex: i + 1,
          },
          properties: { pixelSize: current + COLUMN_PADDING_PX * 2 },
          fields: 'pixelSize',
        },
      });
    }
  }
  if (step2.length === 0) return;
  await api(spreadsheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: step2 }),
  });
}

/**
 * Apply the desired hidden flag to every existing raw_* tab on this sheet.
 * Used to make raw audit tabs invisible (or visible) without touching their data.
 */
async function applyRawVisibility(
  spreadsheetId: string,
  allTabs: SheetMeta[],
  hidden: boolean,
): Promise<void> {
  const requests = allTabs
    .filter((t) => t.title.startsWith('raw_'))
    .map((t) => ({
      updateSheetProperties: {
        properties: { sheetId: t.sheetId, hidden },
        fields: 'hidden',
      },
    }));
  if (requests.length === 0) return;
  await api(spreadsheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

/**
 * Push every tab payload to the spreadsheet. Returns a per-tab row count.
 *
 * `rawMode` controls whether raw_* tabs are written and visible:
 *   - 'hidden'  write raw_* + mark them hidden (default for internal file)
 *   - 'visible' write raw_* + keep them visible
 *   - 'off'     skip raw_* entirely; also hide any pre-existing raw_* tabs
 */
export async function writeAllTabs(
  spreadsheetId: string,
  payloads: TabPayload[],
  rawMode: RawTabsMode,
): Promise<WriteSummary[]> {
  const effective = rawMode === 'off' ? payloads.filter((p) => !p.raw) : payloads;
  const existing = await listTabs(spreadsheetId);
  await ensureTabs(spreadsheetId, effective, existing);
  const all = await listTabs(spreadsheetId);
  const idByTitle = new Map(all.map((t) => [t.title, t.sheetId]));

  const summary: WriteSummary[] = [];
  for (const p of effective) {
    await writeTab(spreadsheetId, p);
    summary.push({ tab: p.tab, rows: p.rows.length });
    if (!p.raw) {
      const sheetId = idByTitle.get(p.tab);
      if (sheetId !== undefined) {
        const totalRows = p.rows.length + 1; // +1 for header
        await setFullRangeFilter(spreadsheetId, sheetId, totalRows, p.header.length);
        if (p.tab === 'Widget Performance' && p.header.length > 3) {
          await copyColumnFormat(spreadsheetId, sheetId, 2, 3, p.header.length, totalRows);
        }
      }
    }
  }

  await autoResizeAll(spreadsheetId, effective, all);

  // Raw visibility — hide for 'hidden' or 'off' (off also covers files where
  // raw tabs already exist from a previous run); show for 'visible'.
  const hideRaw = rawMode !== 'visible';
  await applyRawVisibility(spreadsheetId, all, hideRaw);

  return summary;
}

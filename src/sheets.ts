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

/**
 * Tabs the script used to own and no longer does. They get deleted from the
 * spreadsheet on the next run so stale data can't be mistaken for live data.
 * Note the trailing space on "Vista per Mercato " — matches the actual title
 * as set by the original Loquis refactor.
 */
const DEPRECATED_TABS = new Set<string>(['Vista per Mercato ']);

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
 * Read the `Clicked` column from the manual "CRM Email Metrics" tab and key
 * it by (market, year, week) so the weekly performance tab can join on it.
 *
 * CRM Email Metrics layout (manual client input):
 *   A Market | B Week | C Year | D Delivered | E Opened | F Clicked | G Open Rate | H CTR
 *
 * Rows are skipped (mapping not produced) when Market / Week / Year / Clicked
 * are missing or unparseable. Skipped rows leave the corresponding cell in
 * Weekly Performance empty — the next run picks them up once the client fills
 * the missing values in CRM Email Metrics.
 */
export async function readCrmClicksFromEmailMetrics(
  spreadsheetId: string,
  tabTitle = 'CRM Email Metrics',
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let data: any;
  try {
    data = await api(spreadsheetId, `/values/${tabRange(tabTitle, 'A2:F' + MAX_ROWS)}`);
  } catch {
    return map; // tab missing — nothing to join
  }
  for (const row of data.values ?? []) {
    const market = row[0];
    const week = row[1];
    const year = row[2];
    const clicked = row[5];
    if (!market || !week || !year || clicked === undefined || clicked === '') continue;
    const w = Number(week);
    const y = Number(year);
    const c = Number(String(clicked).replace(',', '.'));
    if (!Number.isFinite(w) || !Number.isFinite(y) || !Number.isFinite(c)) continue;
    map.set(crmKey(String(market), y, w), c);
  }
  return map;
}

/**
 * Write every tab's values in two batched API calls instead of one-per-tab.
 *
 * The Sheets API caps write requests at 60/min/user. Doing 2 PUTs per tab
 * (clear + update) for 5+ tabs quickly approaches the limit, especially when
 * the refresh runs against multiple spreadsheets. Collapsing every clear and
 * every update into one `values:batchClear` + one `values:batchUpdate` keeps
 * the write count flat regardless of how many tabs we own.
 */
async function writeAllValues(
  spreadsheetId: string,
  payloads: TabPayload[],
): Promise<void> {
  if (payloads.length === 0) return;
  const ranges = payloads.map((p) => `'${p.tab.replace(/'/g, "''")}'!A1:ZZ${MAX_ROWS}`);
  await api(spreadsheetId, '/values:batchClear', {
    method: 'POST',
    body: JSON.stringify({ ranges }),
  });
  const data = payloads.map((p) => ({
    range: `'${p.tab.replace(/'/g, "''")}'!A1`,
    majorDimension: 'ROWS',
    values: [p.header, ...p.rows],
  }));
  await api(spreadsheetId, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
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
  /**
   * Total destination universe (KEY METRICS "Destinations" cell A8). Used as
   * the denominator for the % Coverage formula in C13:C17, so it has to track
   * the destination registry — otherwise adding a destination silently breaks
   * the percentages.
   */
  totalDestinations: number;
  /**
   * Destination counts per language code (en/it/fr/es/de). Drives the
   * Language Availability "Destinations" column (B13..B17). Omit to leave
   * those cells untouched (e.g. when the WP fetch failed).
   */
  destinationsByLanguage?: Record<string, number>;
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
    { a1: 'A8', value: args.totalDestinations },
    { a1: 'E8', value: args.activeMarkets },
    { a1: 'G8', value: args.totalAudioPlays },
    // LP × Language (KEY METRICS) = sum of the per-language destination counts.
    // Reflects edits in B13..B17 automatically.
    { a1: 'C8', value: '=SUM(B13:B17)', formula: true },
    // Language Availability — Destinations column, fed by the WP /pages API.
    // Each cell only written when the API returned a number for that language.
    ...(args.destinationsByLanguage
      ? ([
          { a1: 'B13', value: args.destinationsByLanguage.en ?? 0 },
          { a1: 'B14', value: args.destinationsByLanguage.it ?? 0 },
          { a1: 'B15', value: args.destinationsByLanguage.fr ?? 0 },
          { a1: 'B16', value: args.destinationsByLanguage.es ?? 0 },
          { a1: 'B17', value: args.destinationsByLanguage.de ?? 0 },
        ] as Array<{ a1: string; value: string | number; formula?: boolean }>)
      : []),
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
  // Group by valueInputOption so each group becomes one values:batchUpdate
  // call (instead of one PUT per cell — was 17 writes, now 2).
  const rawData = updates
    .filter((u) => !u.formula)
    .map((u) => ({ range: `'${tab}'!${u.a1}`, values: [[u.value]] }));
  const formulaData = updates
    .filter((u) => u.formula)
    .map((u) => ({ range: `'${tab}'!${u.a1}`, values: [[u.value]] }));

  if (rawData.length > 0) {
    await api(args.spreadsheetId, '/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data: rawData }),
    });
  }
  if (formulaData.length > 0) {
    await api(args.spreadsheetId, '/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: formulaData }),
    });
  }

  // Apply PERCENT number format to C13:C17 so the division formula renders
  // as "100%" instead of "1". One batchUpdate, no per-cell PUT.
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

  // Batched values write — one batchClear + one batchUpdate covers every tab.
  await writeAllValues(spreadsheetId, effective);

  // Collect every formatting request (filter resets, Widget format copy, raw
  // visibility) into a single batchUpdate so we don't burn one API call per
  // operation.
  const formatRequests: object[] = [];
  for (const p of effective) {
    if (p.raw) continue;
    const sheetId = idByTitle.get(p.tab);
    if (sheetId === undefined) continue;
    const totalRows = p.rows.length + 1;
    // Filter reset: clear + set spanning the new data with no hiddenValues.
    formatRequests.push({ clearBasicFilter: { sheetId } });
    formatRequests.push({
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0, endRowIndex: totalRows,
            startColumnIndex: 0, endColumnIndex: p.header.length,
          },
        },
      },
    });
    if (p.tab === 'Widget Performance' && p.header.length > 3) {
      formatRequests.push({
        copyPaste: {
          source: {
            sheetId,
            startRowIndex: 0, endRowIndex: totalRows,
            startColumnIndex: 2, endColumnIndex: 3,
          },
          destination: {
            sheetId,
            startRowIndex: 0, endRowIndex: totalRows,
            startColumnIndex: 3, endColumnIndex: p.header.length,
          },
          pasteType: 'PASTE_FORMAT',
          pasteOrientation: 'NORMAL',
        },
      });
    }
  }
  // Raw visibility (same batch): hide for hidden/off, show for visible.
  const hideRaw = rawMode !== 'visible';
  for (const t of all) {
    if (!t.title.startsWith('raw_')) continue;
    formatRequests.push({
      updateSheetProperties: {
        properties: { sheetId: t.sheetId, hidden: hideRaw },
        fields: 'hidden',
      },
    });
  }
  // Delete any deprecated tab we used to own — keeps client spreadsheets clean
  // when we retire a duplicate (e.g. "Vista per Mercato " was identical to
  // "Weekly Performance Partenership").
  for (const t of all) {
    if (DEPRECATED_TABS.has(t.title)) {
      formatRequests.push({ deleteSheet: { sheetId: t.sheetId } });
    }
  }
  if (formatRequests.length > 0) {
    await api(spreadsheetId, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: formatRequests }),
    });
  }

  // Exclude deprecated tabs — they were deleted in the formatRequests batch
  // above, so their sheetId is no longer valid.
  const surviving = all.filter((t) => !DEPRECATED_TABS.has(t.title));
  await autoResizeAll(spreadsheetId, effective, surviving);

  return effective.map((p) => ({ tab: p.tab, rows: p.rows.length }));
}

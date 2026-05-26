/**
 * Pipeline — the end-to-end refresh: extract GA4 + Kibana, transform, write.
 *
 * The dataset is small (hundreds of GA4 rows, ~thousands of Kibana docs), so
 * every run rebuilds the full history. No incremental merge, no stale state.
 *
 * Writes to one or two spreadsheets per run:
 *   - SPREADSHEET_ID         (always) — internal copy, with RAW_TABS_MODE
 *   - CLIENT_SPREADSHEET_ID  (optional) — client copy, raw tabs forced off
 */

import { extractGa4, extractGa4MarketTotals, extractGa4DestinationTotals } from './ga4.js';
import { extractKibana } from './kibana.js';
import { fetchAllPages } from './wordpress.js';
import { DESTINATION_ORDER } from './destinations.js';
import { buildTabs, type TabPayload } from './transform.js';
import {
  writeAllTabs,
  readExistingCrmClicks,
  updateSummaryKpis,
  type WriteSummary,
} from './sheets.js';
import {
  HISTORY_START_DATE,
  SPREADSHEET_ID,
  CLIENT_SPREADSHEET_ID,
  RAW_TABS_MODE,
  WP_BASE_URL,
  assertKibanaConfigured,
  type RawTabsMode,
} from './config.js';
import { weekKey, type IsoWeek } from './isoWeek.js';

export interface RefreshOptions {
  /** Inclusive YYYY-MM-DD. Defaults to the report start (week 52/2025). */
  startDate?: string;
  /** Inclusive YYYY-MM-DD. Defaults to today (UTC). */
  endDate?: string;
}

export interface SpreadsheetWriteResult {
  spreadsheetId: string;
  rawMode: RawTabsMode;
  tabs: WriteSummary[];
}

export interface RefreshResult {
  startDate: string;
  endDate: string;
  ga4DetailRows: number;
  ga4MarketRows: number;
  ga4DestinationRows: number;
  kibanaRows: number;
  warnings: string[];
  spreadsheets: SpreadsheetWriteResult[];
  durationMs: number;
}

/**
 * Spreadsheet "Report Period" label, e.g. "Week 52/2025 — Week 22/2026".
 * Boundaries are the first and last ISO week that actually appear in the data,
 * so the label tracks the live extraction range rather than a static default.
 */
function computeReportPeriod(weeks: IsoWeek[]): string {
  if (weeks.length === 0) return '—';
  let min = weeks[0]!;
  let max = weeks[0]!;
  for (const w of weeks) {
    if (weekKey(w) < weekKey(min)) min = w;
    if (weekKey(w) > weekKey(max)) max = w;
  }
  return `Week ${min.isoWeek}/${min.isoYear} — Week ${max.isoWeek}/${max.isoYear}`;
}

/** Write the prepared payloads + KPIs to a single spreadsheet. */
async function writeToSpreadsheet(args: {
  spreadsheetId: string;
  rawMode: RawTabsMode;
  payloadsFactory: (crm: Map<string, number>) => TabPayload[];
  generatedAt: Date;
  reportPeriod: string;
  activeMarkets: number;
  totalAudioPlays: number;
  totalDestinations: number;
  destinationsByLanguage?: Record<string, number>;
}): Promise<SpreadsheetWriteResult> {
  const crmClicks = await readExistingCrmClicks(args.spreadsheetId, 'Weekly Performance Partenership');
  const payloads = args.payloadsFactory(crmClicks);
  const tabs = await writeAllTabs(args.spreadsheetId, payloads, args.rawMode);
  await updateSummaryKpis({
    spreadsheetId: args.spreadsheetId,
    generatedAt: args.generatedAt,
    reportPeriod: args.reportPeriod,
    activeMarkets: args.activeMarkets,
    totalAudioPlays: args.totalAudioPlays,
    totalDestinations: args.totalDestinations,
    destinationsByLanguage: args.destinationsByLanguage,
  });
  return { spreadsheetId: args.spreadsheetId, rawMode: args.rawMode, tabs };
}

export async function runRefresh(opts: RefreshOptions = {}): Promise<RefreshResult> {
  assertKibanaConfigured();
  const started = Date.now();
  const startDate = opts.startDate ?? HISTORY_START_DATE;
  const endDate = opts.endDate ?? new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];

  // Extract once, write many — same data feeds every spreadsheet target.
  const ga4Detail = await extractGa4(startDate, endDate, warnings);
  const ga4Market = await extractGa4MarketTotals(startDate, endDate);
  const ga4Destination = await extractGa4DestinationTotals(startDate, endDate, warnings);
  const kibana = await extractKibana(startDate, endDate, warnings);

  // Live destination counts per language from the WP /pages endpoint — drives
  // Language Availability (B13..B17). A WP outage shouldn't fail the refresh,
  // so we degrade gracefully: warn, leave the existing manual values in place.
  let destinationsByLanguage: Record<string, number> | undefined;
  try {
    const wp = await fetchAllPages(WP_BASE_URL);
    destinationsByLanguage = wp.byLanguage;
    if (wp.unresolved.length > 0) {
      warnings.push(
        `WP: ${wp.unresolved.length} page(s) excluded from Language Availability (slugs to fix on Elementor)`,
      );
    }
  } catch (err) {
    warnings.push(`WP /pages fetch failed (Language Availability not refreshed): ${String(err)}`);
  }

  const generatedAt = new Date();
  const activeMarkets = new Set(
    ga4Market.filter((r) => r.sessions > 0).map((r) => r.market),
  ).size;
  const totalAudioPlays = kibana.reduce((s, r) => s + r.plays, 0);
  // KEY METRICS "Destinations" universe — driven by the destination registry
  // so adding a slug to SLUG_TO_NAME keeps A8 (and therefore % Coverage) in sync.
  const totalDestinations = DESTINATION_ORDER.length;
  const reportPeriod = computeReportPeriod([
    ...ga4Market.map((r) => ({ isoYear: r.isoYear, isoWeek: r.isoWeek })),
    ...kibana.map((r) => ({ isoYear: r.isoYear, isoWeek: r.isoWeek })),
  ]);

  const payloadsFactory = (crm: Map<string, number>): TabPayload[] =>
    buildTabs({
      ga4Detail,
      ga4Market,
      ga4Destination,
      kibana,
      crmClicks: crm,
      generatedAt,
      warnings,
    });

  // Targets: always the internal sheet; optionally the client sheet (raw off).
  const targets: Array<{ spreadsheetId: string; rawMode: RawTabsMode }> = [
    { spreadsheetId: SPREADSHEET_ID, rawMode: RAW_TABS_MODE },
  ];
  if (CLIENT_SPREADSHEET_ID && CLIENT_SPREADSHEET_ID !== SPREADSHEET_ID) {
    targets.push({ spreadsheetId: CLIENT_SPREADSHEET_ID, rawMode: 'off' });
  }

  const spreadsheets: SpreadsheetWriteResult[] = [];
  for (const t of targets) {
    spreadsheets.push(
      await writeToSpreadsheet({
        spreadsheetId: t.spreadsheetId,
        rawMode: t.rawMode,
        payloadsFactory,
        generatedAt,
        reportPeriod,
        activeMarkets,
        totalAudioPlays,
        totalDestinations,
        destinationsByLanguage,
      }),
    );
  }

  return {
    startDate,
    endDate,
    ga4DetailRows: ga4Detail.length,
    ga4MarketRows: ga4Market.length,
    ga4DestinationRows: ga4Destination.length,
    kibanaRows: kibana.length,
    warnings,
    spreadsheets,
    durationMs: Date.now() - started,
  };
}

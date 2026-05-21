/**
 * Pipeline — the end-to-end refresh: extract GA4 + Kibana, transform, write.
 *
 * The dataset is small (hundreds of GA4 rows, ~thousands of Kibana docs), so
 * every run rebuilds the full history. No incremental merge, no stale state.
 */

import { extractGa4, extractGa4MarketTotals, extractGa4DestinationTotals } from './ga4.js';
import { extractKibana } from './kibana.js';
import { buildTabs } from './transform.js';
import {
  writeAllTabs,
  readExistingCrmClicks,
  updateSummaryKpis,
  type WriteSummary,
} from './sheets.js';
import { HISTORY_START_DATE, assertKibanaConfigured } from './config.js';

export interface RefreshOptions {
  /** Inclusive YYYY-MM-DD. Defaults to the report start (week 52/2025). */
  startDate?: string;
  /** Inclusive YYYY-MM-DD. Defaults to today (UTC). */
  endDate?: string;
}

export interface RefreshResult {
  startDate: string;
  endDate: string;
  ga4DetailRows: number;
  ga4MarketRows: number;
  ga4DestinationRows: number;
  kibanaRows: number;
  warnings: string[];
  tabs: WriteSummary[];
  durationMs: number;
}

export async function runRefresh(opts: RefreshOptions = {}): Promise<RefreshResult> {
  assertKibanaConfigured();
  const started = Date.now();
  const startDate = opts.startDate ?? HISTORY_START_DATE;
  const endDate = opts.endDate ?? new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];

  const ga4Detail = await extractGa4(startDate, endDate, warnings);
  const ga4Market = await extractGa4MarketTotals(startDate, endDate);
  const ga4Destination = await extractGa4DestinationTotals(startDate, endDate, warnings);
  const kibana = await extractKibana(startDate, endDate, warnings);

  // Preserve manually entered CRM Clicks across the row reorder.
  const crmClicks = await readExistingCrmClicks('Weekly Performance Partenership');

  const payloads = buildTabs({
    ga4Detail,
    ga4Market,
    ga4Destination,
    kibana,
    crmClicks,
    generatedAt: new Date(),
    warnings,
  });

  const tabs = await writeAllTabs(payloads);

  const activeMarkets = new Set(ga4Market.filter((r) => r.sessions > 0).map((r) => r.market)).size;
  const totalAudioPlays = kibana.reduce((s, r) => s + r.plays, 0);
  await updateSummaryKpis({ generatedAt: new Date(), activeMarkets, totalAudioPlays });

  return {
    startDate,
    endDate,
    ga4DetailRows: ga4Detail.length,
    ga4MarketRows: ga4Market.length,
    ga4DestinationRows: ga4Destination.length,
    kibanaRows: kibana.length,
    warnings,
    tabs,
    durationMs: Date.now() - started,
  };
}

/**
 * Transform — turns extracted facts into spreadsheet tab payloads.
 *
 * Output is two layers:
 *  - raw_* tabs: flat machine data, the audit source of truth (script-owned).
 *  - presentation tabs: the report layout, re-rendered from the same facts.
 *
 * The "CRM Email Metrics" tab is never produced here — it stays manual.
 */

import { MARKET_ORDER, type Market } from './markets.js';
import { DESTINATION_ORDER } from './destinations.js';
import type { Ga4Row, Ga4MarketRow, Ga4DestinationRow, KibanaRow } from './types.js';

export interface TabPayload {
  /** Sheet tab name. */
  tab: string;
  /** true => a raw_* tab the script fully owns (created/cleared as needed). */
  raw: boolean;
  /** Header row. */
  header: string[];
  /** Data rows. */
  rows: (string | number)[][];
}

export interface TransformInput {
  ga4Detail: Ga4Row[];
  ga4Market: Ga4MarketRow[];
  ga4Destination: Ga4DestinationRow[];
  kibana: KibanaRow[];
  /** (market|year|week) -> CRM "Clicked", read from the manual CRM Email Metrics tab. */
  crmClicks: Map<string, number>;
  generatedAt: Date;
  warnings: string[];
}

const LANG_BY_MARKET: Record<Market, string> = {
  UK: 'EN',
  DE: 'DE',
  IT: 'IT',
  FR: 'FR',
  ES: 'ES',
};
/** Language column order used by "Detail by Language". */
const LANGUAGE_ORDER = ['EN', 'IT', 'FR', 'ES', 'DE'];

const marketRank = (m: Market): number => MARKET_ORDER.indexOf(m);
const wk = (y: number, w: number): string => `${y}-${String(w).padStart(2, '0')}`;
export const crmKey = (market: string, year: number, week: number): string =>
  `${market}|${year}|${week}`;

/** "widget_italia_carousel" -> "Widget Italia Carousel". */
function widgetLabel(sourceType: string): string {
  return sourceType
    .split('_')
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ');
}

// --------------------------------------------------------------------------
// raw tabs
// --------------------------------------------------------------------------

function rawGa4DestWeek(rows: Ga4Row[]): TabPayload {
  const sorted = [...rows].sort(
    (a, b) =>
      marketRank(a.market) - marketRank(b.market) ||
      a.destination.localeCompare(b.destination) ||
      a.isoYear - b.isoYear ||
      a.isoWeek - b.isoWeek ||
      a.device.localeCompare(b.device),
  );
  return {
    tab: 'raw_ga4_destweek',
    raw: true,
    header: ['Market', 'Destination', 'Year', 'Week', 'Device', 'Sessions', 'Users', 'New Users'],
    rows: sorted.map((r) => [
      r.market, r.destination, r.isoYear, r.isoWeek, r.device, r.sessions, r.users, r.newUsers,
    ]),
  };
}

function rawGa4Market(rows: Ga4MarketRow[]): TabPayload {
  const sorted = [...rows].sort(
    (a, b) =>
      marketRank(a.market) - marketRank(b.market) || a.isoYear - b.isoYear || a.isoWeek - b.isoWeek,
  );
  return {
    tab: 'raw_ga4_market',
    raw: true,
    header: ['Market', 'Year', 'Week', 'Sessions', 'Users', 'New Users'],
    rows: sorted.map((r) => [r.market, r.isoYear, r.isoWeek, r.sessions, r.users, r.newUsers]),
  };
}

function rawGa4Destination(rows: Ga4DestinationRow[]): TabPayload {
  const sorted = [...rows].sort(
    (a, b) =>
      marketRank(a.market) - marketRank(b.market) || a.destination.localeCompare(b.destination),
  );
  return {
    tab: 'raw_ga4_destination',
    raw: true,
    header: ['Market', 'Destination', 'Sessions', 'Users', 'New Users'],
    rows: sorted.map((r) => [r.market, r.destination, r.sessions, r.users, r.newUsers]),
  };
}

function rawKibana(rows: KibanaRow[]): TabPayload {
  const sorted = [...rows].sort(
    (a, b) =>
      marketRank(a.market) - marketRank(b.market) ||
      (a.destination ?? '').localeCompare(b.destination ?? '') ||
      a.isoYear - b.isoYear ||
      a.isoWeek - b.isoWeek ||
      a.widget.localeCompare(b.widget),
  );
  return {
    tab: 'raw_kibana',
    raw: true,
    header: ['Market', 'Destination', 'Year', 'Week', 'Widget', 'Plays'],
    rows: sorted.map((r) => [
      r.market, r.destination ?? '', r.isoYear, r.isoWeek, r.widget, r.plays,
    ]),
  };
}

function rawMeta(input: TransformInput): TabPayload {
  const totalPlays = input.kibana.reduce((s, r) => s + r.plays, 0);
  const rows: (string | number)[][] = [
    ['last_run_utc', input.generatedAt.toISOString()],
    ['ga4_detail_rows', input.ga4Detail.length],
    ['ga4_market_rows', input.ga4Market.length],
    ['ga4_destination_rows', input.ga4Destination.length],
    ['kibana_rows', input.kibana.length],
    ['kibana_total_plays', totalPlays],
    ['warning_count', input.warnings.length],
    ...input.warnings.map((w, i) => [`warning_${i + 1}`, w] as (string | number)[]),
  ];
  return { tab: 'raw_meta', raw: true, header: ['Field', 'Value'], rows };
}

// --------------------------------------------------------------------------
// presentation tabs
// --------------------------------------------------------------------------

/** Sum a numeric metric grouped by an arbitrary string key. */
function sumBy<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
  return m;
}

/** "Widget Performance" — market × week, one column per widget type. */
function widgetPerformance(kibana: KibanaRow[]): TabPayload {
  const widgetTotals = sumBy(kibana, (r) => r.widget, (r) => r.plays);
  const widgets = [...widgetTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  // group: market|week -> widget -> plays
  const grid = new Map<string, Map<string, number>>();
  for (const r of kibana) {
    const k = `${r.market}|${r.isoYear}|${r.isoWeek}`;
    let row = grid.get(k);
    if (!row) grid.set(k, (row = new Map()));
    row.set(r.widget, (row.get(r.widget) ?? 0) + r.plays);
  }

  const keys = [...grid.keys()].sort((a, b) => {
    const [ma, ya, wa] = a.split('|');
    const [mb, yb, wb] = b.split('|');
    return (
      marketRank(ma as Market) - marketRank(mb as Market) ||
      Number(ya) - Number(yb) ||
      Number(wa) - Number(wb)
    );
  });

  const rows = keys.map((k) => {
    const [m, y, w] = k.split('|');
    const row = grid.get(k)!;
    const total = [...row.values()].reduce((s, v) => s + v, 0);
    return [
      m!, wk(Number(y), Number(w)), total, ...widgets.map((wd) => row.get(wd) ?? 0),
    ] as (string | number)[];
  });

  return {
    tab: 'Widget Performance',
    raw: false,
    header: ['Market', 'Week', 'Total Audio', ...widgets.map(widgetLabel)],
    rows,
  };
}

/** "Destination × Week" — GA4 detail joined with Kibana audio. */
function destinationWeek(ga4: Ga4Row[], kibana: KibanaRow[]): TabPayload {
  // GA4 detail aggregated to market|destination|week.
  type Cell = { sessions: number; users: number; newUsers: number; desktop: number; mobile: number };
  const grid = new Map<string, Cell>();
  for (const r of ga4) {
    const k = `${r.market}|${r.destination}|${r.isoYear}|${r.isoWeek}`;
    let c = grid.get(k);
    if (!c) grid.set(k, (c = { sessions: 0, users: 0, newUsers: 0, desktop: 0, mobile: 0 }));
    c.sessions += r.sessions;
    c.users += r.users;
    c.newUsers += r.newUsers;
    if (r.device === 'desktop') c.desktop += r.sessions;
    else if (r.device === 'mobile') c.mobile += r.sessions;
  }
  // Kibana audio per market|destination|week (only plays with a destination).
  const audio = sumBy(
    kibana.filter((r) => r.destination),
    (r) => `${r.market}|${r.destination}|${r.isoYear}|${r.isoWeek}`,
    (r) => r.plays,
  );

  const keys = [...new Set([...grid.keys(), ...audio.keys()])].sort((a, b) => {
    const pa = a.split('|');
    const pb = b.split('|');
    return (
      marketRank(pa[0] as Market) - marketRank(pb[0] as Market) ||
      pa[1]!.localeCompare(pb[1]!) ||
      Number(pa[2]) - Number(pb[2]) ||
      Number(pa[3]) - Number(pb[3])
    );
  });

  const rows = keys.map((k) => {
    const [m, dest, y, w] = k.split('|');
    const c = grid.get(k);
    return [
      m!, dest!, Number(w),
      c?.sessions ?? 0, c?.users ?? 0, c?.newUsers ?? 0,
      c?.desktop ?? 0, c?.mobile ?? 0,
      audio.get(k) ?? 0,
    ] as (string | number)[];
  });

  return {
    tab: 'Destination × Week',
    raw: false,
    header: [
      'Market', 'Destination', 'Week', 'Sessions', 'Users', 'New Users', 'Desktop', 'Mobile',
      'Audio Played',
    ],
    rows,
  };
}

/** "Weekly Performance Partenership" / "Vista per Mercato" — identical layout. */
function weeklyPerformance(
  tab: string,
  ga4Market: Ga4MarketRow[],
  kibana: KibanaRow[],
  crmClicks: Map<string, number>,
): TabPayload {
  const audio = sumBy(kibana, (r) => `${r.market}|${r.isoYear}|${r.isoWeek}`, (r) => r.plays);
  const keys = new Set<string>();
  for (const r of ga4Market) keys.add(`${r.market}|${r.isoYear}|${r.isoWeek}`);
  for (const k of audio.keys()) keys.add(k);

  const ga4Idx = new Map(ga4Market.map((r) => [`${r.market}|${r.isoYear}|${r.isoWeek}`, r]));
  const ordered = [...keys].sort((a, b) => {
    const pa = a.split('|');
    const pb = b.split('|');
    return (
      marketRank(pa[0] as Market) - marketRank(pb[0] as Market) ||
      Number(pa[1]) - Number(pb[1]) ||
      Number(pa[2]) - Number(pb[2])
    );
  });

  const rows = ordered.map((k) => {
    const [m, y, w] = k.split('|');
    const g = ga4Idx.get(k);
    const crm = crmClicks.get(crmKey(m!, Number(y), Number(w)));
    return [
      m!, Number(y), Number(w),
      crm ?? '',
      g?.sessions ?? 0, g?.users ?? 0, g?.newUsers ?? 0,
      audio.get(k) ?? 0,
    ] as (string | number)[];
  });

  return {
    tab,
    raw: false,
    header: ['Market', 'Year', 'Week', 'CRM Clicks', 'Sessions', 'Users', 'New Users', 'Audio Played'],
    rows,
  };
}

/** "Detail by Language" — destination × language totals over the whole period. */
function detailByLanguage(
  ga4Dest: Ga4DestinationRow[],
  kibana: KibanaRow[],
): TabPayload {
  const ga4Idx = new Map(ga4Dest.map((r) => [`${r.destination}|${LANG_BY_MARKET[r.market]}`, r]));
  const audio = sumBy(
    kibana.filter((r) => r.destination),
    (r) => `${r.destination}|${LANG_BY_MARKET[r.market]}`,
    (r) => r.plays,
  );

  const rows: (string | number)[][] = [];
  for (const dest of DESTINATION_ORDER) {
    for (const lang of LANGUAGE_ORDER) {
      const g = ga4Idx.get(`${dest}|${lang}`);
      const a = audio.get(`${dest}|${lang}`) ?? 0;
      rows.push([
        dest, lang,
        g?.users ?? '', g?.newUsers ?? '', g?.sessions ?? '',
        a || '',
      ]);
    }
  }
  return {
    tab: 'Detail by Language',
    raw: false,
    header: ['Destination', 'Language', 'Total Users', 'New Users', 'Total Sessions', 'Total Audio Played'],
    rows,
  };
}

/** Build every tab payload (raw + presentation). */
export function buildTabs(input: TransformInput): TabPayload[] {
  return [
    rawGa4DestWeek(input.ga4Detail),
    rawGa4Market(input.ga4Market),
    rawGa4Destination(input.ga4Destination),
    rawKibana(input.kibana),
    rawMeta(input),
    widgetPerformance(input.kibana),
    destinationWeek(input.ga4Detail, input.kibana),
    weeklyPerformance('Weekly Performance Partenership', input.ga4Market, input.kibana, input.crmClicks),
    weeklyPerformance('Vista per Mercato ', input.ga4Market, input.kibana, input.crmClicks),
    detailByLanguage(input.ga4Destination, input.kibana),
  ];
}

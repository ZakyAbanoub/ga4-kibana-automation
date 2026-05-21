/**
 * GA4 extractor — Sessions / Users / New Users per destination, week and device.
 *
 * GA4 holds no audio event, so audio is NOT read here (see kibana.ts).
 * Destination + language are parsed out of `landingPage` (/{lang}/{destination}/).
 */

import { accessToken } from './google.js';
import { GA4_PROPERTY_ID } from './config.js';
import { destinationFromSlug } from './destinations.js';
import { marketFromLang, MARKET_ORDER, type Market } from './markets.js';
import type { Ga4Row, Ga4MarketRow, Ga4DestinationRow } from './types.js';

/** ISO 639-1 language for a market — the GA4 landingPage 1st path segment. */
const MARKET_LANG: Record<Market, string> = {
  UK: 'en',
  DE: 'de',
  IT: 'it',
  FR: 'fr',
  ES: 'es',
};

const API = 'https://analyticsdata.googleapis.com/v1beta';
const PAGE_SIZE = 100_000;

/** Matches /{lang}/{destination} with optional trailing slash, lang in our set. */
const PATH_RE = /^\/(en|it|fr|es|de)\/([^/]+)\/?$/i;

interface RunReportResponse {
  rows?: Array<{
    dimensionValues: Array<{ value: string }>;
    metricValues: Array<{ value: string }>;
  }>;
  rowCount?: number;
}

function normDevice(d: string): Ga4Row['device'] {
  const v = d.toLowerCase();
  if (v === 'desktop' || v === 'mobile' || v === 'tablet') return v;
  return 'other';
}

/**
 * Pull GA4 facts for the given date range.
 * @param startDate inclusive, YYYY-MM-DD
 * @param endDate inclusive, YYYY-MM-DD
 */
export async function extractGa4(
  startDate: string,
  endDate: string,
  warnings: string[],
): Promise<Ga4Row[]> {
  const token = await accessToken();
  const rows: Ga4Row[] = [];
  const unknownSlugs = new Set<string>();
  let offset = 0;

  for (;;) {
    const body = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'landingPage' },
        { name: 'isoYear' },
        { name: 'isoWeek' },
        { name: 'deviceCategory' },
      ],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'newUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'landingPage',
          stringFilter: {
            matchType: 'FULL_REGEXP',
            value: '^/(en|it|fr|es|de)/[^/]+/?$',
            caseSensitive: false,
          },
        },
      },
      limit: PAGE_SIZE,
      offset,
    };

    const res = await fetch(`${API}/properties/${GA4_PROPERTY_ID}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GA4 runReport failed ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as RunReportResponse;
    const batch = data.rows ?? [];

    for (const r of batch) {
      const [landingPage, isoYear, isoWeek, device] = r.dimensionValues.map((d) => d.value);
      const m = PATH_RE.exec(landingPage ?? '');
      if (!m) continue;
      const market = marketFromLang(m[1]!);
      const destination = destinationFromSlug(m[2]!);
      if (!market) continue;
      if (!destination) {
        unknownSlugs.add(m[2]!);
        continue;
      }
      rows.push({
        market,
        destination,
        isoYear: Number(isoYear),
        isoWeek: Number(isoWeek),
        device: normDevice(device ?? ''),
        sessions: Number(r.metricValues[0]?.value ?? 0),
        users: Number(r.metricValues[1]?.value ?? 0),
        newUsers: Number(r.metricValues[2]?.value ?? 0),
      });
    }

    offset += batch.length;
    const total = data.rowCount ?? offset;
    if (batch.length === 0 || offset >= total) break;
  }

  if (unknownSlugs.size > 0) {
    warnings.push(
      `GA4: ${unknownSlugs.size} unknown destination slug(s) skipped: ${[...unknownSlugs].join(', ')}`,
    );
  }
  // Several slugs can resolve to one destination (e.g. "amsterdam" + the
  // misspelled "amesterdam"); collapse them so each key appears once.
  return aggregateDetail(rows);
}

function aggregateDetail(rows: Ga4Row[]): Ga4Row[] {
  const m = new Map<string, Ga4Row>();
  for (const r of rows) {
    const k = `${r.market}|${r.destination}|${r.isoYear}|${r.isoWeek}|${r.device}`;
    const e = m.get(k);
    if (e) {
      e.sessions += r.sessions;
      e.users += r.users;
      e.newUsers += r.newUsers;
    } else {
      m.set(k, { ...r });
    }
  }
  return [...m.values()];
}

/**
 * Market-level totals with GA4's own de-duplication.
 *
 * `totalUsers` is not additive across destinations: a visitor landing on two
 * destinations in one week is one market user but two destination users.
 * To get the correct market figure we query GA4 once per market without the
 * destination dimension, so GA4 de-duplicates users for us.
 */
export async function extractGa4MarketTotals(
  startDate: string,
  endDate: string,
): Promise<Ga4MarketRow[]> {
  const token = await accessToken();
  const rows: Ga4MarketRow[] = [];

  for (const market of MARKET_ORDER) {
    const lang = MARKET_LANG[market];
    const body = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'isoYear' }, { name: 'isoWeek' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'newUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'landingPage',
          stringFilter: {
            matchType: 'FULL_REGEXP',
            value: `^/${lang}/[^/]+/?$`,
            caseSensitive: false,
          },
        },
      },
      limit: PAGE_SIZE,
    };
    const res = await fetch(`${API}/properties/${GA4_PROPERTY_ID}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GA4 market runReport failed ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as RunReportResponse;
    for (const r of data.rows ?? []) {
      rows.push({
        market,
        isoYear: Number(r.dimensionValues[0]?.value ?? 0),
        isoWeek: Number(r.dimensionValues[1]?.value ?? 0),
        sessions: Number(r.metricValues[0]?.value ?? 0),
        users: Number(r.metricValues[1]?.value ?? 0),
        newUsers: Number(r.metricValues[2]?.value ?? 0),
      });
    }
  }
  return rows;
}

/**
 * Per-destination totals over the whole period, with GA4 de-duplication of users.
 * One query per market (no week dimension) so GA4 de-duplicates each destination's
 * users across the entire range. Feeds the "Detail by Language" tab.
 */
export async function extractGa4DestinationTotals(
  startDate: string,
  endDate: string,
  warnings: string[],
): Promise<Ga4DestinationRow[]> {
  const token = await accessToken();
  const rows: Ga4DestinationRow[] = [];
  const unknownSlugs = new Set<string>();

  for (const market of MARKET_ORDER) {
    const lang = MARKET_LANG[market];
    const body = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'newUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'landingPage',
          stringFilter: {
            matchType: 'FULL_REGEXP',
            value: `^/${lang}/[^/]+/?$`,
            caseSensitive: false,
          },
        },
      },
      limit: PAGE_SIZE,
    };
    const res = await fetch(`${API}/properties/${GA4_PROPERTY_ID}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GA4 destination runReport failed ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as RunReportResponse;
    for (const r of data.rows ?? []) {
      const m = PATH_RE.exec(r.dimensionValues[0]?.value ?? '');
      if (!m) continue;
      const destination = destinationFromSlug(m[2]!);
      if (!destination) {
        unknownSlugs.add(m[2]!);
        continue;
      }
      rows.push({
        market,
        destination,
        sessions: Number(r.metricValues[0]?.value ?? 0),
        users: Number(r.metricValues[1]?.value ?? 0),
        newUsers: Number(r.metricValues[2]?.value ?? 0),
      });
    }
  }
  if (unknownSlugs.size > 0) {
    warnings.push(`GA4 (destinations): unknown slug(s) skipped: ${[...unknownSlugs].join(', ')}`);
  }
  // Collapse multiple slugs mapping to the same destination.
  const agg = new Map<string, Ga4DestinationRow>();
  for (const r of rows) {
    const k = `${r.market}|${r.destination}`;
    const e = agg.get(k);
    if (e) {
      e.sessions += r.sessions;
      e.users += r.users;
      e.newUsers += r.newUsers;
    } else {
      agg.set(k, { ...r });
    }
  }
  return [...agg.values()];
}

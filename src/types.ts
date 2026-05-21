/** Shared row shapes produced by the extractors and consumed by transforms. */

import type { Market } from './markets.js';

/** One GA4 fact: a destination page, a week, a device split. */
export interface Ga4Row {
  market: Market;
  destination: string;
  isoYear: number;
  isoWeek: number;
  device: 'desktop' | 'mobile' | 'tablet' | 'other';
  sessions: number;
  users: number;
  newUsers: number;
}

/** One Kibana `plays` fact: a play attributed to market/week/widget. */
export interface KibanaRow {
  market: Market;
  /** Canonical destination from context_ref; null when context_ref absent/unknown. */
  destination: string | null;
  isoYear: number;
  isoWeek: number;
  /** Raw Kibana source_type, e.g. "widget_button", "widget_italia_carousel". */
  widget: string;
  /** Number of plays in this bucket. */
  plays: number;
}

/**
 * Market-level GA4 fact. `users` here is GA4's de-duplicated `totalUsers` for
 * the whole market — NOT the sum of per-destination users (a visitor landing on
 * two destinations in one week is one user for the market, two in the detail).
 */
export interface Ga4MarketRow {
  market: Market;
  isoYear: number;
  isoWeek: number;
  sessions: number;
  users: number;
  newUsers: number;
}

/**
 * Per-destination GA4 totals over the whole report period.
 * `users` is GA4-deduplicated for the destination (a visitor seen in two
 * different weeks is one destination user, not two) — used by "Detail by Language".
 */
export interface Ga4DestinationRow {
  market: Market;
  destination: string;
  sessions: number;
  users: number;
  newUsers: number;
}

export interface ExtractResult {
  ga4: Ga4Row[];
  kibana: KibanaRow[];
  /** Diagnostics surfaced to logs / the spreadsheet status cell. */
  warnings: string[];
}

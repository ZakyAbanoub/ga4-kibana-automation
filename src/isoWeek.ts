/**
 * ISO-8601 week helpers. The report keys every row on (isoYear, isoWeek);
 * GA4 returns these directly, Kibana rows are timestamps that must be converted.
 *
 * ISO rule: week 1 is the week containing the year's first Thursday;
 * weeks start Monday. A date's isoYear can differ from its calendar year
 * around Jan 1 / Dec 31 (e.g. 2025-12-29 is week 1 of isoYear 2026).
 */

export interface IsoWeek {
  isoYear: number;
  isoWeek: number;
}

/** ISO week + ISO week-year for a Date (computed in UTC). */
export function toIsoWeek(date: Date): IsoWeek {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of the current ISO week.
  const day = d.getUTCDay() || 7; // Sunday 0 -> 7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}

/** ISO week for a Kibana epoch-millis timestamp. */
export function isoWeekFromEpochMs(ms: number): IsoWeek {
  return toIsoWeek(new Date(ms));
}

/** Monday (UTC, 00:00) that starts the given ISO week. */
export function isoWeekStart({ isoYear, isoWeek }: IsoWeek): Date {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  return monday;
}

/** Sortable key, e.g. {2026, 7} -> 202607. */
export function weekKey({ isoYear, isoWeek }: IsoWeek): number {
  return isoYear * 100 + isoWeek;
}

const IT_MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

function fmtItDate(d: Date): string {
  return `${d.getUTCDate()} ${IT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Italian week label matching the existing spreadsheet, e.g.
 * "Settimana 07, 2026 ( 9 febbraio 2026 - 15 febbraio 2026 )".
 */
export function weekLabel(w: IsoWeek): string {
  const start = isoWeekStart(w);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const ww = String(w.isoWeek).padStart(2, '0');
  return `Settimana ${ww}, ${w.isoYear} ( ${fmtItDate(start)} - ${fmtItDate(end)} )`;
}

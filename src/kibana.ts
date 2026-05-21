/**
 * Kibana / OpenSearch extractor — audio plays from the `plays` index.
 *
 * "Audio Played" everywhere in the report = a count of `plays` documents.
 * Lastminute plays are those whose `source_ref` contains "lastminute".
 *   market      <- language        (en_US -> UK, it_IT -> IT, ...)
 *   widget      <- source_type     (widget_button, widget_italia_carousel, ...)
 *   destination <- context_ref     (absent on most docs -> destination = null)
 *   week        <- timestamp       (ISO week, Monday-aligned)
 *
 * One composite aggregation buckets every (week, language, widget, context_ref)
 * combination; doc_count is the play count.
 */

import {
  KIBANA_BASE_URL,
  KIBANA_INDEX,
  KIBANA_USER,
  KIBANA_PASS,
  KIBANA_SOURCE_REF_MATCH,
} from './config.js';
import { toIsoWeek } from './isoWeek.js';
import { marketFromLocale } from './markets.js';
import { destinationFromContextRef } from './destinations.js';
import type { KibanaRow } from './types.js';

const PAGE_SIZE = 1000;

/**
 * GA4's property timezone is Europe/Rome, so its `isoWeek` is Rome-aligned.
 * Kibana week buckets must use the same zone or boundary plays land in the
 * wrong week. The date_histogram is formatted to the Rome week's Monday date.
 */
const REPORT_TZ = 'Europe/Rome';

interface CompositeBucket {
  // `week` is a yyyy-MM-dd string: the Monday of the Rome-aligned ISO week.
  key: { week: string; lang: string | null; widget: string | null; ctx: string | null };
  doc_count: number;
}
interface SearchResponse {
  aggregations?: { grp: { buckets: CompositeBucket[]; after_key?: CompositeBucket['key'] } };
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${KIBANA_USER}:${KIBANA_PASS}`).toString('base64');
}

/**
 * Pull Kibana play facts for the given date range.
 * @param startDate inclusive, YYYY-MM-DD
 * @param endDate inclusive, YYYY-MM-DD (end of day)
 */
export async function extractKibana(
  startDate: string,
  endDate: string,
  warnings: string[],
): Promise<KibanaRow[]> {
  const rows: KibanaRow[] = [];
  const unknownContext = new Set<string>();
  const unknownLang = new Set<string>();
  let after: CompositeBucket['key'] | undefined;

  // `timestamp` is mapped as epoch_millis, so the range must be given in ms.
  const gteMs = Date.parse(`${startDate}T00:00:00Z`);
  const lteMs = Date.parse(`${endDate}T23:59:59.999Z`);

  for (;;) {
    const body: Record<string, unknown> = {
      size: 0,
      query: {
        bool: {
          must: [
            { range: { timestamp: { gte: gteMs, lte: lteMs, format: 'epoch_millis' } } },
            { wildcard: { source_ref: `*${KIBANA_SOURCE_REF_MATCH}*` } },
          ],
        },
      },
      aggs: {
        grp: {
          composite: {
            size: PAGE_SIZE,
            ...(after ? { after } : {}),
            sources: [
              {
                week: {
                  date_histogram: {
                    field: 'timestamp',
                    calendar_interval: 'week',
                    time_zone: REPORT_TZ,
                    format: 'yyyy-MM-dd',
                  },
                },
              },
              { lang: { terms: { field: 'language.keyword', missing_bucket: true } } },
              { widget: { terms: { field: 'source_type.keyword', missing_bucket: true } } },
              { ctx: { terms: { field: 'context_ref.keyword', missing_bucket: true } } },
            ],
          },
        },
      },
    };

    const res = await fetch(`${KIBANA_BASE_URL}/${KIBANA_INDEX}/_search`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Kibana _search failed ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as SearchResponse;
    const agg = data.aggregations?.grp;
    if (!agg) throw new Error('Kibana response missing aggregations');

    for (const b of agg.buckets) {
      const market = b.key.lang ? marketFromLocale(b.key.lang) : null;
      if (!market) {
        if (b.key.lang) unknownLang.add(b.key.lang);
        continue;
      }
      const week = toIsoWeek(new Date(`${b.key.week}T00:00:00Z`));
      let destination: string | null = null;
      if (b.key.ctx) {
        destination = destinationFromContextRef(b.key.ctx);
        if (!destination) unknownContext.add(b.key.ctx);
      }
      rows.push({
        market,
        destination,
        isoYear: week.isoYear,
        isoWeek: week.isoWeek,
        widget: b.key.widget ?? 'unknown',
        plays: b.doc_count,
      });
    }

    if (!agg.after_key || agg.buckets.length === 0) break;
    after = agg.after_key;
  }

  if (unknownLang.size > 0) {
    warnings.push(`Kibana: plays in untracked language(s) skipped: ${[...unknownLang].join(', ')}`);
  }
  if (unknownContext.size > 0) {
    warnings.push(
      `Kibana: ${unknownContext.size} unmapped context_ref value(s): ${[...unknownContext].slice(0, 15).join(', ')}`,
    );
  }
  return rows;
}

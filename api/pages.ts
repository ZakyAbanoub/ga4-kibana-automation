/**
 * Vercel Function — GET /api/pages
 *
 * Returns the canonical list of landing pages from the Lastminute site:
 *   - filtered to URLs of shape /{lang}/{destination}/
 *   - language resolved via the WP `parent` (Elementor convention) with URL fallback
 *   - destination resolved via the WP `slug` (Elementor convention) with URL fallback
 *   - deduplicated by (language, destination), most recently modified wins
 *
 * Query params (optional):
 *   ?language=<en|it|fr|es|de>          restrict to one language
 *   ?destination=<canonical-or-slug>    restrict to one destination
 *                                       (case-insensitive; accepts "Rome",
 *                                       "rome", "majorca" → Mallorca, etc.)
 *   Both can be combined; invalid values → 400.
 *
 * Optional auth: if PAGES_API_TOKEN is set, the request must include
 * `Authorization: Bearer <PAGES_API_TOKEN>`. Returns publish status only
 * (default WP unauthenticated behaviour).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchAllPages, LANG_CODES, type WpPage } from '../src/wordpress.js';
import { destinationFromSlug, slugForDestination } from '../src/destinations.js';
import { PAGES_API_TOKEN, WP_BASE_URL } from '../src/config.js';

export const config = { maxDuration: 60 };

/** Pick the first string value from a query field (Vercel returns string | string[]). */
function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (PAGES_API_TOKEN && req.headers.authorization !== `Bearer ${PAGES_API_TOKEN}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  // Validate filter query params before any expensive fetch.
  const langRaw = firstString(req.query.language)?.trim().toLowerCase();
  const destRaw = firstString(req.query.destination)?.trim();

  let language: string | undefined;
  if (langRaw !== undefined && langRaw !== '') {
    if (!LANG_CODES.has(langRaw)) {
      res.status(400).json({
        ok: false,
        error: `invalid 'language' (must be one of: ${[...LANG_CODES].join(', ')})`,
      });
      return;
    }
    language = langRaw;
  }

  let destination: string | undefined;
  if (destRaw !== undefined && destRaw !== '') {
    const resolved = destinationFromSlug(destRaw);
    if (!resolved) {
      res.status(400).json({
        ok: false,
        error: `unknown 'destination': ${destRaw}`,
      });
      return;
    }
    // The public `destination` field on pages is in WP slug form (see
    // wordpress.ts), so the filter comparison must use the slug too.
    destination = slugForDestination(resolved);
  }

  try {
    const started = Date.now();
    const { pages, unresolved, byLanguage, totalRaw } = await fetchAllPages(WP_BASE_URL);

    // Apply filters in memory — dataset is small (≤ ~120 pages).
    let filtered: WpPage[] = pages;
    if (language) filtered = filtered.filter((p) => p.language === language);
    if (destination) filtered = filtered.filter((p) => p.destination === destination);

    // Recompute byLanguage on the filtered set so the count reflects the response.
    const filteredByLanguage: Record<string, number> = {};
    for (const p of filtered) {
      filteredByLanguage[p.language] = (filteredByLanguage[p.language] ?? 0) + 1;
    }

    const filterApplied = Boolean(language || destination);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      total: filtered.length,
      byLanguage: filterApplied ? filteredByLanguage : byLanguage,
      filter: filterApplied ? { language, destination } : null,
      pages: filtered,
      unresolved,
      meta: {
        totalRawFromWp: totalRaw,
        totalBeforeFilter: pages.length,
        excludedByFilter: totalRaw - pages.length - unresolved.length,
        unresolvedCount: unresolved.length,
      },
    });
  } catch (err) {
    console.error('pages endpoint failed', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}

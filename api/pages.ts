/**
 * Vercel Function — GET /api/pages
 *
 * Returns the canonical list of landing pages from the Lastminute site:
 *   - filtered to URLs of shape /{lang}/{destination}/
 *   - language resolved via the WP `parent` (Elementor convention) with URL fallback
 *   - destination resolved via the WP `slug` (Elementor convention) with URL fallback
 *   - deduplicated by (language, destination), most recently modified wins
 *
 * Optional auth: if PAGES_API_TOKEN is set, the request must include
 * `Authorization: Bearer <PAGES_API_TOKEN>`. Returns publish status only
 * (default WP unauthenticated behaviour).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchAllPages } from '../src/wordpress.js';
import { PAGES_API_TOKEN, WP_BASE_URL } from '../src/config.js';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (PAGES_API_TOKEN && req.headers.authorization !== `Bearer ${PAGES_API_TOKEN}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const started = Date.now();
    const { pages, unresolved, byLanguage, totalRaw } = await fetchAllPages(WP_BASE_URL);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      total: pages.length,
      byLanguage,
      pages,
      unresolved,
      meta: {
        totalRawFromWp: totalRaw,
        excludedByFilter: totalRaw - pages.length - unresolved.length,
        unresolvedCount: unresolved.length,
      },
    });
  } catch (err) {
    console.error('pages endpoint failed', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}

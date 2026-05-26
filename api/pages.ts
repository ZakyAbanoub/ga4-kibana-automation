/**
 * Vercel Function — GET /api/pages
 *
 * Returns every WordPress page from the Lastminute site in a single response,
 * paginated server-side past the WP API's 100-per-page cap. Each page is
 * slim-payload (no `content`) and enriched with `language` and `destination`
 * derived from its URL.
 *
 * Optional auth: if PAGES_API_TOKEN is set, the request must include
 * `Authorization: Bearer <PAGES_API_TOKEN>`.
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
    const pages = await fetchAllPages(WP_BASE_URL);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.status(200).json({
      ok: true,
      total: pages.length,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      pages,
    });
  } catch (err) {
    console.error('pages endpoint failed', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}

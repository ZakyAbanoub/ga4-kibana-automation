/**
 * Vercel Function — full spreadsheet refresh.
 *
 * Triggered by the cron in vercel.json, or manually with the CRON_SECRET:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/refresh
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runRefresh } from '../src/pipeline.js';

export const config = { maxDuration: 120 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const result = await runRefresh();
    console.log('refresh ok', JSON.stringify(result));
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('refresh failed', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}

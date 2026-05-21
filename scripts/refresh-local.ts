/**
 * Local full refresh — runs the real pipeline (extract + transform + write to
 * the spreadsheet). Same code path the Vercel cron uses.
 *
 *   npm run refresh
 */

import { runRefresh } from '../src/pipeline.js';

const result = await runRefresh();

console.log(`Refresh ${result.startDate} -> ${result.endDate}  (${result.durationMs} ms)`);
console.log(
  `  GA4: ${result.ga4DetailRows} detail / ${result.ga4MarketRows} market / ${result.ga4DestinationRows} destination`,
);
console.log(`  Kibana: ${result.kibanaRows} rows`);
console.log('  Tabs written:');
for (const t of result.tabs) console.log(`    ${t.tab.padEnd(32)} ${t.rows} rows`);
if (result.warnings.length) {
  console.log('  Warnings:');
  for (const w of result.warnings) console.log(`    - ${w}`);
}

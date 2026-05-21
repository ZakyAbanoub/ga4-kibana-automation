/**
 * Local extraction harness — runs the GA4 + Kibana extractors over the full
 * report history and prints aggregates so output can be eyeballed against
 * reference-data.xlsx. Writes raw rows to .out/extract.json.
 *
 *   npm run extract
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { extractGa4, extractGa4MarketTotals } from '../src/ga4.js';
import { extractKibana } from '../src/kibana.js';
import { HISTORY_START_DATE, assertKibanaConfigured } from '../src/config.js';
import { weekKey } from '../src/isoWeek.js';
import type { Ga4Row, KibanaRow } from '../src/types.js';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ga4ByMarketWeek(rows: Ga4Row[]): Map<string, { s: number; u: number; n: number }> {
  const m = new Map<string, { s: number; u: number; n: number }>();
  for (const r of rows) {
    const k = `${r.market} ${r.isoYear}w${String(r.isoWeek).padStart(2, '0')}`;
    const e = m.get(k) ?? { s: 0, u: 0, n: 0 };
    e.s += r.sessions;
    e.u += r.users;
    e.n += r.newUsers;
    m.set(k, e);
  }
  return m;
}

function kibanaByMarketWeek(rows: KibanaRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.market} ${r.isoYear}w${String(r.isoWeek).padStart(2, '0')}`;
    m.set(k, (m.get(k) ?? 0) + r.plays);
  }
  return m;
}

async function main(): Promise<void> {
  assertKibanaConfigured();
  const end = today();
  const warnings: string[] = [];

  console.log(`Extracting GA4 ${HISTORY_START_DATE} -> ${end} ...`);
  const ga4 = await extractGa4(HISTORY_START_DATE, end, warnings);
  const ga4Markets = await extractGa4MarketTotals(HISTORY_START_DATE, end);
  console.log(`  GA4 detail rows: ${ga4.length}  market rows: ${ga4Markets.length}`);

  console.log(`Extracting Kibana ${HISTORY_START_DATE} -> ${end} ...`);
  const kibana = await extractKibana(HISTORY_START_DATE, end, warnings);
  console.log(`  Kibana rows: ${kibana.length}`);

  // Market totals: GA4-deduplicated query (not the per-destination sum).
  const ga4Agg = new Map<string, { s: number; u: number; n: number }>();
  for (const r of ga4Markets) {
    ga4Agg.set(`${r.market} ${r.isoYear}w${String(r.isoWeek).padStart(2, '0')}`, {
      s: r.sessions,
      u: r.users,
      n: r.newUsers,
    });
  }
  void ga4ByMarketWeek; // kept for per-destination checks
  const kibAgg = kibanaByMarketWeek(kibana);
  const keys = [...new Set([...ga4Agg.keys(), ...kibAgg.keys()])].sort((a, b) => {
    const pa = a.split(' '); const pb = b.split(' ');
    if (pa[0] !== pb[0]) return pa[0]!.localeCompare(pb[0]!);
    return weekKey(parseWk(pa[1]!)) - weekKey(parseWk(pb[1]!));
  });

  console.log('\nMarket  Week        Sessions  Users  New   Audio');
  for (const k of keys) {
    const g = ga4Agg.get(k) ?? { s: 0, u: 0, n: 0 };
    const a = kibAgg.get(k) ?? 0;
    const [mkt, wk] = k.split(' ');
    console.log(
      `${mkt!.padEnd(7)} ${wk!.padEnd(11)} ${String(g.s).padStart(8)} ${String(g.u).padStart(6)} ${String(g.n).padStart(5)} ${String(a).padStart(6)}`,
    );
  }

  const playsNoDest = kibana.filter((r) => r.destination === null).reduce((s, r) => s + r.plays, 0);
  const playsTotal = kibana.reduce((s, r) => s + r.plays, 0);
  console.log(
    `\nKibana plays total: ${playsTotal}  |  without destination (context_ref): ${playsNoDest} (${((playsNoDest / playsTotal) * 100).toFixed(1)}%)`,
  );

  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  mkdirSync('.out', { recursive: true });
  writeFileSync(
    '.out/extract.json',
    JSON.stringify({ ga4, ga4Markets, kibana, warnings }, null, 2),
  );
  console.log('\nWrote .out/extract.json');
}

function parseWk(s: string): { isoYear: number; isoWeek: number } {
  const [y, w] = s.split('w');
  return { isoYear: Number(y), isoWeek: Number(w) };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

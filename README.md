# Loquis × Lastminute — Spreadsheet Automation

Automatic nightly refresh of the Loquis × Lastminute performance spreadsheet.
Pulls GA4 + Kibana data, writes it into the Google Sheet. CRM / client-entered
data is never touched.

> **Deploying / handing this over?** See **[`DEPLOYMENT.md`](./DEPLOYMENT.md)** —
> recommended stack is **Vercel** (the project is two Vercel functions + a cron;
> no DB, no AWS rebuild). It covers env vars, the Google service-account / Sheet
> sharing, the cron secret, and a smoke test.

## What it does

Every night a Vercel Cron calls `/api/refresh`, which:

1. **GA4** — Sessions / Users (`activeUsers`) / New Users per destination, week
   and device, parsed from the `landingPage` (`/{lang}/{destination}/`).
2. **Kibana** (`plays` index) — audio plays per market, week, widget and
   destination (`context_ref`).
3. Rebuilds the spreadsheet tabs from scratch (full history every run — the
   dataset is small, so there is no incremental-merge state to corrupt).

### Tabs written

| Tab | Source | Notes |
|---|---|---|
| `raw_ga4_destweek` | GA4 | flat audit data — market/destination/week/device |
| `raw_ga4_market` | GA4 | flat — de-duplicated market totals |
| `raw_ga4_destination` | GA4 | flat — de-duplicated per-destination totals |
| `raw_kibana` | Kibana | flat — plays per market/destination/week/widget |
| `raw_meta` | — | last run timestamp, row counts, warnings |
| `Widget Performance` | Kibana | market × week, one column per widget type |
| `Destination × Week` | GA4 + Kibana | GA4 detail joined with audio |
| `Weekly Performance Partenership` | GA4 + Kibana | `CRM Clicks` column preserved as-is |
| `Vista per Mercato ` | GA4 + Kibana | same layout (duplicate of the above) |
| `Detail by Language` | GA4 + Kibana | destination × language totals |
| `Summary Dashboard` | — | only Generated / Active Markets / Total Audio Plays |

**Never touched:** `CRM Email Metrics` (manual client data). The `CRM Clicks`
column in the weekly tabs is read back and re-placed so manual values survive.

## Local use

Requires Node ≥ 20. Reference data for validation lives in `reference-data.xlsx`
(git-ignored — not public).

```sh
npm install
cp .env.example .env        # fill in secrets
npm run extract             # extract only, prints aggregates, writes .out/extract.json
npm run refresh             # full pipeline: extract + write to the Sheet
npm run typecheck
```

`.env` needs the Google service-account key (`secrets/ga4-service-account.json`)
and the Kibana credentials. See `.env.example`.

## Deploy (Vercel)

1. `vercel link` then push the repo.
2. Set env vars in the Vercel project:
   - `GA4_PROPERTY_ID`, `SPREADSHEET_ID`
   - `GOOGLE_CREDENTIALS_JSON` — the full service-account JSON as one string
   - `KIBANA_BASE_URL`, `KIBANA_INDEX`, `KIBANA_USER`, `KIBANA_PASS_B64`
   - `CRON_SECRET` — any random string; the cron and manual calls must send it
3. `vercel.json` schedules `/api/refresh` daily at 23:00 UTC (≈ midnight Rome).

Manual run:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/refresh
```

## Key facts (see DISCOVERY.md for the full analysis)

- GA4 has **no audio event** — audio comes entirely from Kibana.
- GA4 metric for "Users" is **`activeUsers`**, dimension is **`landingPage`**
  (not `pagePath`). Validated: Sessions / Users / New Users match the client
  reference exactly for all 12 checked weeks.
- GA4 property timezone is **Europe/Rome**; Kibana weeks are computed in the
  same zone so boundary plays land in the correct week.
- Kibana audio matches the reference exactly from week 09/2026 onward; earlier
  weeks differ because of the pre-"Carousel bug fix" corrections in the
  reference file.

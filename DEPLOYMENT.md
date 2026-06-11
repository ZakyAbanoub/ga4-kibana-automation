# Deployment & Handoff — Loquis × Lastminute Automation

`ga4-kibana-automation` — a small Vercel project that, every night, pulls GA4 +
Kibana data and rebuilds the Google Sheet. **No database.** Written for a fresh
operator taking it over.

---

## 0. Recommended stack — and why (not AWS)

| Layer        | Tool                                                       |
| ------------ | ---------------------------------------------------------- |
| Compute      | **Vercel Functions** (`api/refresh.ts`, `api/pages.ts`)    |
| Scheduler    | **Vercel Cron** (`vercel.json` → `/api/refresh` nightly)   |
| Data store   | **Google Sheets** (Sheets API) — no DB                     |
| Inputs       | GA4 Data API · Kibana (`plays` index) · WordPress (`/api/pages`) |

**The code is two Vercel serverless functions + one Vercel cron — keep it on
Vercel.** It has no server, no DB, no container. Re-hosting on AWS would mean a
Lambda + EventBridge rebuild for zero benefit. **Recommendation: Vercel.**

---

## 1. Prerequisites

- **Node ≥ 20** (for local runs), npm.
- A **Vercel account** in the **Loquis team**; Vercel CLI optional (`npm i -g vercel`).
- The **handoff secrets file** (`handoff/automation.env`, sent via Slack/mail —
  never committed): GA4 + Google service-account JSON, Kibana credentials,
  WordPress token, cron secret.
- A **Google service account** with:
  - **Viewer** on the GA4 property (`GA4_PROPERTY_ID`), and
  - **Editor** on the target Google Sheet (`SPREADSHEET_ID`).
  The existing service account (in the handoff file) already has these — keep
  using it, or create a new one and re-grant (see §4).

---

## 2. What it does (recap)

Every night a **Vercel Cron** calls `/api/refresh`, which pulls GA4 + Kibana and
rebuilds the Sheet tabs from scratch (full history each run). The manual
client-entered tab `CRM Email Metrics` and the `CRM Clicks` column are never
overwritten. `/api/pages` is an on-demand WordPress→landing-pages helper (bearer
token optional). Full tab list is in `README.md`.

---

## 3. Deploy on Vercel

1. In the **Loquis Vercel team**: **Add New → Project → Import** the repo from
   Bitbucket. No framework preset is required (it's plain Vercel functions);
   Node 20+.
2. **Environment Variables** (Settings → Environment Variables, *Production*) —
   copy from `handoff/automation.env`:

   | Key | Notes |
   | --- | --- |
   | `GA4_PROPERTY_ID` | numeric property id (e.g. `482794016`) |
   | `SPREADSHEET_ID` | the Google Sheet that receives the tabs |
   | `CLIENT_SPREADSHEET_ID` | *(optional)* second sheet, presentation-only |
   | `RAW_TABS` | `hidden` (default) \| `visible` \| `off` |
   | `GOOGLE_CREDENTIALS_JSON` | the **full** service-account JSON as one line |
   | `KIBANA_BASE_URL` | `https://stats.loquis.com` |
   | `KIBANA_INDEX` | `plays` |
   | `KIBANA_USER`, `KIBANA_PASS_B64` | Kibana credentials |
   | `WP_BASE_URL` | *(optional)* WordPress base for `/api/pages` |
   | `PAGES_API_TOKEN` | *(optional)* bearer gating `/api/pages` |
   | `CRON_SECRET` | shared secret for the cron + manual `/api/refresh` calls |

   > On Vercel use **`GOOGLE_CREDENTIALS_JSON`** (the JSON contents), **not**
   > `GOOGLE_APPLICATION_CREDENTIALS` (a local file path used only for `npm run`
   > locally).

3. **Deploy** (push to the production branch, or `vercel --prod`).
4. **Cron**: `vercel.json` already declares the nightly job
   (`{ "path": "/api/refresh", "schedule": "0 23 * * *" }`). Vercel runs it
   automatically once deployed. When `CRON_SECRET` is set, Vercel Cron sends it
   as the `Authorization` header, and the function authorizes the run; manual
   calls must send the same secret.

---

## 4. Google service account & Sheet access (the easy thing to forget)

The sync can only write if the service account can reach the Sheet and GA4:

1. Find the service-account **email** inside the JSON (`client_email`, looks like
   `something@project.iam.gserviceaccount.com`).
2. **Google Sheet** (`SPREADSHEET_ID`): open it → **Share** → add that email as
   **Editor**.
3. **GA4** (`GA4_PROPERTY_ID`): Admin → Property Access Management → add that
   email as **Viewer**.
4. **Kibana**: the `KIBANA_USER` / `KIBANA_PASS_B64` must be valid for
   `stats.loquis.com`.

(If you keep the existing service account from the handoff file, all of the above
is already granted — nothing to do.)

---

## 5. Smoke test

```sh
# manual refresh (replace <SECRET> with CRON_SECRET; <APP> with the Vercel URL)
curl -X POST "https://<APP>.vercel.app/api/refresh" \
  -H "Authorization: Bearer <SECRET>"
```

Then open the Google Sheet → the tabs (`raw_*`, `Weekly Performance Partenership`,
`Summary Dashboard`, …) should show a fresh `raw_meta` timestamp and updated
numbers. `CRM Email Metrics` / `CRM Clicks` must be unchanged.

---

## 6. Local use (optional, for debugging)

```sh
npm install
cp .env.example .env        # fill from the handoff bundle
#   local uses GOOGLE_APPLICATION_CREDENTIALS=secrets/ga4-service-account.json
npm run extract             # extract only → .out/extract.json (no write)
npm run refresh             # full pipeline + write to the Sheet
npm run typecheck
```

`reference-data.xlsx` (git-ignored) is only for local parity validation — not
needed in production.
---

## 7. Moving this repo to Bitbucket (one-time)

A full mirror keeps **all branches, tags and history**. From an up-to-date local
clone (replace `<BITBUCKET_URL>`, e.g. `git@bitbucket.org:<workspace>/<repo>.git`):

```sh
# 1. point a new remote at Bitbucket and push everything
git remote add bitbucket <BITBUCKET_URL>
git push bitbucket --mirror        # all branches + tags, exact

# 2. (optional) make Bitbucket the default 'origin' for future work
git remote remove origin
git remote rename bitbucket origin
git push -u origin main
```

Then in Bitbucket: connect the repo to the Loquis **Vercel** project so pushes
auto-deploy. (No CI in this repo — nothing else to port.)

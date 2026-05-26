# Multi-Client Roadmap

Reference document for evolving this project from single-client (Lastminute)
to multi-client (Lastminute + Moovit + …). Capture of the design decisions
agreed in the original conversation so a future onboarding can follow them.

> Current state: single-client. The plan below has **not been implemented**
> yet — we agreed to wait for a second real client before refactoring, to
> avoid over-engineering. When that moment arrives, follow this document.

---

## 1. Today vs target

### Already parameterised (zero refactor needed)

Set via env vars on each Vercel project, independent per client:

- `GA4_PROPERTY_ID`
- `SPREADSHEET_ID` (internal copy — with raw_* tabs)
- `CLIENT_SPREADSHEET_ID` (optional client-facing copy — raw forced off)
- `WP_BASE_URL`
- `KIBANA_BASE_URL`, `KIBANA_INDEX`, `KIBANA_USER`, `KIBANA_PASS_B64`
- `RAW_TABS` (hidden | visible | off)
- `PAGES_API_TOKEN`, `CRON_SECRET`, `VERCEL_TOKEN`

### Currently hardcoded to Lastminute

| Concern | Location | Why client-specific |
|---|---|---|
| Destination registry (33 slugs) | `src/destinations.ts` `SLUG_TO_NAME` | Each client has own destinations |
| Localised aliases (parigi/londra/rom/…) | `src/destinations.ts` `ALIASES` | Depends on which languages client serves |
| Market list `UK/DE/IT/FR/ES` | `src/markets.ts` `MARKET_ORDER` + `LANG_TO_MARKET` | A client may serve US/IL/IN |
| Kibana source filter `'lastminute'` | `src/config.ts` `KIBANA_SOURCE_REF_MATCH` | Each client = different `source_ref` |
| Italian tab names (`Vista per Mercato`, `CRM Email Metrics`) | `src/transform.ts`, `src/sheets.ts` | Likely keep, or move to profile if templates differ |
| Brand strings "Lastminute"/"Loquis" | README, code comments | Cosmetic |

---

## 2. Target architecture — one repo, N Vercel projects

**Single GitHub repo.** **N Vercel projects** (one per client), each linked
to the same repo. One `git push origin main` triggers parallel auto-deploys
on every project via the GitHub webhook.

```
GitHub repo (one)
   └── push to main
        ├──► Vercel: lastminute-automation
        │      env: CLIENT_PROFILE=lastminute, GA4_PROPERTY_ID, SPREADSHEET_ID, …
        │      cron: /api/refresh
        ├──► Vercel: moovit-automation
        │      env: CLIENT_PROFILE=moovit, …
        │      cron: /api/refresh
        └──► Vercel: <future-client>-automation
               env: CLIENT_PROFILE=<future>, …
```

### Why this shape

- Bug fix or feature → 1 PR → 1 push → all clients get it automatically.
- Each client has isolated Vercel project (own cron, own env, own billing).
- Adding a client = new config file + new Vercel project, no code fork.
- Rollback is per-client (Vercel "Promote to production" with an older
  deployment) or repo-wide (`git revert` + push).

### Vercel concretely

`vercel.com/zakyabanoubs-projects → New Project → Import same repo →
Project name: <client>-automation → set env vars → Deploy`. Vercel supports
multiple projects pointing at the same Git repo natively.

---

## 3. Code refactor when the time comes

### `ClientProfile` interface (single source of truth)

```ts
export interface ClientProfile {
  id: string;                              // 'lastminute'
  brand: { name: string };                 // 'Lastminute'
  source: {
    kibanaSourceRefMatch: string;          // 'lastminute'
    wpBaseUrl: string;                     // env may override
  };
  markets: {
    order: string[];                       // ['UK','DE','IT','FR','ES']
    langToMarket: Record<string, string>;  // { en:'UK', it:'IT', ... }
  };
  destinations: {
    slugToName: Record<string, string>;
    aliases: Record<string, string>;
  };
  layout: {
    locale: 'it' | 'en';                   // tab labels, date format
  };
  // Optional escape hatch for clients with a different audio source, etc.
  adapters?: { audioSource?: 'kibana' | 'datadog' };
}
```

### File layout

```
config/clients/
  lastminute.ts          ← profile for Lastminute (extract from current hardcodes)
  moovit.ts              ← profile for Moovit (when needed)
src/clientProfile.ts     ← `loadProfile()` reads CLIENT_PROFILE env, returns ClientProfile
src/bootstrap.ts         ← `bootstrapSheet(spreadsheetId, profile)`
```

`src/destinations.ts`, `src/markets.ts`, `src/config.ts` stop hardcoding and
read from the active profile instead.

### Bootstrap

`bootstrapSheet(spreadsheetId, profile)` runs **once** against an empty
Google Sheet and builds the full layout in a single `batchUpdate`:

- Create all tabs (`Summary Dashboard`, `CRM Email Metrics`, `Weekly
  Performance Partenership`, `Vista per Mercato`, `Widget Performance`,
  `Destination × Week`, `Detail by Language`, plus `raw_*`).
- Apply header style (dark blue bg `#1d3b5c`, bold, Arial 11, white text).
- Build the Summary Dashboard scaffold (title row, "KEY METRICS" section,
  "LANGUAGE AVAILABILITY" section with formulas in C13:C17 and C8).
- Set default `Destinations` (A8) to `profile.destinations.slugToName` size.
- Hide raw tabs if `RAW_TABS=hidden`.

Idempotent: re-running on a sheet that already has the layout is a no-op.

Exposed as `npm run bootstrap` (local) and/or `POST /api/bootstrap` (gated
by `CRON_SECRET`) so it can run once after a new project is created.

---

## 4. Onboarding a new client — step-by-step

1. **Create `config/clients/<id>.ts`** from the Lastminute template. Fill
   in destinations, markets, language-to-market, brand name, locale,
   `kibanaSourceRefMatch`. Commit.
2. **Create a new Google Sheet** (empty) and share with the service account
   `loquis-licensing-dashboard@loquis-192809.iam.gserviceaccount.com` as
   Editor (or the client's own service account if different).
3. **Create a new Vercel project** in the same team (`zakyabanoubs-projects`):
   - Import same repo `ga4-kibana-automation`.
   - Project name: `<id>-automation`.
   - Env vars: `CLIENT_PROFILE=<id>`, `GA4_PROPERTY_ID`, `SPREADSHEET_ID`,
     Kibana credentials, `CRON_SECRET`, `RAW_TABS=hidden`, etc.
4. **Run bootstrap once** against the empty sheet:
   ```sh
   CLIENT_PROFILE=<id> SPREADSHEET_ID=<sheet> npm run bootstrap
   ```
   or `curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/bootstrap`.
5. **Trigger first refresh** manually:
   ```sh
   curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/refresh
   ```
6. The daily cron (`0 23 * * *`) from `vercel.json` takes over from then on.

---

## 5. Refactor effort estimate

About **3–4 hours** of focused work when triggered, split as:

- Extract `ClientProfile` interface + Lastminute profile from current hardcodes (~1h).
- Wire `destinations`, `markets`, `config` to read from profile (~30m).
- Write `bootstrap.ts` (single batchUpdate with all layout requests) (~1.5h).
- Local test with two profiles, verify outputs match (~30m).
- Update README + `.env.example` with `CLIENT_PROFILE` (~15m).

Until then: keep the rule "**don't introduce new Lastminute-specific
hardcodes**" — every new constant goes either to env or to the place where
the future profile lives.

---

## 6. Edge cases captured

- **Client with different audio source** (not Kibana): add
  `audioSource: 'datadog'` to `profile.adapters` and switch in
  `extractAudio()`.
- **Client without CRM tab**: the `crmClicks` join is a no-op when the tab
  is absent (already handled in `readExistingCrmClicks` with a try/catch).
- **Client uses different week granularity** (e.g. monthly): would need a
  larger refactor. Out of scope until requested.
- **Client outside Europe/Rome timezone**: add `reportTimezone` to profile
  and pass to Kibana date_histogram + Sheets date formatting.

---

## 7. Status checklist

- [ ] Extract `ClientProfile` interface.
- [ ] Move Lastminute hardcodes into `config/clients/lastminute.ts`.
- [ ] Wire `destinations`, `markets`, `config` to active profile.
- [ ] Implement `bootstrap.ts` (idempotent layout builder).
- [ ] Expose `POST /api/bootstrap` (auth via `CRON_SECRET`).
- [ ] Validate by creating a fake second profile and writing to a throwaway sheet.
- [ ] Document `CLIENT_PROFILE` in README + `.env.example`.
- [ ] Onboard the first real second client end-to-end.

Trigger this checklist when the second client arrives.

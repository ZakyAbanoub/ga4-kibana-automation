# Loquis × Lastminute — Landing Pages API

> ⚠️ **Temporary API.** This endpoint is a stopgap built on top of the
> spreadsheet-automation project to unblock the frontend. It will be
> superseded by the official APIs once those are finished. Treat the URL,
> token and response shape as provisional — when the official APIs ship,
> the frontend will need to switch over. Backend team will give advance
> notice and run both in parallel during the cut-over window.

HTTP API for the Lastminute landing pages, consumed by the Lastminute frontend.

**Base URL:** `https://ga4-kibana-automation.vercel.app`

> All responses are JSON. All timestamps are ISO-8601 UTC. All identifiers
> are case-sensitive in the response (lowercase slugs) and case-insensitive
> in query parameters.

## Authentication

The `/api/pages` endpoint is gated by a bearer token. The frontend must send:

```
Authorization: Bearer <PAGES_API_TOKEN>
```

Without the header (or with the wrong token), the server replies
`401 { ok: false, error: "unauthorized" }`.

The token is shared with the frontend team out-of-band (Slack DM /
1Password). It is never committed to the repo or returned by any
endpoint. Production always has it set.

Token rotation: ask the backend team to regenerate. No code change
needed.

---

## `GET /api/pages`

Returns the canonical list of Lastminute landing pages from WordPress,
filtered to URLs of shape `/{lang}/{destination}/`, deduplicated by
`(language, destination)`, and enriched with the destination identifier.

### Query parameters (all optional)

| Param | Type | Example | Effect |
|---|---|---|---|
| `language` | enum `en \| it \| fr \| es \| de` | `?language=en` | Restrict to one language |
| `destination` | string (slug or display name) | `?destination=rome`, `?destination=Gran%20Canaria`, `?destination=majorca` | Restrict to one destination. Accepts the WP slug (`grancanaria`), the display name (`Gran Canaria`), or a known alias (`majorca` → Mallorca). Case-insensitive. |

Both can be combined: `?language=en&destination=rome`.

Invalid values return `400`:

```jsonc
{ "ok": false, "error": "invalid 'language' (must be one of: en, it, fr, es, de)" }
{ "ok": false, "error": "unknown 'destination': nowhere" }
```

### Success response — `200 OK`

```jsonc
{
  "ok": true,
  "fetchedAt": "2026-05-28T08:55:21.234Z",
  "durationMs": 1820,

  "total": 119,                       // count of `pages` returned
  "byLanguage": { "de": 33, "en": 33, "es": 10, "fr": 10, "it": 33 },

  "filter": null,                     // or { "language": "en", "destination": "rome" } when filtered

  "pages": [
    {
      "id": 3362,                     // WordPress post ID
      "slug": "agadir",               // raw WP slug (may be noisy)
      "title": "Agadir – lastminute.com – Ihr kostenloser Audioguide",
      "link": "https://lastminute.loquis.com/de/agadir",
      "status": "publish",
      "language": "de",               // en | it | fr | es | de
      "destination": "agadir",        // URL slug — use this for filtering / linking
      "destinationName": "Agadir"     // human-friendly label — use this in UI
    }
    // ... 118 more
  ],

  "unresolved": [
    // Pages that didn't satisfy /{lang}/{destination} — diagnostics for the
    // ops team. Frontend can usually ignore this array.
    {
      "id": 400,
      "slug": "home-lastminute-com-your-free-guide",
      "link": "https://lastminute.loquis.com/",
      "title": "lastminute.com — Your free guide",
      "reason": "no-destination"
    }
  ],

  "meta": {
    "totalRawFromWp": 128,            // pages WordPress returned, before filtering
    "totalBeforeFilter": 119,         // resolved pages before any query filter
    "excludedByFilter": 5,            // skipped by our filter (lang root pages etc.)
    "unresolvedCount": 2
  }
}
```

### Field reference

| Field | Meaning |
|---|---|
| `pages[].id` | Stable WP post ID. Safe to use as a React key. |
| `pages[].slug` | WP slug as stored — may be "dirty" (e.g. `amsterdam-lastminute-com-...`). **Do not** build URLs from this; use `link` or rebuild from `language` + `destination`. |
| `pages[].title` | Page title from WP. May contain HTML entities (`–`, `&#8211;`); decode in the frontend if rendering. |
| `pages[].link` | Canonical public URL. Always `https://lastminute.loquis.com/{language}/{destination}/`. |
| `pages[].status` | Always `publish` (WP returns published pages only). |
| `pages[].language` | Two-letter ISO code: `en`, `it`, `fr`, `es`, `de`. |
| `pages[].destination` | URL slug — the source of truth for identifiers. Matches the `?destination=` query. |
| `pages[].destinationName` | Display name. May contain spaces ("Gran Canaria", "New York", "Costa Blanca"). |
| `unresolved[].reason` | `no-language` \| `no-destination` \| `no-language-no-destination`. |

### Examples

#### Fetch all pages

```ts
const res = await fetch('https://ga4-kibana-automation.vercel.app/api/pages', {
  headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_PAGES_API_TOKEN}` },
});
const { pages } = await res.json();
```

#### Just the English pages

```ts
const res = await fetch(
  'https://ga4-kibana-automation.vercel.app/api/pages?language=en',
  { headers: { Authorization: `Bearer ${token}` } },
);
const { pages } = await res.json();
// pages is the 33 English landing pages
```

#### One page (e.g. Rome in Italian)

```ts
const url = new URL('https://ga4-kibana-automation.vercel.app/api/pages');
url.searchParams.set('language', 'it');
url.searchParams.set('destination', 'rome');
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const { pages } = await res.json();
const rome = pages[0]; // single result
```

#### React (SWR)

```tsx
import useSWR from 'swr';

const fetcher = (url: string) =>
  fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());

function DestinationsList({ language }: { language: string }) {
  const { data } = useSWR(`/api/pages?language=${language}`, fetcher);
  if (!data?.ok) return null;
  return (
    <ul>
      {data.pages.map((p) => (
        <li key={p.id}>
          <a href={p.link}>{p.destinationName}</a>
        </li>
      ))}
    </ul>
  );
}
```

### Caching

- Server sends `Cache-Control: public, max-age=60, s-maxage=300`.
- The CDN edge caches a copy for ~5 minutes; browser caches for 1 minute.
- Same query string = same cache entry. To bust: append a random query param
  (e.g. `?_=${Date.now()}`) or wait the TTL.

### Errors

| Status | Reason | Body shape |
|---|---|---|
| `400` | Invalid `language` or unknown `destination` | `{ "ok": false, "error": "..." }` |
| `401` | Missing/wrong `Authorization` header (when token enforced) | `{ "ok": false, "error": "unauthorized" }` |
| `500` | Upstream WordPress error or internal failure | `{ "ok": false, "error": "..." }` |

The frontend should treat anything other than `ok: true` as a hard error
and not assume `pages` is present.

---

## TypeScript types

Copy this block into the frontend codebase. Matches the live response shape
exactly — no inference needed.

```ts
/** Two-letter language code present in the URL: /{language}/{destination}/. */
export type LandingLanguage = 'en' | 'it' | 'fr' | 'es' | 'de';

/** A single landing page returned by GET /api/pages. */
export interface LandingPage {
  /** Stable WordPress post ID. Safe React key. */
  id: number;
  /** Raw WP slug — may be noisy; do not build URLs from this. */
  slug: string;
  /** Page title (may contain HTML entities). */
  title: string;
  /** Canonical public URL — always /{language}/{destination}/. */
  link: string;
  /** Always 'publish' (unauthenticated WP returns published only). */
  status: 'publish';
  language: LandingLanguage;
  /** WP URL slug — source of truth for identifiers. Use for filtering & linking. */
  destination: string;
  /** Display name — use for UI labels. */
  destinationName: string;
}

/** A page that did not satisfy /{lang}/{destination} — diagnostics only. */
export interface UnresolvedLandingPage {
  id: number;
  slug: string;
  link: string;
  title: string;
  reason: 'no-language' | 'no-destination' | 'no-language-no-destination';
}

/** Active filter echoed back in the response, or null when no filter. */
export interface LandingPagesFilter {
  language?: LandingLanguage;
  destination?: string;
}

/** Diagnostic counters about what was fetched / excluded / unresolved. */
export interface LandingPagesMeta {
  totalRawFromWp: number;
  totalBeforeFilter: number;
  excludedByFilter: number;
  unresolvedCount: number;
}

/** Successful response shape. */
export interface LandingPagesResponse {
  ok: true;
  fetchedAt: string;                    // ISO-8601 UTC
  durationMs: number;
  total: number;                        // = pages.length
  byLanguage: Partial<Record<LandingLanguage, number>>;
  filter: LandingPagesFilter | null;
  pages: LandingPage[];
  unresolved: UnresolvedLandingPage[];
  meta: LandingPagesMeta;
}

/** Error response shape (any 4xx / 5xx). */
export interface LandingPagesErrorResponse {
  ok: false;
  error: string;
}

export type LandingPagesApiResponse =
  | LandingPagesResponse
  | LandingPagesErrorResponse;

/** Query parameters accepted by GET /api/pages. */
export interface LandingPagesQuery {
  language?: LandingLanguage;
  /** Accepts WP slug, display name, or known alias. Case-insensitive. */
  destination?: string;
}
```

### Minimal typed client

```ts
const BASE = 'https://ga4-kibana-automation.vercel.app';

export async function fetchLandingPages(
  query: LandingPagesQuery = {},
  token: string,
): Promise<LandingPagesResponse> {
  const url = new URL(`${BASE}/api/pages`);
  if (query.language) url.searchParams.set('language', query.language);
  if (query.destination) url.searchParams.set('destination', query.destination);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as LandingPagesApiResponse;
  if (!data.ok) throw new Error(data.error);
  return data;
}
```

---

## Contact

Issues, missing destinations, or wrong values → **Loquis team**.

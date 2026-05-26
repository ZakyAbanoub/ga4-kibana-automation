/**
 * WordPress REST adapter — fetches every page from the Lastminute site.
 *
 * The /wp/v2/pages endpoint caps `per_page` at 100, so anything bigger has to
 * be paginated. Total page count comes from the `X-WP-TotalPages` response
 * header; we walk pages 1..N and concatenate. We also slim the payload to the
 * fields the client actually needs (no `content`) and derive `language` and
 * `destination` from each page's URL so the consumer doesn't have to parse it.
 */

import { destinationFromSlug } from './destinations.js';

const PER_PAGE = 100;
/**
 * Fields requested from the WP API. `content`/`excerpt` deliberately excluded
 * to keep the payload small. `_fields` accepts dotted paths for nested objects
 * (e.g. `title.rendered` -> `{ title: { rendered: "…" } }`).
 */
const WP_FIELDS = [
  'id',
  'slug',
  'title.rendered',
  'link',
  'parent',
  'status',
  'date',
  'modified',
  'menu_order',
  'template',
] as const;

/** One language code we recognise as part of the URL path. */
const LANG_CODES = new Set(['en', 'it', 'fr', 'es', 'de']);

export interface WpPage {
  id: number;
  slug: string;
  title: string;
  link: string;
  parent: number;
  status: string;
  date: string | null;
  modified: string | null;
  menuOrder: number;
  template: string;
  /** Two-letter language inferred from the URL path, or null if absent. */
  language: string | null;
  /** Canonical destination name resolved from the URL slug, or null. */
  destination: string | null;
}

interface RawWpPage {
  id: number;
  slug: string;
  title: { rendered: string };
  link: string;
  parent: number;
  status: string;
  date?: string;
  modified?: string;
  menu_order?: number;
  template?: string;
}

/**
 * Parse a Lastminute page URL like `https://lastminute.loquis.com/en/rome/`:
 *   - language  -> "en"   (first path segment if in our set, else null)
 *   - destination -> "Rome" (canonical name from SLUG_TO_NAME, else null)
 */
function parseLink(link: string): { language: string | null; destination: string | null } {
  let pathname = link;
  try {
    pathname = new URL(link).pathname;
  } catch {
    /* link may be a relative path; fall through */
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { language: null, destination: null };

  const first = segments[0]!.toLowerCase();
  if (LANG_CODES.has(first)) {
    const slug = segments[1] ?? '';
    return { language: first, destination: slug ? destinationFromSlug(slug) : null };
  }
  // No /lang/ prefix — could be the root or a top-level page; still try the
  // first segment as a slug in case the destination lives at the URL root.
  return { language: null, destination: destinationFromSlug(first) };
}

function normalise(raw: RawWpPage): WpPage {
  const { language, destination } = parseLink(raw.link);
  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title?.rendered ?? '',
    link: raw.link,
    parent: raw.parent ?? 0,
    status: raw.status,
    date: raw.date ?? null,
    modified: raw.modified ?? null,
    menuOrder: raw.menu_order ?? 0,
    template: raw.template ?? '',
    language,
    destination,
  };
}

/** Fetch every WordPress page, paginated, slim-payload, with derived fields. */
export async function fetchAllPages(baseUrl: string): Promise<WpPage[]> {
  const fieldsParam = encodeURIComponent(WP_FIELDS.join(','));
  const root = baseUrl.replace(/\/$/, '');
  const all: WpPage[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${root}/wp-json/wp/v2/pages?per_page=${PER_PAGE}&page=${page}&_fields=${fieldsParam}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`WP /pages page=${page} failed ${res.status}: ${await res.text()}`);
    }
    const headerTotal = res.headers.get('x-wp-totalpages');
    if (headerTotal) totalPages = Number(headerTotal) || 1;
    const batch = (await res.json()) as RawWpPage[];
    for (const r of batch) all.push(normalise(r));
    page++;
  } while (page <= totalPages);

  return all;
}

/**
 * WordPress REST adapter — fetches every page from the Lastminute site.
 *
 * The /wp/v2/pages endpoint caps `per_page` at 100, so anything bigger has to
 * be paginated. Total page count comes from the `X-WP-TotalPages` response
 * header; we walk pages 1..N and concatenate. We also slim the payload to the
 * fields the client actually needs (no `content`) and derive `language` and
 * `destination` from each page's metadata so the consumer doesn't have to.
 *
 * Resolution strategy (most reliable first):
 *   1. language    <- the slug of the WP `parent` page (Elementor convention:
 *                     the destination page is a child of /en, /it, /fr, /es, /de).
 *   2. language    <- 1st URL path segment, if `parent` doesn't resolve.
 *   3. destination <- destinationFromSlug(page.slug) — the slug you set in
 *                     Elementor is the source of truth.
 *   4. destination <- destinationFromSlug(2nd URL path segment), fallback when
 *                     the WP slug got auto-renamed to something noisy.
 *
 * Only pages with BOTH a resolved language and a resolved destination are
 * surfaced. Multiple pages for the same (lang, destination) are deduplicated
 * keeping the most-recently-modified one — typically the "real" landing page.
 */

import { destinationFromSlug } from './destinations.js';

const PER_PAGE = 100;
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
  language: string;
  destination: string;
}

export interface UnresolvedPage {
  id: number;
  slug: string;
  link: string;
  title: string;
  /** Why this page was excluded: missing/unknown language, destination, or both. */
  reason: 'no-language' | 'no-destination' | 'no-language-no-destination';
}

export interface PagesResult {
  /** Resolved + deduplicated pages (one per language × destination). */
  pages: WpPage[];
  /** Pages that did not satisfy the /{lang}/{destination} contract. */
  unresolved: UnresolvedPage[];
  /** Map of language code -> count of resolved pages, for quick sanity-check. */
  byLanguage: Record<string, number>;
  /** Raw page count returned by WordPress (before filtering). */
  totalRaw: number;
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

/** Parse a Lastminute URL into (language, destinationSlug) — URL fallback only. */
function parseLink(link: string): { language: string | null; slug: string | null } {
  let pathname = link;
  try {
    pathname = new URL(link).pathname;
  } catch {
    /* link may already be a relative path; fall through */
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { language: null, slug: null };
  const first = segments[0]!.toLowerCase();
  if (LANG_CODES.has(first)) return { language: first, slug: segments[1] ?? null };
  return { language: null, slug: first };
}

async function fetchRawPages(baseUrl: string): Promise<RawWpPage[]> {
  const fieldsParam = encodeURIComponent(WP_FIELDS.join(','));
  const root = baseUrl.replace(/\/$/, '');
  const all: RawWpPage[] = [];
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
    all.push(...batch);
    page++;
  } while (page <= totalPages);

  return all;
}

/**
 * Fetch + filter + deduplicate WordPress pages.
 * Only pages of shape /{lang}/{destination}/ with a known destination are kept;
 * duplicates collapse to the latest-modified entry.
 */
export async function fetchAllPages(baseUrl: string): Promise<PagesResult> {
  const raw = await fetchRawPages(baseUrl);

  // Map every parent page whose slug is a language code: parentId -> langCode.
  // Elementor convention: destination pages are children of /en, /it, /fr, ...
  const langByParentId = new Map<number, string>();
  for (const p of raw) {
    if (LANG_CODES.has(p.slug?.toLowerCase() ?? '')) {
      langByParentId.set(p.id, p.slug.toLowerCase());
    }
  }

  const resolved: WpPage[] = [];
  const unresolved: UnresolvedPage[] = [];

  for (const r of raw) {
    // Skip the language root pages themselves (slug = lang code, parent=0).
    if (LANG_CODES.has(r.slug?.toLowerCase() ?? '') && (r.parent ?? 0) === 0) continue;

    // language: parent first, URL fallback.
    const langFromParent = langByParentId.get(r.parent ?? 0) ?? null;
    const urlParsed = parseLink(r.link);
    const language = langFromParent ?? urlParsed.language;

    // destination: slug first, URL fallback.
    const destFromSlug = destinationFromSlug(r.slug);
    const destFromUrl = urlParsed.slug ? destinationFromSlug(urlParsed.slug) : null;
    const destination = destFromSlug ?? destFromUrl;

    if (language && destination) {
      resolved.push({
        id: r.id,
        slug: r.slug,
        title: r.title?.rendered ?? '',
        link: r.link,
        parent: r.parent ?? 0,
        status: r.status,
        date: r.date ?? null,
        modified: r.modified ?? null,
        menuOrder: r.menu_order ?? 0,
        template: r.template ?? '',
        language,
        destination,
      });
    } else {
      unresolved.push({
        id: r.id,
        slug: r.slug,
        link: r.link,
        title: r.title?.rendered ?? '',
        reason: !language && !destination
          ? 'no-language-no-destination'
          : !language
            ? 'no-language'
            : 'no-destination',
      });
    }
  }

  // Deduplicate by language|destination, keeping the most recently modified.
  const dedup = new Map<string, WpPage>();
  for (const p of resolved) {
    const key = `${p.language}|${p.destination}`;
    const prev = dedup.get(key);
    if (!prev) {
      dedup.set(key, p);
      continue;
    }
    const prevTs = Date.parse(prev.modified ?? prev.date ?? '');
    const curTs = Date.parse(p.modified ?? p.date ?? '');
    if (Number.isFinite(curTs) && (!Number.isFinite(prevTs) || curTs > prevTs)) {
      dedup.set(key, p);
    }
  }

  const pages = [...dedup.values()].sort(
    (a, b) => a.language.localeCompare(b.language) || a.destination.localeCompare(b.destination),
  );

  const byLanguage: Record<string, number> = {};
  for (const p of pages) byLanguage[p.language] = (byLanguage[p.language] ?? 0) + 1;

  return { pages, unresolved, byLanguage, totalRaw: raw.length };
}

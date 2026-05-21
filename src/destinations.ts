/**
 * Destination registry.
 *
 * Two source systems name destinations differently:
 *  - GA4 `pagePath` uses URL slugs:        /en/grancanaria/  -> "grancanaria"
 *  - Kibana `context_ref` uses display names: "Gran Canaria"
 *
 * Both must collapse to one canonical name (the value used in the spreadsheet).
 * Extracted from the client inventory sheet "LP - New - Inventory by release".
 * If Loquis adds destinations, update SLUG_TO_NAME below.
 */

/** URL slug (GA4 pagePath, 2nd segment) -> canonical destination name. */
export const SLUG_TO_NAME: Record<string, string> = {
  agadir: 'Agadir',
  algarve: 'Algarve',
  amsterdam: 'Amsterdam',
  antalya: 'Antalya',
  corfu: 'Corfu',
  costablanca: 'Costa Blanca',
  costabrava: 'Costa Brava',
  costadelsol: 'Costa del sol',
  crete: 'Crete',
  cyprus: 'Cyprus',
  dalaman: 'Dalaman',
  djerba: 'Djerba',
  fuerteventura: 'Fuerteventura',
  grancanaria: 'Gran Canaria',
  hammamet: 'Hammamet',
  hurghada: 'Hurghada',
  ibiza: 'Ibiza',
  lanzarote: 'Lanzarote',
  london: 'London',
  madeira: 'Madeira',
  majorca: 'Mallorca',
  malta: 'Malta',
  marrakech: 'Marrakech',
  menorca: 'Menorca',
  nyc: 'New York',
  paris: 'Paris',
  prague: 'Prague',
  rhodes: 'Rhodes',
  rome: 'Rome',
  santorini: 'Santorini',
  sharmelsheikh: 'Sharm',
  sousse: 'Sousse',
  tenerife: 'Tenerife',
};

/** Canonical order used when laying out the spreadsheet rows. */
export const DESTINATION_ORDER: string[] = [...new Set(Object.values(SLUG_TO_NAME))].sort((a, b) =>
  a.localeCompare(b),
);

/**
 * Localized / variant names seen in GA4 slugs and Kibana `context_ref`.
 * Keys are normalized (see normalizeKey); values are canonical destinations.
 * context_ref carries DE/IT/FR display names ("Parigi", "Rom", "Cipro").
 * Misspelled GA4 slugs ("amesterdam") are deliberately NOT aliased — they are
 * skipped as unknown, matching how the client reference report treats them.
 */
const ALIASES: Record<string, string> = {
  parigi: 'Paris', paris: 'Paris',
  londra: 'London', londres: 'London',
  rom: 'Rome', roma: 'Rome',
  cipro: 'Cyprus',
  minorca: 'Menorca',
  praga: 'Prague', prag: 'Prague',
  sharmelsheikh: 'Sharm', sharmelsheikhredsea: 'Sharm',
  djerbagreaterarea: 'Djerba',
  grandecanarie: 'Gran Canaria', grancanarie: 'Gran Canaria',
};

function normalizeKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // drop diacritics: "Corfù" -> "corfu"
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const NAME_LOOKUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const name of Object.values(SLUG_TO_NAME)) m[normalizeKey(name)] = name;
  for (const [k, v] of Object.entries(ALIASES)) m[k] = v;
  return m;
})();

/** Resolve a GA4 slug to a canonical name. Returns null if unknown. */
export function destinationFromSlug(slug: string): string | null {
  const s = slug.toLowerCase();
  return SLUG_TO_NAME[s] ?? NAME_LOOKUP[normalizeKey(s)] ?? null;
}

/**
 * Resolve a Kibana `context_ref` to a canonical destination.
 * context_ref is noisy: localized names, ` (deu)` suffixes, ` - Guida in
 * italiano` / ` - top 10` tails. Strip parentheticals, then try the whole
 * string and each ` - ` segment against the known names + aliases.
 */
export function destinationFromContextRef(contextRef: string): string | null {
  if (!contextRef) return null;
  const cleaned = contextRef.replace(/\([^)]*\)/g, ' ').trim();
  const segments = [cleaned, ...cleaned.split(/\s+-\s+/)];
  // Also try each segment with a trailing number dropped ("Amsterdam 2" -> "Amsterdam").
  const candidates = segments.flatMap((s) => [s, s.replace(/\s*\d+\s*$/, '')]);
  for (const c of candidates) {
    const hit = NAME_LOOKUP[normalizeKey(c)];
    if (hit) return hit;
  }
  return null;
}

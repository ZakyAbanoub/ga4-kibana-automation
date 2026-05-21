/**
 * Market = audience grouping shown in the spreadsheet (UK / DE / IT / FR / ES).
 * Derived from the content language.
 *  - GA4: language is the 1st URL path segment (en/it/fr/es/de).
 *  - Kibana: `language` field is a locale (en_US/it_IT/fr_FR/es_ES/de_DE).
 */

export type Market = 'UK' | 'DE' | 'IT' | 'FR' | 'ES';

/** Spreadsheet column / section order. */
export const MARKET_ORDER: Market[] = ['UK', 'DE', 'IT', 'FR', 'ES'];

/** ISO 639-1 language code -> market. */
const LANG_TO_MARKET: Record<string, Market> = {
  en: 'UK',
  de: 'DE',
  it: 'IT',
  fr: 'FR',
  es: 'ES',
};

/** Resolve a GA4 path-segment language (e.g. "en") to a market. */
export function marketFromLang(lang: string): Market | null {
  return LANG_TO_MARKET[lang.toLowerCase()] ?? null;
}

/** Resolve a Kibana locale (e.g. "en_US", "it_IT") to a market. */
export function marketFromLocale(locale: string): Market | null {
  if (!locale) return null;
  const lang = locale.split(/[_-]/)[0]?.toLowerCase() ?? '';
  return marketFromLang(lang);
}

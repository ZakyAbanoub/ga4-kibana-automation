# Loquis × Lastminute — Automazione Spreadsheet · Discovery

Data: 2026-05-21. Stato: esplorazione fonti completata.

## File

- **Copia editabile (refactored)**: Google Sheet `1GM3EAQgtGH93YQggku98C6SO9C_JFVaiqvyE_pAPwVA` — qui scrive l'automazione.
- **File principale cliente (dati corretti, reference test)**: `reference-data.xlsx` (gitignored, NON pubblico).
  Sheet: `LP`, `LP - New - Inventory by release`, `LMN_CRM data`, `Loquis - Dati`,
  `Loquis -Dati- Widget`, `Loquis-UK/DE/IT | Destinazione Sett`, `Dettaglio - Loquis - Dati per D`.

## Fonti — verificate

### GA4 — OK
- Property ID `482794016`. Service account `loquis-licensing-dashboard@loquis-192809.iam.gserviceaccount.com`
  (key in `secrets/ga4-service-account.json`) → accesso Viewer confermato, runReport HTTP 200.
- `pagePath` formato `/{lang}/{destination}/` es. `/en/rome/`, `/de/rome/`. Lingua = segmento 1, destinazione = segmento 2.
- Dimensioni utili: `pagePath`, `isoWeek`, `isoYear`, `deviceCategory`. Metriche: `sessions`, `totalUsers`, `newUsers`.
- **GA4 NON ha evento audio.** Solo eventi standard (page_view, session_start, first_visit, user_engagement, scroll).
  → "Total Audio Played" NON viene da GA4.

### Kibana / OpenSearch — OK
- Base URL `https://stats.loquis.com`, indice `plays`. Auth basic (credenziali in `.env`, non versionate).
- Doc fields: `loquis_id`, `loquis_name` (POI), `language` (`it_IT`/`en_US`/`de_DE`/`fr_FR`/`es_ES`),
  `source_type` (= tipo widget), `source_ref` (host), `context_ref` (= destinazione), `origin`, `timestamp` (epoch ms).
- Filtro plays Lastminute: `source_ref` contiene `lastminute` (~15.1k doc, dal 2024-07).
- **Audio Played = conteggio doc nell'indice `plays`.**
- `source_type` valori Lastminute: `widget_italia_carousel` (8250), `widget_button` (4136), `widget` (1489),
  `widget_playlist_map` (914), `widget_carousel` (168), `widget_story_map` (133), `loquis` (46),
  `widget_hotel_map` (9), `widget_italia_carousel_lg` (3).
- `context_ref` = destinazione (es. "Amsterdam", "London"). Presente su ~1145 doc (aggiunto di recente).
- `source_type.keyword` / `language.keyword` aggregabili; campi base `text` no.

## Modello dati derivato

| Metrica | Fonte | Chiavi |
|---|---|---|
| Sessions, Users, New Users, Desktop/Mobile | GA4 | lingua + destinazione + ISO week (da pagePath) |
| Total Audio Played | Kibana `plays` | lingua(market) + destinazione (context_ref) + week (da timestamp) |
| Audio per widget | Kibana `plays` | market + week + source_type |
| CRM (Delivered/Opened/Clicked/OR/CTR) | cliente, manuale | NON automatizzato |

Market = lingua: `en→UK`, `de→DE`, `it→IT` (`fr→FR`, `es→ES` solo coverage).

## Validazione contro reference-data.xlsx (estrazione locale)

Confronto mercato UK, settimane 52/2025 → 11/2026 (tab `Loquis - Dati`):

- **Sessions** — match esatto 12/12 settimane. Dimensione GA4 corretta = `landingPage`
  (NON `pagePath`: pagePath conta la sessione su ogni pagina visitata, sovrastima).
- **New Users** — match esatto 12/12. Metrica `newUsers`.
- **Users** — match esatto 12/12. Metrica corretta = `activeUsers` (NON `totalUsers`).
  Il totale di mercato va da query GA4 dedup per mercato (la somma per-destinazione
  conta 2 volte chi atterra su 2 destinazioni).
- **Audio (Kibana)** — match esatto settimane 09→20 (12 settimane consecutive).
  Settimane 52–08 divergono: epoca pre-"Correzione Bug Carousel" (nota su `Loquis - Dati`
  alla settimana 09) → dati reference manuali/corretti, divergenza attesa.
- **Timezone** — property GA4 = `Europe/Rome`. Le settimane Kibana vanno calcolate
  in `Europe/Rome` (`time_zone` sul date_histogram), altrimenti i play di confine
  finiscono nella settimana sbagliata.

## Decisioni bloccate (2026-05-21)

- Approccio **B**: servizio Node/TS + Vercel Cron (giornaliero `0 0 * * *` + lunedì `0 0 * * 1`).
- Tutti i tipi widget come colonne separate nel tab "Widget Performance".
- Tutti i mercati: UK/DE/IT/FR/ES.
- Audio per destinazione attribuito via `context_ref`; play senza `context_ref`
  (~53%) contano nei totali mercato ma non nel dettaglio destinazione.
- CRM: resta input manuale del cliente, mai toccato.

## Da confermare con Loquis/cliente

1. Mapping nomi widget: colonne sheet (`widget_carousel`, `widget_carousel_lg`) vs Kibana
   (`widget_italia_carousel`, `widget_italia_carousel_lg`). `widget` e `loquis` generici → dove vanno?
2. Audio per destinazione: solo ~1145 doc hanno `context_ref`. Da quando è affidabile?
   I doc senza `context_ref` come si attribuiscono?
3. CRM: confermato che resta input manuale del cliente, mai toccato dall'automazione.

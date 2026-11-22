# Design library classification contract

## Primary categories

| Key | Destination | Choose when the main reusable decision is about |
| --- | --- | --- |
| `web` | `01_WEB_UI` | website/app UI, interaction, responsive layout, web motion, component behavior |
| `presentation` | `02_PRESENTATION_PPT` | slides, decks, speaker narrative, slide masters, presentation pacing |
| `word` | `03_DOCUMENT_WORD` | editable long-form office documents, proposals, letters, DOCX typography |
| `pdf` | `04_PDF_LAYOUT` | fixed-page or print layout, brochures, forms, ebooks, PDF composition |
| `report` | `05_REPORT` | analytical or business reporting, answer-first narrative, evidence hierarchy |
| `image` | `06_IMAGE_GRAPHICS` | logos, illustration, photography, posters, thumbnails, static graphics |
| `visualization` | `07_VISUALIZATION` | charts, diagrams, dashboards, maps, infographics, quantitative encoding |
| `cross-media` | `08_CROSS_MEDIA_SYSTEM` | an intentional brand/design system spanning at least three output families |
| `motion` | `09_MOTION_VIDEO` | video, motion graphics, title sequences, editing rhythm, scene transitions |

## Tie-break rules

1. Classify by the artifact's intended output, not its current file extension. A Markdown spec for a
   website is `web`; a PDF showing slide layouts is `presentation`.
2. Choose the category that owns the strongest design decisions. Record other useful surfaces as tags.
3. Use `report` when information hierarchy and evidence narrative dominate. Use `word` when editable
   document styling and page mechanics dominate. Use `pdf` when fixed-layout or print composition dominates.
4. Use `visualization` for the representation of data or relationships even when embedded in a report.
5. Use `image` for static visual style; use `motion` when timing and temporal transitions are essential.
6. Use `cross-media` only when the source itself defines a coordinated multi-output system.
7. When still uncertain, keep the file in `00_INBOX` and record candidate categories instead of guessing.

An intentional cross-media system may contain a stable `frame`, one or more replaceable design layers, and
medium adapters. Keep it as one catalog item when those files are versioned and documented as one system.
An optional `SYSTEM.json` may pin exactly the `frame`, `design`, `adapters`, `examples`, and `sources` roles;
the audit validates that manifest when present but does not require it for ordinary references.

## Required metadata

Every cataloged item needs a stable id, one primary category, title, original filename, relative item
path, SHA-256, byte size, received date, tags, source URL/owner/license/redistribution status, and an
evidence boundary. Unknown values stay `UNKNOWN`.

## Safe reuse

The library may preserve a raw reference privately. A downstream artifact should extract transferable
principles: hierarchy, rhythm, density, color roles, typography roles, motion rules, composition logic,
accessibility and responsive behavior. Do not reuse identifying trade dress, source copy, logos,
proprietary assets, or a distinctive composition without permission.

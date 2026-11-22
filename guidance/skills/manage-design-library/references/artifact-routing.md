# Artifact routing map

Use this map when creating or substantially redesigning a visual artifact. Search the primary library
category first, then `cross-media` and useful adjacent tags. Carry only the selected principles and
item ids into the project; do not copy the full reference as an instruction set.

| Requested artifact | Primary search | Adjacent search | Direction and production workflow |
| --- | --- | --- | --- |
| Website, web app, landing page | `web` | `cross-media`, `motion`, `image`, `visualization` | `establish-design-direction` → `codex-frontend`; use Product Design for visual exploration and `browser-qa` after implementation |
| AgenticFabWorks site | `web` | `cross-media`, `image`, `motion` | `establish-design-direction` → `agentic-website-maker`; use image generation only when it materially improves the site |
| PowerPoint or Google Slides | `presentation` | `cross-media`, `image`, `visualization`, `report` | `establish-design-direction` → native Presentations; use `diagram-design`, image generation, or data visualization for embedded visuals |
| Word or editable document | `word` | `cross-media`, `report`, `visualization`, `image` | `establish-design-direction` → native Documents; use `diagram-design` for relational figures |
| PDF, brochure, print layout | `pdf` | `cross-media`, `word`, `report`, `image`, `visualization` | `establish-design-direction` → native PDF; use Documents or Presentations first when editability is required |
| Analytical or business report | `report` | `cross-media`, `word`, `pdf`, `presentation`, `visualization` | `establish-design-direction` → `data-analytics:build-report`; route the final editable/rendered format through Documents, Presentations, or PDF |
| Image, illustration, logo, poster | `image` | `cross-media`, `motion`, `web`, `presentation` | `establish-design-direction` when a durable direction is needed → `generate-images-with-web-gpt` or system `imagegen` |
| Chart or quantitative figure | `visualization` | `cross-media`, `report`, `presentation`, `web` | `data-analytics:visualize-data`; use `visualize:visualize` for interactive exploration and `diagram-design` for editorial SVG/HTML relationships |
| Diagram or architecture figure | `visualization` | `cross-media`, `report`, `presentation`, `web` | `establish-design-direction` when unbranded → `diagram-design`; embed through the containing artifact's workflow |
| Video or motion graphic | `motion` | `cross-media`, `image`, `web`, `presentation` | establish timing, typography, and visual direction first; use image generation only for authorized source frames/assets |

## Selection rules

1. Existing project truth and the user's current request outrank library preferences.
2. Search by primary category even when the input is Markdown; classify by intended output.
3. Choose references that contribute different roles: one system/direction, one composition or
   interaction pattern, and optionally one image/visualization treatment.
4. Avoid mixing incompatible visual languages merely because several references are favorites.
5. Record adopted and rejected principles in the project's `DESIGN.md` or equivalent brief.
6. Use the specialist skill's render, browser, or format-specific validation; library selection is not
   proof that the finished artifact is correct.
7. For multi-format work, read the selected frame and design layer as separate roles. Share semantic
   hierarchy, evidence, access, and status meaning; let each medium adapter own native geometry and units.
8. A PPTX is a reusable template only when its theme/master/layout/placeholder structure is verified.
   A collection of sample slides or a rendered PDF is a visual reference, not a functioning slide template.
9. Record editable and rendered outputs separately. Passing one browser, DOCX, PPTX, or PDF gate does not
   imply the other adapters passed.

## Current capability and policy

The routing table names workflow owners, not guaranteed installed tools. Use only the skills and native tools actually available to the current caller; never invent a namespace or copy a host executor into a Web package. Run render/browser/format checks only when current policy and explicit user scope allow them. Otherwise record NOT_RUN for the affected medium; an editable artifact is not a rendered acceptance result.

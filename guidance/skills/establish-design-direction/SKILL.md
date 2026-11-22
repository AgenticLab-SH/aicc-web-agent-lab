---
name: establish-design-direction
description: Set or revise a durable visual and brand direction before implementation.
---

# Establish Design Direction

Create a project-owned visual thesis that another agent can implement consistently. Produce concrete
composition, typography, color, rhythm, state, and media decisions rather than a list of disliked styles.

## 1. Establish the working frame

1. Read the nearest repository instructions, current `DESIGN.md`, tokens, components, approved assets,
   screenshots, and live product surface. List the existing truths that will continue to own the design.
2. Classify the change as `preserve`, `extend`, or `replace`, and name the exact surfaces affected.
3. Choose the surface mode for each surface:
   - `persuade`: one memorable claim, evidence rhythm, decisive CTA;
   - `operate`: dense status, quick comparison, predictable controls, recovery evidence;
   - `read`: comfortable measure, explicit hierarchy, references close to claims;
   - `experience`: staged reveal, spatial continuity, purposeful motion.
4. Write a one-sentence visual thesis in this form:
   `For [audience], this surface should feel [two qualities] by using [spatial idea], [type idea], and [color role].`

## 2. Select useful source material

Use sources as specialist libraries, then make a project decision of your own.

1. Search the registered personal design library with `manage-design-library`: requested medium first,
   then `cross-media`, then one adjacent tag that owns a real part of the output.
2. Run `scripts/select-design-sources.mjs --surface <surface> --intent "<task>" --json` when the local
   AICC design-source store is available. Read only the returned active snapshot paths and recommended
   subpaths. Prefer 1–3 sources whose responsibilities are different.
3. Route source responsibilities as follows:
   - Impeccable: layout, typography, color, critique, and finish passes;
   - shadcn/ui: accessible component behavior and source-owned component examples;
   - Open Design: design-system structure, templates, catalogs, and cross-format organization;
   - AI Website Cloner: observable UI reconstruction and viewport comparison;
   - Presentation AI: themes, editable layouts, charts, and narrative modes;
   - Diagram Design: relationship-specific SVG/HTML diagram grammar;
   - Logo Creator: brief, variant, selection, and brand-kit sequence.
4. For each selected source, record `adopt`, `adapt`, and `evidence`:
   - `adopt`: the principle that fits the product;
   - `adapt`: how it changes for this audience, stack, and medium;
   - `evidence`: exact local file, public URL, or project surface inspected.
5. Treat an `UNKNOWN` license source as a local pattern reference. Keep copied code and assets within
   verified license and notice terms.

If the user wants a broad visual choice, compare 3 materially different directions. Make each direction
specific enough to sketch: spatial thesis, type pairing, palette roles, density, motion, and signature
moment. Choose autonomously when one direction is clearly best supported; ask only when the choice
changes product meaning or brand ownership.

## 3. Compose the direction

Define these layers in order so later decisions inherit a coherent hierarchy.

1. **Spatial thesis** — Choose the dominant composition: editorial spine, operational cockpit,
   split-stage narrative, modular field, dense ledger, or another named structure. Sketch the first
   viewport and one deep-content state in words.
2. **Information hierarchy** — Assign one primary action or takeaway, 2–4 supporting groups, and the
   evidence/recovery layer. Decide what becomes progressively disclosed.
3. **Typography** — Name display, body, label, data, and code roles. Set a practical scale, line length,
   weight contrast, Korean/Latin behavior, and fallback.
4. **Color** — Define semantic roles (`canvas`, `surface`, `text`, `muted`, `accent`, `transport`,
   `success`, `warning`, `danger`) and contrast behavior. Use the accent to express the product's focal
   hierarchy.
5. **Rhythm and shape** — Set grid, spacing rhythm, density, border/radius logic, and depth model.
   Make wide and narrow layouts adaptations of the same priority order.
6. **Signature moment** — Specify one memorable, product-relevant visual behavior: a system map,
   evolving evidence rail, structured reveal, tactile selector, or another purposeful moment.
7. **State grammar** — Design loading, empty, success, partial, stale, error, permission, and offline
   states with language, iconography, and recovery actions.
8. **Motion** — Assign motion only to continuity, causality, spatial change, or feedback. Define reduced
   motion at the same time.

Read [artifact profiles](references/artifact-profiles.md) for medium-specific sequences. When three or
more media families share the direction, also read the [cross-media contract](references/cross-media-contract.md).

## 4. Write the project decision

Read [the schema](references/design-md-schema.md), then create or update the project's canonical
`DESIGN.md`. Preserve confirmed values outside the requested surface. Include:

- product, audience, surface mode, success condition, and visual thesis;
- spatial thesis and first-viewport composition;
- selected source/library item ids with `adopt`, `adapt`, and evidence;
- semantic color, typography, spacing, radius, density, depth, and motion values;
- signature moment, component/state grammar, accessibility, responsive, and asset rules;
- existing components and assets that remain authoritative;
- values still `UNKNOWN` and decisions that genuinely require the user;
- provenance distinguishing existing truth, verified reference, and project decision.

For multi-format work, record the invariant frame, replaceable design layer, medium adapters, editable
sources, rendered outputs, and validation required for each format.

## 5. Handoff and finish loop

1. Hand the visual thesis, exact source paths, adopted principles, tokens, and signature moment to the
   production owner: `codex-frontend` or `agentic-website-maker` for web; `presentations` for decks;
   `diagram-design` for diagrams; `generate-images-with-web-gpt` for logos/images; and the relevant
   Documents/PDF/report skill for page artifacts.
2. Implement one representative composition first. Confirm hierarchy, type, palette, and responsive
   priority before multiplying the pattern across every screen or slide.
3. Run one batched desktop/mobile or page/slide inspection. Group findings by hierarchy, readability,
   interaction, state, and polish; apply them as one coherent pass.
4. Run one confirm pass against the visual thesis and medium-native checks. Report actual evidence per
   format, plus any `UNKNOWN` that remains.
5. When source code, text, or assets were copied, update the product notice/upstream record. When only
   a principle was used, record it as pattern provenance.

## Worked example: operational dashboard

```text
Thesis: For operators, the dashboard should feel calm and exact through a strong evidence spine,
compact sans typography, graphite surfaces, and copper/cyan role accents.

Impeccable → typeset + layout + critique for hierarchy and finish
shadcn/ui → dialog, checkbox, and focus behavior
Open Design → source catalog and multi-format state organization

First viewport: current state and one next action on the left; compact system evidence on the right.
Deep state: source rows expand into commit, license, changed surface, and rollback evidence.
Signature moment: selecting sources visibly builds one immutable update plan.
```

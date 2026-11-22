# Cross-media frame, design layer, and adapter contract

Use this contract when one design context must survive three or more output families. Do not use it to
make every format look pixel-identical.

## Roles

- **Frame**: stable information and quality contract—hierarchy, grid roles, spacing roles, typography
  roles, density, accessibility, adaptation, reduced motion, evidence, privacy/rights, and validation.
- **Design layer**: replaceable expression—palette, type scale/families, shapes, surfaces, icon/image
  direction, interaction/motion personality, chart/table treatment, and anti-patterns.
- **Adapter**: medium-native mapping for web, slides, editable documents, fixed-page PDF/reports,
  visualization, or motion. It owns units, native structure, and format-specific validation.
- **Project `DESIGN.md`**: decision record selecting a frame/version, one design layer, adapters,
  existing truth, local overrides, references, rights, unknowns, and verification.

One frame may support many design layers. Use one design layer per surface unless an explicit sub-brand or
mode boundary justifies another. A user-provided authorized template or existing product system is design
truth and can replace a library design layer while the frame's evidence/access/validation gates remain.

## Selection sequence

1. Verify content, audience, output formats, existing truth, privacy, and rights.
2. Search the registered library's primary category, `cross-media`, and adjacent tags.
3. If a cross-media item declares separate frame/design files or an optional `SYSTEM.json`, inspect both;
   never treat a visual layer as the invariant frame.
4. Select the frame by information, accessibility, provenance, and validation fit.
5. Select the design layer by audience, purpose, surface mode, density, rights, and implementation cost.
6. Select one adapter for each requested format. Record deliberate deviations rather than forcing literal
   token values across CSS, OOXML, PDF, SVG, and presentation units.
7. Write the project `DESIGN.md`, then hand off to the native/specialist production workflow.

## Invariants versus adaptations

Keep these invariant: takeaway/evidence/action/qualification roles, semantic hierarchy, status meaning,
content priority, source/rights boundary, accessibility intent, and validation evidence.

Adapt these by medium: literal grid, units, line breaks, component geometry, page/slide composition,
interaction affordance, animation, source-note placement, and native structure.

Examples:

- Web uses landmarks, reflow, keyboard/focus states, and viewport/browser checks.
- Slides use theme → master → layout → slide ownership, outline-first narrative, source notes, and render of
  every slide. A sample deck is not a template unless the master/layout/theme hierarchy works.
- Word uses named styles, real lists/tables, page geometry, and rendered page inspection.
- PDF uses an identified editable source or direct fixed-layout source, final reopen, and page rendering.
- Quantitative figures validate data/metrics first, then encoding, accessible equivalent, and final embed size.
- Diagrams select the relationship grammar before styling and validate connectors/labels in context.

## Validation record

Report separately:

- source/fact/data checks;
- frame/layer/adapter selection and versions;
- native structure checks;
- accessibility and rights checks actually run;
- rendered/browser-visible checks for each output;
- editable versus rendered deliverables;
- unrun or blocked checks as `HOLD`/`UNKNOWN`.

A successful preview or one export never proves the other formats.

# Adversarial AFW design scorecard

Score only from a rendered production build. Capture desktop and mobile plus the primary interaction,
keyboard focus and reduced-motion state. Record evidence and deductions in the project's `design-qa.md`.

| Category | Points | Full-credit evidence |
| --- | ---: | --- |
| Product truth and IA | 16 | One primary path, real services/data/boundaries, no duplicate or invented content |
| Visual hierarchy and typography | 14 | Clear H1/section/action hierarchy, readable Korean/English, correct wrapping at all viewports |
| Brand distinctiveness | 12 | Original AFW mark/core geometry, disciplined cyan/red/gold, no generic or copied sci-fi treatment |
| Layout and responsive composition | 14 | Purposeful desktop/tablet/mobile compositions, 320px/200% zoom, no clipping or horizontal overflow |
| Interaction and scroll narrative | 14 | Native scroll, coherent sticky scenes, meaningful progress/state, touch/focus equivalents |
| Accessibility and states | 14 | WCAG AA, visible focus, logical semantics, loading/empty/error/offline/reduced-motion complete |
| Asset quality and fidelity | 8 | Sharp correctly sized real assets, appropriate vector/raster/WebGL use, labelled synthetic content |
| Performance and resilience | 8 | Budgets met, scene pauses/degrades, no relevant console/network error, content survives JS/WebGL failure |
| **Total** | **100** | |

Pass only when:

- total ≥95;
- accessibility and states ≥12/14;
- no P0/P1/P2 finding remains in Product Design `design-qa`;
- no zero-tolerance failure appears below.

Zero-tolerance failures:

- fake or unsupported public claim;
- broken primary link/action, inaccessible route, canvas-only content, hover-only essential control;
- horizontal overflow at 320/390px, clipped persistent control, unreadable contrast or hidden focus;
- scroll/wheel hijack, mandatory snap, motion that ignores reduced-motion;
- placeholder or low-resolution visible asset, copied logo/trade dress, unlabelled production-like synthetic data;
- relevant console error, public secret/private path/source map, or deployment not matching validated commit.

Deduct even when attractive:

- 1–4 points for decorative animation without information or state meaning;
- 1–4 points for repeated cards/CTA/copy or avoidable visual density;
- 1–3 points for every breakpoint that merely shrinks desktop rather than recomposes;
- 1–4 points for an image that is sharp but wrong in subject, crop, palette or role;
- 1–4 points for motion whose direction reversal, fast skip or settling leaves an incoherent state.

The score is a release gate, not a self-congratulation metric. Explain every non-perfect category and
link deductions to visible evidence. A numeric score never overrides a P0/P1/P2 finding.

---
name: agenticfabworks-web-design
description: AgenticFabWorks 방문자 웹 UI 설계·검토 전용. 다른 사이트는 일반 프런트엔드 스킬 사용.
---

# AgenticFabWorks Web Design

Build one recognizable product system, not a collection of futuristic effects. Use this skill together
with `manage-design-library`, `establish-design-direction`, the owning frontend skill, and `browser-qa`.
Use `agentic-website-maker` when the work also includes an AFW release or domain.

## Required order

1. **Recover truth.** Read repository instructions, the current page, its runtime and deployment
   contract, `DESIGN.md`, shared components, content/data boundaries, TODO or handoff records, and
   prior QA. Preserve working behavior and unrelated dirty changes. A prior QA pass is not evidence
   for a newly selected visual target.
2. **Ground the direction.** Search the registered design library in `web`, `cross-media`, `motion`,
   and `image`; inspect only 1–3 relevant items. If the user did not provide a visual target, inspect
   suitable current references and official design-system sources. Distill decisions into the
   project-owned `agenticfabworks-web-design.md` or `DESIGN.md`. Never copy third-party trade dress.
3. **Choose the component contract.** For a new React/Vite surface, initialize shadcn/ui and own the
   generated component code. For an established non-React or static SEO surface, preserve its stack
   and apply shadcn's open-code composition, semantic token pairs, state and accessibility rules
   without pretending the CLI was installed. Read [the AFW system](references/agenticfabworks-web-design.md).
4. **Build foundations first.** Define semantic tokens, type roles, grid, spacing, density, radii,
   image roles, motion grammar, state matrix, responsive composition and common components before
   polishing a page. Build the landing page as the visual and interaction benchmark.
5. **Create imagery deliberately.** Use `generate-images-with-web-gpt`: Web GPT first, Codex-auth
   ImageGen second. Attach references with roles, generate real project assets, inspect them, and copy
   selected results into the repository. If both paths fail, report the failure and use a truthful
   vector/WebGL/code-native asset only when the requested role is better expressed that way; never
   insert a placeholder and call it generated imagery.
6. **Build the landing page.** Lead with one primary promise and action, one signature spatial object,
   and a continuous native-scroll narrative. Use interaction to explain product state, process or
   evidence. Keep critical copy and links in semantic HTML; visual layers enhance rather than own
   content. For a public product explanation, read
   [the visitor-facing page contract](references/visitor-facing-product-pages.md) before implementation.
7. **Derive subpages.** Reuse the same header, section rail, typography, token, CTA, image, state and
   motion components. Adapt density and layout to the page's purpose; do not clone the landing hero
   onto every route.
8. **Implement complete states.** Provide keyboard, touch and fine-pointer equivalents plus loading,
   empty, error, offline, unavailable and reduced-motion behavior. Keep touch targets at least 40px,
   normally 44px. Do not hide essential instructions or recovery only inside tooltips.
9. **Score adversarially.** Capture the source visual and rendered implementation at matching states.
   Run [the scorecard](references/adversarial-scorecard.md) and Product Design `design-qa`. Fix every
   P0/P1/P2 and repeat at most two bounded visual passes. The weighted score must be at least 95,
   accessibility must be at least 12/14, and no zero-tolerance failure may remain.
10. **Prove the release.** Run production build, output/privacy audit, desktop/mobile browser QA,
    keyboard/touch/reduced-motion checks and performance measurement. For an authorized deployment,
    publish the exact validated commit and verify the normal production URL.

## AFW signature rules

- Use a near-black graphite foundation, ceramic-white text, cyan energy for active flow, and restrained
  red/gold only for provenance, attention or material reflections. Never cover every element in glow.
- Prefer an original three-beam triangular fabrication mark and a circular fabrication-core geometry.
  Do not reproduce armor, helmets, arc-reactor props, film frames, characters, Marvel marks or copied HUDs.
- Make motion causal: input or native scroll changes object, signal line, annotation, copy and progress
  as one state. Native scroll remains authoritative; never hijack the wheel or require mandatory snap.
- Use one persistent apparatus across long dark narratives: progress rail, transformation object,
  signal line/grid, meaningful annotations, or context-aware header. Annotations must describe real
  scope such as `PUBLIC`, `LOCAL`, `PROTECTED`, `SYNTHETIC PREVIEW` or a verified artifact.
- On desktop, use asymmetric 12-column compositions and a sticky stage where it improves explanation.
  On mobile, recompose into a readable vertical sequence or explicit accordion; never shrink a dense
  desktop HUD or depend on hover.
- Do not use fake live metrics, invented clients, empty charts, nested glass cards, huge pills, tiny
  gray type, blurred body copy, decorative WebGL, or animation that starts independently of user state.
- Do not expose route trees, viewport switchers, build metadata or other reviewer controls on a visitor
  page. Do not embed the live product page in an iframe as an explanation unless the user explicitly asks
  for an interactive sandbox; use a short actual workflow recording with a still fallback instead.

## Completion evidence

Return the project design source, key component/asset paths, score and design-QA report, tested
viewports/interactions, performance/accessibility evidence, release commit and production URL.
State image-generation failures and intentional fallbacks exactly; do not imply a generated asset exists.

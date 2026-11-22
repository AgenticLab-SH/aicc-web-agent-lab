# AgenticFabWorks web design system

## 1. Product character

AgenticFabWorks is a focused AI fabrication workspace: ideas enter as ambiguous signals and leave as
inspectable tools. The interface should feel like precision lab equipment that happens to be software.
It is cinematic at the focal object and editorial around content. It is not a superhero fan site,
cyberpunk game HUD, generic SaaS dashboard, or agency portfolio with fabricated claims.

Surface modes:

- `experience`: home and selected launch pages; one spatial object plus native-scroll story.
- `operate`: tools and workspaces; dense, direct, state-explicit UI.
- `read`: policies, guides and updates; quiet typography with shared provenance and navigation.
- `persuade`: service overview; verified capability, boundary and evidence before broad claims.

## 2. Foundation tokens

Use semantic pairs following shadcn/ui's open-code theming model. Projects may express them as CSS
custom properties, Tailwind tokens or component variables.

```css
:root {
  --background: #04070b;
  --foreground: #f7f9fb;
  --surface: #09111a;
  --surface-foreground: #edf4fa;
  --surface-raised: #0d1823;
  --muted: #8e9cab;
  --border: rgba(151, 184, 207, .20);
  --input: rgba(151, 184, 207, .26);
  --ring: #93efff;
  --primary: #8ceeff;
  --primary-foreground: #031014;
  --secondary: #171f29;
  --secondary-foreground: #eef6fa;
  --energy-cyan: #8ceeff;
  --energy-white: #ecfdff;
  --forge-red: #b42a35;
  --forge-gold: #d5ae62;
  --success: #70d7ae;
  --warning: #e4b968;
  --danger: #ff6f7d;
}
```

Rules:

- Cyan identifies selection, energy flow, live focus and primary technical evidence.
- Red is a bounded alert/forge trace, not the default button color.
- Gold denotes origin, verified material, milestones or premium reflection; never long body text.
- Use no more than one bright energy color and one material accent in a viewport.
- Use borders and spacing before blur or shadow. Avoid backdrop blur on critical copy.

## 3. Typography

- Korean UI/body: `Pretendard Variable`, Pretendard.
- English technical display: `Space Grotesk` or a project-bundled geometric grotesk; fallback Inter.
- Mono annotations: `IBM Plex Mono`, `JetBrains Mono`, or a bundled equivalent.
- At most two font families plus mono annotations.
- Body 15–17px, line height 1.65–1.8; never below 14px for meaningful UI.
- Display: weight 520–690, tracking -0.03em to -0.055em, short line length 8–16ch.
- Uppercase/mono labels are metadata, 11–13px, letter spacing .08–.16em, and never primary copy.

## 4. Grid, rhythm and depth

- Desktop container: 1280–1440px, 12 columns, 20–28px gaps, 32–56px gutters.
- Mobile gutter: 18–24px. Recompose at 960px and again at 640px.
- Section rhythm: 96–180px desktop, 72–112px mobile, except full-viewport sticky stages.
- Radius: 0–4px technical lines, 8–14px controls/surfaces, circular only for knobs and indicators.
- Depth has three bands: foreground control/rail, working object/content plane, rear atmosphere/grid.
- No card-inside-card. A section is not automatically a card; use open surfaces and rules first.

## 5. Brand geometry and assets

- Mark: three open engineered beams forming an upward triangular fabrication frame; preserve negative
  space and a small center energy point. Use an SVG/vector source for every brand lockup.
- Fabrication core: concentric mechanical rings plus triangular beam geometry. WebGL is suitable when
  depth, lighting or scroll state is meaningful. Raster is suitable for art-directed photo/CG scenes.
- The mark and core may share geometry but must remain original. Do not encode `W`, armor eyes, chest
  devices, franchise silhouettes or a copied movie-workshop composition.
- Real product posters must be sanitized, accurate and labelled when synthetic. Do not invent activity.

## 6. Common component contract

Own the source of these components. On React/Vite, prefer shadcn/ui primitives or registry components
with project tokens. On static surfaces, implement the same semantics and state attributes.

- `SiteHeader`: persistent, context-aware, keyboard and mobile menu; current route explicit.
- `BrandMark`: SVG source, full lockup and compact mark, non-looping boot state.
- `Button`: primary, secondary, ghost, destructive; loading and disabled; 44px target.
- `SectionRail`: current section, anchor navigation and progress; collapses to compact mobile label.
- `FabricationCore`: poster/DOM fallback, quality tier, pause and reduced-motion behavior.
- `WorkspaceSelector`: searchable tabs/list, selected state, empty state and URL restoration.
- `InteractivePreview`: explicit play/pause/reset; hover may preview but focus/click owns selection.
- `DetailsDisclosure`: summary remains sufficient; essential recovery is never tooltip-only.
- `StatusBadge`: text + icon/shape, not color alone; public/protected/local/synthetic vocabulary.
- `Toast` and `InlineAlert`: success/error announced; Toast never owns durable recovery.
- `Field`: label, description, invalid state and error association; disable duplicate submission.
- `Footer`: short identity, real navigation, policies and optional top control.

## 7. Motion grammar

One controller owns normalized native-scroll progress. Visual layers may damp that value by 40–120ms
but never create a competing scroll position.

Motion tiers:

- Input acknowledgement: 80–140ms.
- UI state: 160–260ms.
- Content/stage settle: 320–620ms.
- Ambient loop: slow and sparse; stop offscreen, hidden, low-power or reduced-motion.

Use mass hierarchy: focal geometry moves farthest and settles last; UI moves less; annotations respond
quickly. Direction reversal must remain coherent. Stop non-ambient motion within 800ms after scroll stops.
Reduced motion removes scrub, parallax, inertia, looping glow and boot overlays while preserving every
section, state, link and control.

## 8. Landing narrative

Recommended order:

1. Hero: promise + primary action + signature fabrication core.
2. Process: 4–6-step sticky story using one persistent object and meaningful boundaries.
3. Product workspace: actual tools, access, real workflow and interactive preview.
4. Evidence: verified routes, public/protected/local boundaries and inspectable artifacts, not fake KPIs.
5. Guides/updates: quieter reading surface with progressive disclosure.
6. Closing: short brand promise and real navigation/contact route.

Each process scene should contain at least four of: number/action title, short explanation, input →
transformation → output, data/access boundary, evidence artifact, meaningful annotation, detail route.

## 9. Responsive behavior

- Desktop: asymmetric composition, sticky object, vertical rail, pointer hover only as optional preview.
- Tablet: shorten sticky distance, reduce annotation density, keep explicit step controls.
- Mobile: native vertical content, object above/beside copy, compact progress, tap-selected accordion/list.
- Short landscape: remove secondary copy and ambient layers; keep CTA, current state and escape controls.
- WebGL/save-data failure: poster plus semantic navigation. Content must not wait for the scene.

## 10. Performance and accessibility budgets

- Initial critical JS target under 220kB gzip; exceptions require measured value and benefit.
- Hero raster: responsive AVIF/WebP, below 450kB per common viewport where feasible.
- WebGL: DPR cap 1.5 desktop/1.25 mobile, no expensive post-processing, pause offscreen/hidden.
- Target local production Lighthouse: Performance ≥90, Accessibility/Best Practices/SEO ≥95.
- WCAG 2.2 AA contrast, visible focus, logical headings, one H1, keyboard route, 200% zoom, 320px.
- Avoid CLS by declaring media dimensions and reserving sticky-stage geometry.

## 11. Zero-tolerance anti-patterns

- Fake live metrics, clients, revenue, completion rates or testimonials.
- Canvas-only headings, routes or critical data.
- Hover-only controls, wheel hijacking, mandatory scroll snap, autofocus that steals input.
- Tiny gray metadata replacing explanations, excessive glow/blur, huge rounded cards and nested panels.
- Unlabelled synthetic imagery, copied logos or franchise-inspired public assets.
- Claiming shadcn/ui, generated imagery, browser QA or 95 points without corresponding evidence.

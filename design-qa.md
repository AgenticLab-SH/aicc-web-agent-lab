# Design QA

## Comparison target

- Source visual truth: owner-only evidence `dashboard-redesign-20260814/01-ocx-source-desktop.png` and `02-ocx-source-mobile.png`.
- Implementation: `http://127.0.0.1:4381/` with owner-only final captures `11-aicc-desktop-final.png`, `12-aicc-quota-final.png`, and `13-aicc-mobile-final.png`.
- Source desktop: 1280 × 720 pixels. Source mobile: 390 × 844 pixels.
- Implementation CSS viewports: 1280 × 720 and 390 × 844 at device scale 1.
- State: dark local operations dashboard, loaded live status, OCX account quota visible.

## Full-view comparison evidence

The source OCX dashboard established the useful hierarchy: fixed navigation,
compact live metrics, coverage-aware usage and direct account quota. The AICC
implementation intentionally keeps its Arc Operations identity while adopting
that scan order. Viewport-scale scroll chapters prevent unrelated controls from
appearing as one continuous wall of cards.

## Focused comparison evidence

Focused review covered the account quota cards because the source showed
weekly consumption and reset times while the earlier implementation showed
`한도 미확인`. The revised AICC view shows remaining percentage, progress meter,
reset time, active route and re-auth state from the masked OCX CLI response.

## Comparison history

1. P1: OCX quota existed in the source but AICC read only the non-refresh list
   contract. Fixed by adding live read-only quota refresh with a cached fallback.
2. P1: Content was an undifferentiated long document. Fixed with numbered,
   viewport-scale scroll chapters and daily-use ordering.
3. P2: Architecture tables and the six-mode evidence grid widened the mobile
   document. Fixed by containing horizontal overflow inside those components.
4. P2: Codex Desktop use cases were explained only as abstract capabilities.
   Fixed with six copy-ready, filterable recipes and explicit route labels.

## Required fidelity surfaces

- Fonts and typography: existing local Inter/Pretendard/system stack retained;
  chapter headings increased while technical labels remain monospace.
- Spacing and layout rhythm: centered bounded canvas, chapter-level separation,
  contained wide evidence, 44 px mobile targets.
- Colors and tokens: existing graphite/copper Arc Operations tokens retained;
  green remains success and amber remains attention.
- Image quality and assets: no source logos or decorative assets were copied;
  no placeholder imagery was introduced.
- Copy and content: operational copy shortened; recipes expose full prompts only
  on deliberate expansion.
- Interactions: recipe filters, details, copy buttons, navigation, account
  controls and reduced-motion behavior remain keyboard reachable.

## Runtime QA

- Desktop: 1280 px viewport, 1265 px document width, no page-level horizontal overflow.
- Mobile: 390 px viewport, 375 px document width, wide evidence remains locally contained.
- Recipe filter: `여러 Web GPT` returns the two intended role-DAG and research cards.
- Recipe copy: clipboard content matches the selected prompt and provides inline button feedback.
- Console: no warning or error entries in the final inspected state.
- Quota: masked OCX rows show remaining weekly percentage and reset time; one
  re-auth row is identified without exposing authentication data.

## Findings

No actionable P0, P1 or P2 findings remain in the inspected desktop and mobile
states. Desktop-account quota for the separate `cm` account store remains
truthfully unknown because that source does not provide a quota contract; OCX
pool quota is now visible.

## Final result

passed

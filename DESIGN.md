# open-AICC dashboard design direction

## 전체 현황 · 2026-11-20

기존 녹색·시스템 한글 글꼴을 유지한다. 읽기 화면은 밝은 바탕과 그룹별 분리, 강한
제목→현재→잔여→다음 순서로 위계를 준다. 상태는 색과 한국어 이름을 같이 표시한다.
모바일 한 열·데스크톱 두 열, 긴 글은 상세 펼치기. 버튼 44px 이상·초점 표시·줄바꿈·
강제색/확대 대응. 새 장식·외부 폰트·시각용 가짜 진행률은 사용하지 않는다.

## G3 공통 화면

기존 밝은 원장과 한국어 우선·상태/근거 분리를 유지한다. 세 주 메뉴와 목록/상세를 사용하고 700px 이하에서 한 열로 이어진다. 44px 버튼, 플랫폼 한영 글꼴, 긴 UUID/설명 줄바꿈, 비활성 사유, 포커스 윤곽과 reduced-motion을 적용한다. 새 폰트/UI 패키지는 없다.

기본·선택·비활성·포커스·조회 중·빈 목록·부분 실패·연결 끊김·결과 불명 상태를 표시한다. 실제 대비·390/1440px 렌더·확대·터치는 브라우저 호스트가 없어 미확인이다.

설계 계약의 핵심 항목은 원칙, 색, 타이포, 접근성이다.

## Context

- Product: open-AICC local AI control plane and operator console.
- Audience: one owner operating Codex Native, Web GPT, OCX, Workspace MCP, projects, evidence, and recovery paths on this Mac.
- Surface mode: `operate`.
- Success condition: the first viewport reveals Master goals, Projects, Core routes, Attention, Recent evidence, and Manual reviews in that order; every incumbent action/status/recovery surface remains reachable; current evidence is never merged with source configuration or historical acceptance.
- Status: confirmed by `docs/next-agent-handoff.md` sections 14–16.

## Direction

- Name: `Luminous Control Ledger`.
- Visual thesis: for a local AI operator, the homepage should feel calm and exact by using a bright ceramic workspace, one cyan evidence path, compact Korean-first operational type, and ledger rows that expose state before controls.
- Spatial thesis: an editorial evidence spine crosses an operational cockpit. The first view is not a hero or card wall: a cumulative goal ledger establishes intent, a project ledger owns the broad reading axis, a compact route strip states the four survival paths, and one narrow attention/review rail holds blockers and manual actions.
- Preserve: all existing product truth, API boundaries, action preview/confirm/rollback, status distinctions, planner, recipes, activity, Web GPT, Workspace, accounts, recovery, monitoring, design sources, system map, and tool library.
- Replace: deep graphite, copper energy metaphor, decorative orbit core, viewport-scale marketing chapters, and repeated bordered cards as the default container.
- Anti-references: generic admin card grids, glass blur, neon-on-black AI dashboards, pseudo-3D icon tiles, all-pill interfaces, tiny grey labels, source/runtime/evidence collapsed into one badge, and a 3D hero that delays access to controls.

## Information frame

Every operator surface keeps these roles identifiable:

1. `context`: selected scope, source, version, and freshness;
2. `takeaway`: current state in one plain sentence;
3. `evidence`: exact health, count, owner, route, or verification reference;
4. `action`: the smallest safe next step, with read-only or preview first;
5. `qualification`: HOLD, UNKNOWN, permission, historical-only, and rollback limits;
6. `navigation`: overview to drilldown to exact action without hiding recovery.

The homepage priority is `Master goals → Projects → Core routes → Attention → Recent evidence → Manual reviews`. Goal checkboxes are owner-local review marks with an append-only event history; they never mutate operational status. Deeper existing surfaces follow after that overview. Project lifecycle and priority come from the owner Notion snapshot; local roots, runtime, release, and evidence come from local source. Disagreement is visibly `DRIFT`, never silently reconciled.

## References

| Source | Evidence checked | Adopt | Avoid |
| --- | --- | --- | --- |
| Personal library `2026-08-13-reusable-cross-media-frame-and-design-layer` v1.0.0 | confirmed frame/design/adapter hashes | semantic hierarchy, provenance, privacy, adapter separation, bright Clear Signal roles | copying one medium's literal geometry |
| Personal library `2026-08-13-agenticfabworks-main-web-concept` | private screenshot and rights record | only the idea that a product mechanism should be visible immediately | dark marketing hero, gold CTA, distinctive composition/assets, card wall; redistribution is UNKNOWN |
| Impeccable `c8f476b330395031bc8f7a7aee8d848bc85c81e4` | active Operate guidance | one decisive first viewport, real states, bounded desktop/mobile finish pass | spectacle that obscures task or state |
| shadcn/ui `d4fc45b1fbabfccb7a6a4333d8004cf19481caa9` | active source registry | familiar button, disclosure, focus, disabled, dialog behavior | adding a React dependency to this vanilla surface |
| Open Design `34ad192de9e9656ecb02b901319aeb202c896070` | active source registry | token and catalog responsibility boundaries | importing an app or template wholesale |

## System

- Canvas: `#F3F7F7`; faint cool paper grain may be CSS-only and decorative.
- Surface: `#FFFFFF`; subtle grouping zone `#E8F0F1`; raised overlay `#FFFFFF`.
- Ink: `#102731`; muted ink `#566B74`; rule `#C6D4D8`.
- Accent/signal: `#007F8D`; soft signal `#D7F1F3`; focus `#005E69`.
- Transport/link: `#1557A0`, always underlined in prose.
- Verified: `#24764E`; partial/stale: `#8A5A00`; blocked: `#B42318`; unknown/inference: `#6656A8`.
- Status colors always include a label and shape or icon. Accent means current selection or signal, never success by itself.
- Typography: Pretendard or language-complete system sans for Korean/UI; system sans fallback for Latin; monospace only for paths, hashes, ports, identifiers, and tabular data.
- Type floor: 16px body where practical, 14px compact label minimum, 1.45–1.65 body line height, tabular numbers for comparable values.
- Spacing: 4px base; 8/12/16 internal grouping; 24 component rhythm; 40 section rhythm; 64 major surface break.
- Radius: 6px controls, 10px interactive surfaces, 14px sheets/dialogs. Tables and ledger rows use rules and tonal fields before containers or shadows.
- Depth: one restrained overlay shadow tier. No nested elevation and no decorative glow.
- Icons: simple functional glyph plus text; no emoji as the only label.
- Motion: 120–180ms control feedback, 180–260ms sheet/disclosure continuity, and one causal cyan evidence trace when fresh data arrives. Reduced motion removes travel and auto-pulse without hiding state.

## First viewport and signature moment

- Header: local-control identity, freshness, search, refresh, and narrow navigation trigger. It occupies only the height required by controls.
- Master goals: cumulative owner intent with search, status filter, deterministic sort, exact operational status, next action, evidence, and a separate personal review checkbox.
- Main ledger: active/important Projects rows with lifecycle, verified progress/confidence, priority, next action, source state, and drilldown.
- Core routes: four compact rows for integrated Web GPT 17841, Web GPT direct/rescue, OCX direct 10100, and Native direct. Health, configured source, installed runtime, and acceptance evidence are separate fields.
- Attention rail: exact blockers/HOLD/UNKNOWN and the smallest safe action.
- Evidence/review rail: recent evidence followed by manual Knowledge Review, priority outbox, and Local Access grant entry points.
- Signature moment: selection or fresh evidence illuminates one short cyan trace from source to current state to evidence; it never animates a fabricated numeric journey and has a static labeled equivalent.

## Component and state grammar

- Goal and project rows: summary-first ledger rows, not independent marketing cards. Detail uses native disclosure or an accessible sheet on narrow screens.
- Route state: configured source, installed version, live health, active owner, and acceptance evidence remain separate cells.
- Route state also exposes the exact active gate and browser/harness readiness. Offline health is `UNKNOWN`, never an implied idle state.
- Manual reviews: `preview → explicit confirmation → durable queued job/outbox`, with no Dashboard-owned background execution.
- Local Access: exact root, include/deny, preview counts, TTL, budgets, and correlation are visible before confirmation. No convenience whole-home alias. Codex session excerpts require a second one-use approval.
- Loading: bounded skeleton/placeholder with the exact region named.
- Empty: explains why empty is safe or what creates the first record.
- Partial/stale: preserves last evidence and names the missing current check.
- Permission denied: names TCC or policy boundary and explicitly prohibits fallback/privilege bypass.
- Error/offline: preserves unaffected routes and offers component-scoped retry or rollback evidence.
- Success: names the verified outcome and evidence time; command success alone is not a PASS.
- Web GPT monitor configuration: one compact form in Monitoring with a fixed `GPT · 7개 대화` scope row, clear save/readback state, bounded native cadence and threshold controls, and a disclosure for editable continuation messages. Explain that saved settings are consumed by Codex heartbeat and do not imply the scheduler is active. Keep user-authored text as form values, not HTML, and retain the previous saved settings after invalid input.

## Responsive and accessibility

- 1280px and above: project ledger plus evidence/review rail; route strip remains visible without horizontal scanning.
- 768–1279px: one primary column with attention and manual reviews immediately after Projects; navigation collapses without changing reading order.
- 320–767px: single-column ledger summaries, native disclosure/details, bottom or side sheet navigation, 44px primary targets, no hover-only control, no overlay covering a critical confirm/rollback action.
- At 200% zoom, content reflows without two-dimensional scrolling except evidence tables that retain row labels and a textual summary.
- Keyboard: skip link, visible high-contrast focus, logical landmarks/headings, Escape close with focus restoration, Enter/Space parity, and keyboard project reorder equivalent to drag.
- Long Korean/English, zero/error/partial datasets, reduced motion, and offline API states are required fixtures.

## Existing truth and boundaries

- Existing vanilla HTML/CSS/JS and CSP remain authoritative; do not migrate framework or add CDN assets.
- `server.mjs` remains loopback/same-origin/JSON guarded. `public/app.js` remains the only coordinator-owned API wiring surface.
- Existing action dialog, diagnostic result dialog, planner, monitoring, tool search, architecture, and route recovery behavior must survive the redesign.
- Public output contains no personal design-library path, private screenshot, raw prompt/session content, credential, browser state, or third-party asset.
- External web auth, D1, DNS, deployment, GitHub/npm/release, and public publishing remain HOLD without separate approval.

## Provenance

- `existing_truth`: current public HTML/CSS/JS behavior, local API contracts, the handoff parity inventory, and live status boundaries.
- `verified_reference`: personal cross-media frame v1.0.0 and the exact active design-source commits listed above.
- `project_decision`: Luminous Control Ledger composition, bright ceramic palette, cyan evidence path, and row-first hierarchy.
- `UNKNOWN`: rights for the private AgenticFabWorks concept image; it is an anti-reference/pattern observation only and is not copied.

## Validation

- Source: schema, unit, integration, path escape, symlink, sensitive-path, redaction, and full regression tests.
- Parity: every incumbent section, action, ID binding, recovery path, and tool remains reachable before homepage replacement is accepted.
- Accessibility: semantic landmarks, keyboard/focus/dialog, 200% zoom, reduced motion, 320px, long Korean, loading/empty/error/partial/stale/permission/offline.
- Browser: current runtime only after the exact-zero integration gate; desktop and mobile in one batched pass, console/network/overflow included.
- HOLD: no live/browser PASS is inherited from historical evidence, and no runtime apply occurs until the component-specific idle gate is proven.

## Recovery control

The first element in `#troubleshoot` is a single high-salience recovery card, not another diagnostics grid. It shows plain-language state, exact component, freshness, and one 48px action. The button is disabled for ACTIVE, UNKNOWN, missing pointer, failed dry-run, completed dispatch, and uncertain dispatch; color is never the only state cue. The existing preview dialog remains the deliberate second step, while `aicc restore` remains available when the dashboard itself is unavailable.

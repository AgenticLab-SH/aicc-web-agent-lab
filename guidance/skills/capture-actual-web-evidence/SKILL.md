---
name: capture-actual-web-evidence
description: 실제 렌더링된 웹 흐름의 스크린샷·GIF와 출처를 기록한다. 목업을 운영 증거로 쓰지 않는다.
---

# Capture Actual Web Evidence

Record the product that actually ran. Keep the source revision, environment, interactions, assertions,
screenshots and claim boundary connected.

## Workflow

1. Read the owning repository instructions, build contract, current source and deployment boundary.
2. Define the exact claim each capture supports. Use `implemented`, `runtime_verified`,
   `authenticated_only`, `development` or `unknown`; do not collapse them into `working`.
3. Choose the runtime:
   - Use a production-like local build and an isolated browser by default.
   - Use a deployed URL only when current deployment behavior is the claim and pass `--allow-remote`.
   - For existing login or account state, use `choose-browser-session` and `browser-qa`; do not point the
     bundled isolated-browser script at a user profile.
4. Remove or replace personal data, secrets, copyrighted problem content and account identifiers before
   recording. Use clearly labelled test data when data is needed to exercise the real UI.
5. Write a small declarative scenario and run `scripts/capture_web_evidence.mjs`. Read
   [scenario format and evidence contract](references/evidence-contract.md) when creating the scenario.
6. When visitors need guidance, write a storyboard and run `scripts/compose_instructional_evidence.mjs`.
   Keep product pixels in captured screenshots; add only explanatory boxes, arrows, labels and neutral
   placeholder panels. The composition manifest must preserve every source image hash.
7. Inspect every frame, GIF and manifest. Reject stale UI, clipped controls, fake data presented as live,
   unrelated tabs, browser chrome with private information, or a claim that exceeds the captured flow.
8. Put selected public-safe assets in the owning repository and add a nearby caption with runtime,
   test-data and verification limits. Keep raw private captures outside public output.
9. Run the repository build and browser QA again after embedding the assets.

When a protected app needs an actual internal-screen capture, `authenticateLocal` may bootstrap only an
isolated loopback server with ephemeral environment credentials and public-safe test data. The action is
fail-closed for remote or cross-origin endpoints and records only environment variable names.

For a long landing page or many routes, do not inspect one hand-taken screenshot at a time. Read
[the scroll audit contract](references/scroll-audit.md), run `scripts/audit_scroll_surfaces.mjs`, and use its
bounded viewport tiles plus compact JSON/HTML report to choose only the frames that need visual review.

## Capture command

```bash
node scripts/capture_web_evidence.mjs \
  --url http://192.0.2.1:4173/ \
  --scenario /absolute/path/scenario.json \
  --out /absolute/path/evidence \
  --source-root /absolute/path/repository \
  --gif actual-workflow.gif \
  --poster actual-workflow.png
```

The scenario requires a `title` and one truth status in `claimState`. The script launches an isolated Chrome/Edge profile, supports bounded local authentication plus selector-based wait, click, type, select,
scroll, key press, assertion and capture steps, and writes PNG frames plus `evidence.json`. It never accepts
arbitrary page JavaScript. Remote capture requires `--allow-remote`; sensitive URL parameters and password
input are rejected.

For a real popup flow, set `nativeWindow: true`, use `clickAndSwitchPopup`, measure the protected work area,
and use `assertMeasure` after opening the side panel. `nativeCaptureHeight` may normalize the evidence image
height while preserving measured native width changes.

## Instructional composition command

```bash
node scripts/compose_instructional_evidence.mjs \
  --storyboard /absolute/path/storyboard.json \
  --out /absolute/path/instructional-evidence \
  --source-root /absolute/path/repository \
  --gif actual-instructions.gif \
  --poster actual-instructions.png
```

The storyboard uses actual local screenshot files and declarative `box`, `arrow` and `label` annotations.
It can add a neutral `E-book or PDF`-style explanatory panel, but it must not recreate product controls or
claim that annotation motion is product behavior. `composition.json` records the derivative boundary and
SHA-256 of every source image.

## Scroll surface audit command

```bash
node scripts/audit_scroll_surfaces.mjs \
  --manifest /absolute/path/scroll-audit.json \
  --out /absolute/path/scroll-audit-output
```

The runner visits every declared route at 1-4 bounded viewports, scrolls through the real document or a
declared scroll container, captures each stop once, and reports horizontal overflow, clipped text, fixed
overlap, undersized controls, reduced-motion leaks, runtime failures, font drift and inflated Korean copy.
It writes `report.json` for agents and `report.html` for a human contact sheet. Remote URLs require
`--allow-remote`; use production-like local builds for private or authenticated surfaces.

## Truth and privacy gates

- Do not label a static composition, DOM-unhidden panel, generated image or hand-animated sequence as an
  actual product workflow.
- Publish an annotated derivative only with a visible `actual screen + explanatory graphics` distinction;
  boxes, arrows, labels and placeholder panels are guidance, not captured product UI.
- A local fixture may supply test data or a test credential only when the production code path and rendered
  component remain unchanged. Label it `actual UI, test data`; never label it a production transaction.
- Do not use an authenticated screenshot as proof of server write, email delivery, payment, deployment or
  cross-system completion unless that outcome is separately observed.
- Do not expose email, name, tokens, request IDs, customer content, browser profiles or private URLs in the
  frame, filename, manifest or caption.
- Prefer a still fallback for `prefers-reduced-motion` when publishing a GIF.

## Completion evidence

Return the source revision and dirty state, runtime URL class, scenario, assertions, frame/GIF paths,
console and network failures, inspected viewports, public-safe asset paths and every remaining
`authenticated_only`, `development`, `unknown` or `HOLD` boundary.

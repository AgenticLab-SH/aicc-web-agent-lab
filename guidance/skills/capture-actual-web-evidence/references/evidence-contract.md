# Scenario format and evidence contract

## Scenario JSON

```json
{
  "title": "Timer to score",
  "claimState": "runtime_verified",
  "viewport": { "width": 1440, "height": 900, "deviceScaleFactor": 1 },
  "steps": [
    { "action": "waitFor", "selector": "#start", "timeoutMs": 10000 },
    { "action": "capture", "name": "ready", "durationMs": 900 },
    { "action": "click", "selector": "#start" },
    { "action": "wait", "ms": 500 },
    { "action": "assertVisible", "selector": "#running" },
    { "action": "capture", "name": "running", "durationMs": 1200 }
  ]
}
```

`title` and `claimState` are required. Use exactly one claim state from the matrix below.

Supported actions:

- `wait`: wait `ms`.
- `waitFor`: wait for a visible `selector`, optionally with `timeoutMs`.
- `authenticateLocal`: POST an isolated local server's same-origin login endpoint using the
  environment variables named by `usernameEnv` and `passwordEnv`, then reload. It is rejected for
  remote URLs, cross-origin/query endpoints and missing credentials; values never enter the scenario
  or evidence manifest.
- `click`: click a visible `selector`.
- `clickAndSwitchPopup`: click with a browser pointer and attach to the resulting real popup target. Requires
  `nativeWindow: true`.
- `type`: replace a non-password input or textarea value and dispatch input/change events.
- `select`: choose `value` in a select and dispatch change.
- `scroll`: scroll a `selector` into the center of the viewport.
- `press`: send one key such as `Tab`, `Enter`, `Escape`, `ArrowLeft` or `ArrowRight`.
- `assertVisible`: fail unless `selector` is rendered and visible.
- `assertText`: fail unless `selector` text contains `contains`.
- `measure`: store a selector rectangle under `name`.
- `assertMeasure`: compare the current rectangle with a prior `measure` of the same `name`; use `fields`
  such as `width` and `height`, plus an optional pixel `tolerance`.
- `capture`: save one frame named by `name`; `durationMs` controls GIF hold time.

Selectors and typed values stay in the local scenario. `evidence.json` records selectors but always redacts
typed values. Do not put credentials, personal data or production tokens in a scenario.

For a protected production-like fixture, keep ephemeral credentials outside Git:

```json
{
  "action": "authenticateLocal",
  "endpoint": "/api/v2/auth/login",
  "usernameEnv": "EVIDENCE_LOCAL_USER",
  "passwordEnv": "EVIDENCE_LOCAL_PASSWORD",
  "usernameField": "user_id"
}
```

This action is only for a loopback server with test data. It must not authenticate to production, reuse a
browser profile, or prove an external account-side effect.

## Claim matrix

| Status | Required evidence | Allowed wording |
| --- | --- | --- |
| `implemented` | Current source path and code review | 구현됨 |
| `runtime_verified` | Current build, interaction and observed result | 브라우저에서 확인 |
| `authenticated_only` | Implemented path, but live account/server round trip not observed | 운영 인증 필요 |
| `development` | Source or product record explicitly says unfinished | 개발 중 |
| `unknown` | Evidence is insufficient or contradictory | 현재 확인 불가 |

Source review does not promote `implemented` to `runtime_verified`. A screenshot of a button does not prove
its server-side outcome. A test credential may prove the real client path while server effects remain
`authenticated_only`.

## Publication checklist

- Crop only to remove irrelevant browser chrome; do not splice or redraw product state.
- Preserve legible focus, errors and status text when they are part of the claim.
- Record viewport, source revision, capture time and whether test data was used.
- Inspect every frame for private data, copyrighted source material, debug overlays and stale branding.
- Pair GIFs with a still image for reduced-motion users.
- Keep the raw evidence and the public derivative distinguishable.

## Native popup example

```json
{
  "title": "Popup side panel preserves work area",
  "claimState": "runtime_verified",
  "nativeWindow": true,
  "nativeCaptureHeight": 807,
  "viewport": { "width": 1512, "height": 892, "deviceScaleFactor": 1 },
  "steps": [
    { "action": "clickAndSwitchPopup", "selector": "#open-popup" },
    { "action": "capture", "name": "popup-ready" },
    { "action": "measure", "name": "work-area", "selector": ".work-area" },
    { "action": "click", "selector": "#open-panel" },
    { "action": "assertMeasure", "name": "work-area", "selector": ".work-area", "fields": ["width", "height"], "tolerance": 1 },
    { "action": "capture", "name": "panel-open" }
  ]
}
```

## Instructional storyboard

Use `scripts/compose_instructional_evidence.mjs` only after raw captures pass. Each scene requires one
`image.source`; its placement may use `x`, `y`, `width`, `height`, `fit` and `position`. Optional
`panels` are clearly explanatory regions for material outside the product, while `annotations` accept only:

- `box`: `x`, `y`, `width`, `height`, optional `color`, `radius`, `delay`.
- `arrow`: `from`, `to`, optional `text`, `color`, `delay`.
- `label`: `x`, `y`, `text`, optional `step`, `detail`, `width`, `theme`, `color`, `delay`.

The composer never changes source product pixels. It writes a GIF, reduced-motion poster, individual motion
frames and `composition.json`. The manifest calls the result
`actual-screen-with-explanatory-overlays`, records source hashes and states the overlay boundary explicitly.

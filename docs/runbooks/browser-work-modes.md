# Codex browser work modes

## Purpose

Keep the user's interactive browser session separate from durable automation.
The discovery surface may contain personal state; the delivered automation
must be reproducible without Codex.

## Mode 0: Default interactive browser work

Use the background in-app Browser for ordinary UI and only for ChatGPT work that
the user explicitly calls `in-app Browser`. A request for `Web GPT` means the
separate Codex `chatgpt-web/*` route through 17841, not browser UI control.
Account order and workspace names come only from the
private coordination file; preserve unrelated sessions without reserving a Chrome port.
Use `Manage-CdpChromeSlotLease.ps1 -Action
Acquire` for profile-bound browser QA and provider-console setup. It selects
the least-loaded registered 9222/9223 slot, starts it without foreground activation, verifies
identity, and creates a new target. Each port may host several target leases.
Running listeners and pre-existing user tabs do not become agent-owned or block
the lease. Existing tabs never become agent-owned merely because their URL
matches the task.

For an explicitly requested in-app ChatGPT fallback, pass the account alias and workspace returned by private
coordination. Account routing selects a login identity, not an entitlement or
ownership claim. Each registered slot joins the eligible lease pool only after
its account/workspace identity is verified and its private usage permits the task.
Workflow-reserved slots never become general or Pro fallbacks. Port 9226 is the
separate on-demand isolated QA browser and never joins the authenticated pool.

Operate only on the returned `target_id`, set `BROWSER_AGENT_HOME` to its
returned task-local control directory, heartbeat before each action batch, and
release immediately after each browser-action interval. The target is created in the background; do not run
`tab-switch`, `select-tab`, or `Target.activateTarget`. Browser,
Chrome-extension, and Computer Use surfaces
count as CDP-backed only when they can bind that endpoint, profile, and target;
foreground-only surfaces must not run concurrently on the shared authenticated
slots. Otherwise use endpoint-capable control or report the limitation. When
configured target capacity is full, wait boundedly or report busy. Do not silently add overflow profiles or
fall back to a dormant browser or normal Chrome.

## Dormant browsers are not a work mode

Whale and CDP Whale 9335 are dormant. They are not a selection, fallback,
continuation, or wait path. Do not inspect their preserved profile or launch
them for ordinary work. A new explicit user request to restore the browser
family is maintenance work governed by
[`dormant-whale-recovery.md`](dormant-whale-recovery.md), after which this
document may be revised again.

## Mode 1: Build repeatable automation

Use this mode when the user wants a repeated workflow that should run later
without Codex.

### Discovery

1. Prefer an official API or connector when it is authoritative and sufficient.
2. When the workflow needs the user's existing cache, login, or web settings,
   use the matching registered CDP Chrome `9222` or `9223` profile.
3. Record stable role/name locators, navigation states, output schema, and
   failure evidence. Do not make the discovery browser the production runtime.

### Runtime contract

Deliver:

- Playwright code with stable semantic locators;
- configuration outside source code;
- checkpoint/resume and bounded retry behavior;
- structured stdout and manifest/output files;
- one-item or dry-run smoke mode;
- tests for parsing, state transitions, and critical selectors;
- `run.sh` and `run.ps1`, or equivalent Mac/Windows entrypoints;
- setup documentation and an example environment file;
- no password, cookie, token, or machine-specific absolute path in source.

For public/stateless work, the runtime owns an isolated Playwright browser
context. For this user's authenticated/profile-bound work, use the matching
registered CDP Chrome `9222` or `9223` profile so its existing cache, login, and
web settings remain available. The delivered entrypoint must start the
registered slot when needed, verify its process/profile/port identity, lease
only owned tabs, and fail clearly if the expected profile is unavailable.
Never point the runtime at the user's normal Google Chrome profile.

An existing shared CDP endpoint is the selected default for profile-bound
automation, not for portable/stateless automation. Use it only when the
workflow intentionally depends on the registered profile, AICC routing, or
coordinated Web AI tab leases.

### Completion gate

The work is complete only when a fresh shell can run the documented entrypoint,
the one-item smoke succeeds, representative output matches browser evidence,
and the next run can resume without an agent-owned tab.

## Browser routing

| Need | Surface |
|---|---|
| Ordinary web UI or explicitly requested in-app ChatGPT | Background in-app Browser |
| `Web GPT` / `웹 지피티` | Codex `chatgpt-web/*` route through 17841; not a browser mode |
| Stateless isolated browser QA | Agent Chrome 9226, start and stop on demand |
| Profile-bound console setup or authenticated QA | Registered agent CDP Chrome 9222/9223, plus verified 9224 when enabled, with a short target lease |
| Profile-bound automation discovery and testing | Matching verified CDP Chrome 9222/9223 |
| Explicit normal-Chrome handoff | Normal Google Chrome through Codex extension |
| Standalone public automation | Playwright-owned isolated context |
| Standalone authenticated/profile-bound automation | Registered CDP Chrome slot with verified launcher and lease |
| Non-intrusive background browser Computer Use | Isolated agent browser + loopback CDP + fail-closed user ON/OFF gate; see [background-computer-use.md](background-computer-use.md) |
| AICC account-routed Chrome batch | Registered CDP Chrome 9222/9223, plus verified 9224 when enabled |

## Extension placement

- Keep the ChatGPT Chrome Extension installed and enabled in exactly one
  authenticated Chrome profile selected by the private coordination file.
  Remove it from normal Chrome and every other CDP or QA profile so an
  extension-backed request cannot bind the wrong account silently.
- The selected profile may be a registered CDP Chrome slot only when the user
  explicitly chooses that persistent account route. Verify the extension
  transport against that exact profile after installation; do not fall back to
  another Chrome profile when it is unavailable.
- Never remove, disable, relocate, or alter Bonjourr while optimizing browser
  extensions.

---
name: repair-browser-launchers
description: 인증을 보존하며 Chrome 실행기의 신원·프로필·포트·아이콘·Dock을 복구한다. QA·Web GPT 제외.
---

# Repair browser launchers

Treat a launcher identity as the tuple `role + engine + app identity + profile +
port + icon`. Read [references/identity-contract.md](references/identity-contract.md)
before changing a launcher or its visible identity.

## Inspect before changing

Resolve current paths and ports from installed app metadata and
`~/.ai-control-center/guidance/coordination.toml`. Verify:

- app bundle or executable and OS identity;
- main browser process and complete launch arguments;
- user-data root and profile directory;
- CDP listener owner;
- Dock or taskbar target, label, and icon.

Registered authenticated slots are defined only by
`~/.ai-control-center/guidance/coordination.toml`. Resolve each slot's account
alias, profile root and port there; never copy personal aliases into this public
skill. The portable defaults use separate registered CDP Chrome profiles; the
private coordination file is authoritative.

Resolve the current HTTP/HTTPS handler, ordinary Dock target, active/dormant browser engines,
and recovery-only launchers from private coordination and live OS registration. Preserve those
observed choices; do not encode this machine's current browser state in public guidance. Restore
a dormant engine only after an explicit user request and its existing recovery runbook.

Do not swap registered account aliases, ports, or roots to make a failing task
appear healthy.

Stop if these disagree. Do not attach to another browser, port, or profile as a
fallback.

## Preserve the security boundary

- Keep normal and automation profiles in different user-data roots.
- Keep simultaneous CDP slots on different ports.
- Start the unchanged vendor browser through a lightweight launcher; do not
  clone or re-sign a profile-bearing browser engine.
- Never read, copy, reset, or delete cookies, passwords, tokens, profile
  databases, or unrelated extensions.
- Keep Windows-imported profiles as preservation material on macOS.

Use the bundled icon generator only for a verified launcher asset. Do not modify
the vendor browser icon in place.

When multiple browser automation instances share a vendor identity, macOS may group their
windows. Do not replace the live ordinary-browser Dock target or HTTP/HTTPS handler with an AICC
wrapper unless the user explicitly requests that exact identity change.

The shared, permission-minimal badge source is
`tools/platform/web-automation/extensions/aicc-cdp-port-badge`. A launcher may
reference this AICC path, but must keep its profile and account data outside the
repository.

## Preserve active work and browser lifecycle

Read `docs/runbooks/browser-resource-lifecycle.md` before changing a launcher's
start or exit behavior. A pinned Dock icon is only a shortcut; use the running
indicator plus exact process evidence to decide whether resources are still in
use.

- A controller may gracefully terminate only the exact vendor PID that it
  started during the current launch. Attaching to an already-running matching
  profile never transfers process ownership.
- For registered CDP Chrome, require page targets, unexpired target leases, and
  established CDP clients to remain absent across the documented bounded
  checks. Any unreadable lease, JSON, expiry, or client state is UNKNOWN and
  preserves the browser.
- `--disable-background-mode` prevents background apps from independently
  retaining Chromium but is not sufficient on macOS by itself. Use it only
  together with the owner-scoped graceful lifecycle contract.
- Never infer safe exit from CPU, RAM, keyboard inactivity, a timer alone, or
  the absence of an onscreen window. Do not use automatic `SIGKILL`, remove a
  profile, or stop an unrelated browser to clear a Dock indicator.

Source changes do not update installed launcher bundles. Before a live
replacement, prove the exact target is idle, take a bundle/plist recovery copy,
compile and test all affected launchers, replace only the affected bundle, and
re-verify identity, profile, port, listener ownership, and the vendor Chrome
HTTP/HTTPS default-handler contract.
Do not replace a launcher while its exact CDP listener still exists. A restarted
controller would attach without owning that older browser PID, so closing the
last window would correctly preserve the process and leave the Dock indicator on.

## Verify

Launch each changed entry and verify the OS identity, process path, profile
arguments, port owner, visible label, icon, and running indicator. Use Computer
Use for the final visual check when available, but do not accept UI appearance
without matching process and listener evidence.

For AICC-managed changes, create a recovery snapshot, edit the canonical AICC
source, run the matching browser identity checks, deploy only the affected
homes, and record the change.

Before replacing a registered launcher, unregister its exact live path with
LaunchServices. A recovery copy must not retain a terminal `.app` suffix: use
an exact leaf such as `CDP Chrome 9223.app.backup`, or place retired material
under a dated `.noindex` archive. Otherwise Spotlight and the Codex app picker
can expose the backup as a second installed browser even though only one Chrome
process is running. After cleanup, query both Spotlight and LaunchServices and
require exactly one canonical registration per active AICC bundle identifier.
Do not treat `ChromeRemoteDesktopHost` or its uninstaller as duplicate Chrome
profiles; they are separate installed applications.

After launcher replacement, inspect LaunchServices for duplicate browser bundle registrations.
Rebuild LaunchServices only after active AICC bundles are registered. Immediately verify that
both HTTP and HTTPS still resolve to the coordination SSOT's
`default_browser_bundle_id`; stop and
restore that exact handler if they do not.
Do not delete current profiles, dormant-engine profiles, imported preservation material, cookies,
password stores, or browser databases. Generated `runtime/browser-smoke` directories, empty test
browser roots, and unreferenced retired launchers may be moved to a dated `.noindex`
archive or Trash after exact-path and live-process checks.

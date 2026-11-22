# Human-readable agent terminals specification

## Authority and document roles

- Owner/lifecycle/last reviewed: workspace owner / active / 2026-09-06
- Source intent: specs/human-readable-agent-terminals/intent.md
- This specification: observable Windows terminal behavior and acceptance evidence
- Related authoritative documents: `guidance/directives/fragments/common.md` owns shared work rules; `guidance/skills/present-agent-terminal-status/SKILL.md` owns task routing; runtime code owns enforcement
- Supersedes: none

## Outcome

Agent background work is silent at the desktop, while every necessary agent-owned foreground terminal is immediately understandable to a Korean-speaking computer user and keeps showing truthful progress or elapsed time.

## User value

- User/problem: blank or unidentified terminals make normal agent work look broken or suspicious.
- Value promise: the user can identify, assess, and safely leave or close an agent terminal without guessing.
- Success signal: no direct-console background MCP task remains, and the foreground launcher renders Korean identity and live timing.

## Scope

### In
- Windows Codex hook subprocess console suppression.
- Windowless Workspace MCP scheduled tasks used by the local plugin.
- A reusable AICC foreground progress-terminal launcher and renderer.
- Shared agent guidance plus a plugin-local routing skill.

### Out
- User-created interactive shells and third-party plugin source.
- Invented percentages, fake ETAs, or protocol banners on stdout.

### Later
- Other operating systems may adopt platform-native launchers when a real blank-terminal defect is observed.

## Requirements

- **FR-001** — Unattended hooks, MCP servers, plugin protocol processes, and scheduled background services shall not open a visible terminal.
- **FR-002** — A necessary foreground wait terminal shall print a Korean identity and purpose immediately and keep a current step and elapsed time visible.
- **FR-003** — A foreground terminal shall show a percentage or ETA only when provided by a fresh progress signal, and shall label missing or stale signals honestly.
- **FR-004** — MCP and hook stdout shall remain reserved for their protocol; human presentation shall be outside the protocol process.
- **FR-005** — Existing owned local Workspace MCP tasks and the personal plugin shall be upgraded through their supported installers without changing unrelated tasks or marketplace entries.

## Scenarios

- **S-001 / background:** Given a Workspace MCP logon task, when Windows starts it, then the tunnel runs through a hidden host without a console window.
- **S-002 / foreground:** Given an agent operation with progress files, when the agent opens the AICC progress terminal, then a Korean title and identity appear before the wait loop and progress plus elapsed time refreshes.
- **S-003 / stale:** Given no fresh progress update, when the terminal refreshes, then it says the signal is stale or unavailable and does not display a false zero ETA.
- **S-004 / protocol:** Given a Codex hook or MCP stdio process, when it launches a child or reports protocol data, then it does not create a human terminal or mix a banner into stdout.

## Quality and boundaries

- Accessibility/responsive/performance/compatibility: one-line updates fit the current console width; Korean labels remain readable in PowerShell 7 and Windows Terminal; refresh is no faster than 250 ms.
- Security/privacy/data: titles and banners contain a bounded purpose label, not command lines, secrets, account identifiers, or raw MCP/hook payloads.
- Recovery/external actions: task repair backs up the exact prior XML; personal plugin updates use the marketplace cachebuster and reinstall workflow.

## Dependencies and risks

- Dependency/assumption: PowerShell 7, Node, and WScript are available on the current Windows host and are verified before installation.
- Risk/recovery: an invalid task replacement can stop the tunnel; the installer restores the prior task and hidden-launcher bytes on failure.

## UNKNOWN and HOLD

- HOLD: the separate secure external Workspace tunnel client exits with code 1 and `aicc workspace status` remains attention after the windowless task starts — resume when tunnel connectivity itself is requested — owner: Workspace operations. The local Codex plugin stdio MCP remains installed and this does not reopen a terminal.

## Acceptance evidence

| ID | Success criterion | Evidence |
| --- | --- | --- |
| **SC-001** | Workspace task XML uses WScript/hidden mode and preserves rollback | `node --test test/workspace-tunnel-launch-agent.test.mjs` |
| **SC-002** | Hook child execution suppresses a Windows console | `node --test test/notification-ack-hook.test.mjs` |
| **SC-003** | Foreground renderer and launcher show Korean identity, progress, stale state, and elapsed time | `node --test test/terminal-progress-renderer.test.mjs test/terminal-progress-launcher.test.mjs` |
| **SC-004** | The guidance skill and focused specification validate | skill and project-spec validators |
| **SC-005** | Installed owned tasks use the hidden policy and the local plugin source/cache match | both `install-windows-task.mjs status` results report `ok=true`, `hidden=true`, and `sourceMatches=true`; `codex plugin list`; plugin validation |

## Implementation outline

- Existing stack and boundaries to preserve: Node ESM, PowerShell 7, Task Scheduler XML, personal Codex marketplace, and AICC guidance deployment manifests.
- Intended touchpoints: Workspace task installer/tests, hook runner/test, progress renderer/launcher/tests, shared guidance, skill catalog, personal plugin source and installation.
- Key decisions and rationale: hide protocol/background processes; use a separate presentation terminal only for observable foreground waits so protocol streams remain clean.
- Rollout/recovery: dry-run, focused tests, task repair with automatic rollback, plugin cachebuster/reinstall, then live status probes.

# Human-readable agent terminals intent

- ID: INT-human-readable-agent-terminals-2026-09
- Status: delivered
- Owner: workspace owner
- Target: AICC agent guidance, Codex hooks, Workspace MCP/plugin runtimes, and Windows foreground wait terminals
- Supersedes: none

## Problem

Agent-owned hooks, waits, MCP services, or plugin helpers can leave a blank or unidentified terminal on the user's computer. A person cannot tell what opened it, whether work is progressing, or how long it has been running.

## Evidence

- The owner reported blank terminals opened for agent hooks or waits on Windows on 2026-09-06.
- The two installed Workspace MCP scheduled tasks were configured as interactive direct Node processes, while the existing progress renderer was not connected to any launcher.

## Desired outcome

Background protocol and service work opens no terminal. When a foreground terminal is genuinely required, it immediately identifies itself in Korean and continuously shows a truthful current step plus elapsed time and available progress.

## Affected users and systems

- Users: the person using the Windows computer while agents work
- Systems: shared agent guidance, Codex hooks, AICC Workspace MCP scheduled tasks, the local AICC Workspace plugin, and agent-owned foreground wait/callback terminals

## Constraints

- MCP and hook protocol stdout must remain machine-readable and must not receive human progress banners.
- Existing unrelated terminals, scheduled tasks, plugin settings, and user changes must be preserved.
- Percentages and remaining-time estimates may be shown only when backed by a progress signal; unknown values must be explicit.
- Background services remain hidden; a visible terminal is reserved for work the user may need to observe or interrupt.

## Out of scope

- Renaming terminals opened manually by the user.
- Changing third-party plugin packages or the Codex Desktop process launcher.
- Adding recurring polling, restart loops, or new external notifications.

## Success signals

- Workspace MCP logon tasks use a windowless launcher and no longer create a console window.
- Hook child processes explicitly suppress Windows console creation.
- A reusable visible-wait launcher shows a Korean title, purpose, current step, elapsed time, and evidence-backed progress without a blank interval.
- The policy is discoverable as active agent guidance and in the local Workspace plugin.

## Open questions

None

## Decision

- Accepted by the workspace owner in the 2026-09-06 implementation request, which explicitly defined the affected terminal behavior and authorized local hook, MCP, plugin, guidance, and skill changes.
- Delivered on 2026-09-06 after focused tests, local task repair, guidance deployment, and personal-plugin reinstall. The separate secure external tunnel connection still exits before readiness and is not treated as a terminal-presentation failure.

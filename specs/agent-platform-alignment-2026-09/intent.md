# Agent platform alignment intent

- ID: INT-agent-platform-alignment-2026-09
- Status: delivered
- Owner: AICC repository owner
- Target: open-AICC and the owner-local Codex home
- Supersedes: none

## Problem

The AICC agent platform has accumulated drift between official OpenAI and Anthropic guidance, its written baseline, managed skills, Codex permissions, discovery behavior, Knowledge Review coverage, and plugin status reporting. The pieces mostly compose, but several reports can say "ready" while important differences remain hidden.

## Evidence

- The recorded Codex permission baseline differs from the live user default.
- The baseline skill count and invocation policy differ from the deployment catalog and skill metadata.
- Intent acceptance can be inferred from a request made before an agent-authored intent is reviewable.
- Korean cold-skill searches miss substantial-change requests and can return unrelated results for tiny fixes.
- Knowledge Review omits the official Claude Academy intent playbook and masks internal source failures.
- Plugin status checks only required plugins while additional enabled plugins and account readiness remain unreported.
- The managed user-skill target differs from the current public Codex skill location.
- The Windows gate is blocked by one pre-existing overlong skill description.

## Desired outcome

AICC and the Codex home use one current, bounded, understandable operating model. User intent has an explicit priority, substantial work uses a concrete accepted intent, small work stays light, official sources cover the adopted practices, search behaves in Korean, permission defaults are safe and productive, and readiness reports disclose their limits and meaningful drift.

## Affected users and systems

- Users: the repository owner and agents working through Codex or AICC
- Systems: AICC guidance, deployment, Knowledge Review, plugin status, tests, baseline documents, and owner-local Codex configuration and managed skills

## Constraints

- Preserve unrelated dirty work, unmanaged skills, plugins, accounts, credentials, sessions, routes, and application state.
- Use official first-party documentation for current platform behavior.
- Keep source collection manual-only and never auto-promote external text into guidance.
- Keep permission changes reversible and bounded to the owner-local Codex defaults.
- Do not add a global hook for a judgment that cannot be enforced without false positives.

## Out of scope

- Uninstalling plugins or disconnecting accounts without a separate exact capability decision.
- Rewriting unrelated project skills or historical feature documents.
- Enabling Claude as a default deployment target.
- Creating a background documentation scheduler.

## Success signals

- Current official behavior, local baseline, and effective Codex defaults agree.
- A concrete intent must be reviewable before acceptance; large and tiny Korean prompts route correctly.
- Claude Academy intent guidance is an exact bounded Knowledge Review source.
- Internal crawler failures retain a safe diagnostic identity and bulk changes are visible without being silently ignored.
- Plugin status reports required, extra, disabled, feature, and account-observation scope separately.
- Managed Codex skills use the current official user location with a tested, ownership-safe migration.
- Focused tests, guidance deployment checks, a fresh skill-discovery canary, and the Windows gate pass.

## Open questions

- None.

## Decision

- Accepted on 2026-09-06 by the repository owner after reviewing the concrete platform audit and directing that all findings be improved to the current best standard.
- Delivered on 2026-09-06 after focused contracts, live post-reads, managed-home discovery, and the full Windows gate passed.

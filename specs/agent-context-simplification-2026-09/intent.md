# Agent context simplification intent

- ID: INT-agent-context-simplification-2026-09
- Status: delivered
- Owner: AICC repository owner
- Target: open-AICC and the owner-local Codex guidance deployment
- Supersedes: none

## Problem

The previous platform alignment established current sources and safe defaults, but the remaining guidance ecosystem has not been measured end to end against the behavior of the current model. A stale inventory path, overlapping workflow language, and historical counts can make a healthy deployment look broken or cause a capable model to load more instruction than the task needs.

## Evidence

- The initial live skill inventory reported all 15 managed active skills present at that point as missing because it still checked the legacy `.codex/skills` root after deployment moved to `.agents/skills`.
- Active skill descriptions are always visible unless invocation policy hides them, while full bodies are loaded only when selected; the current inventory does not report either budget.
- `run-evidence-gated-ai-development` repeats intent/spec responsibilities now owned by `develop-from-project-spec` and can route ordinary security-related work too broadly.
- Baseline documents preserve old inventory totals and MCP assumptions that no longer match the current CLI post-read.
- GPT-6 Astra is more sensitive to conflicting skill and `AGENTS.md` instructions and tends to over-test small changes, so stale or duplicated guidance now has a higher operational cost.

## Desired outcome

Every always-on instruction and discoverable workflow has one clear responsibility, current measurements, and a documented reason to exist. Deterministic tooling reports the real user-skill root and context budget, substantial work composes intent and execution without duplicate ownership, and MCP/plugin documentation reflects current live topology without changing healthy external connections.

## Affected users and systems

- Users: the repository owner and agents using Codex or AICC
- Systems: global guidance, active and cold skills, skill inventory tooling, plugin/MCP status documentation, tests, and the owner-local managed skill deployment

## Constraints

- Preserve unrelated dirty work and all user-managed skills, plugins, MCP connections, accounts, routes, credentials, sessions, and browser state.
- Use first-party OpenAI and Anthropic documentation for current model and extension behavior.
- Keep semantic keep/revise/retire decisions in review documents; automate only deterministic paths, counts, budgets, hashes, and policy fields.
- Do not force GPT-6 Astra into a local Codex host until the host's own model catalog exposes it.

## Out of scope

- Plugin uninstall, account disconnect, MCP disablement, Desktop restart, model-route mutation, or Claude default deployment.
- Rewriting historical dated reviews as if they were current state.
- Adding a global hook or scheduled cleanup job.

## Success signals

- The inventory recognizes `.agents/skills`, reports zero managed delivery issues, and separates implicit description cost from deferred bodies and explicit-only skills.
- Active/cold placement and workflow descriptions have no unresolved ownership conflict.
- The intent/spec skill owns goals and requirements; the long-running execution skill owns checkpoints, writer boundaries, intervention, and evidence.
- Current MCP and plugin topology, retained boundaries, and non-actions are documented from live CLI evidence.
- Source, generated directive, owner-home deployment, focused tests, intent validators, and the Windows repository gate pass.

## Open questions

- None.

## Decision

- Accepted on 2026-09-06 by the repository owner through the explicit request to find and improve excessive or outdated guidance, skills, MCP/plugin setup, documents, and instructions, while preserving the existing bounded operating model.
- Delivered on 2026-09-06 after canonical/home guidance post-read, live skill/plugin/MCP inspection, focused tests, intent/spec validation, and the complete Windows verification gate passed.

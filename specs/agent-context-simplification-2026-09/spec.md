# Agent context simplification specification

## Authority and document roles

- Owner/lifecycle/last reviewed: AICC repository owner, active, 2026-09-06
- Source intent: specs/agent-context-simplification-2026-09/intent.md
- This specification: observable context, discovery, ownership, and documentation contracts
- Related authoritative documents: `docs/agent-context-optimization.md`, `docs/agent-platform-baseline.md`, `guidance/config/agent-catalog.toml`
- Supersedes: none

## Outcome

AICC exposes compact, non-conflicting guidance and accurately reports the context and capability surfaces that Codex actually loads.

## User value

- User/problem: stale reports and overlapping guidance can cause unnecessary pauses, tests, or configuration changes.
- Value promise: agents find the right workflow with less noise and can verify deployment without false alarms.
- Success signal: the real managed skill tree is clean, ownership is explicit, and all affected gates pass.

## Scope

### In

- Codex global directive and active/cold skill policy
- Skill inventory root detection and context-cost metrics
- Intent, long-running execution, and risk-workflow composition
- Current plugin/MCP topology documentation
- Dated review, baseline, optimization playbook, and current project context

### Out

- External plugin, connector, account, MCP, route, or model mutation
- New hook, automation, or duplicate status system

### Later

- Switch the Codex default to GPT-6 Astra only after the local host catalog exposes it and a separate route canary succeeds.

## Requirements

- **FR-001** — The skill inventory shall treat `$HOME/.agents/skills` as the current user delivery root while separately observing legacy `$CODEX_HOME/skills` and system/plugin roots.
- **FR-002** — The inventory shall report implicit active count and description characters, explicit-only count, deferred skill-body bytes, legacy managed copies, and delivery issues without treating body size as startup context.
- **FR-003** — Active and cold placement shall preserve repeated high-value entrypoints, keep rare workflows searchable, and avoid broad or overlapping descriptions.
- **FR-004** — `develop-from-project-spec` shall own intent and specification; `run-evidence-gated-ai-development` shall not create competing requirements and shall route only long-running or multi-writer execution.
- **FR-005** — Global guidance shall remain within its existing byte/line budget and contain only cross-project behavior that cannot be enforced more reliably elsewhere.
- **FR-006** — Plugin and MCP documentation shall distinguish live external capability, workflow guidance, packaging, native tools, and retained compatibility transports; no live capability may be removed from name similarity alone.
- **FR-007** — Current documentation shall use live counts and mark dated observations as snapshots rather than current invariants.
- **FR-008** — Managed guidance shall deploy from canonical source to the owner home and pass hash, discovery, focused, and Windows gates.

## Scenarios

- **S-001 / current root:** Managed skills exist only in `.agents/skills`; inventory reports zero delivery issues.
- **S-002 / legacy preservation:** An unmanaged skill exists under `.codex/skills`; inventory keeps it user-owned and does not call it a managed duplicate.
- **S-003 / explicit-only:** An active skill has `allow_implicit_invocation: false`; inventory excludes its description from implicit startup cost and reports it separately.
- **S-004 / substantial work:** A cross-cutting request loads intent/spec guidance first and uses the execution skill only for checkpoints, ownership, intervention, and evidence.
- **S-005 / ordinary fix:** A small single-writer change does not trigger a long-running orchestration checklist or broad tests.
- **S-006 / capability overlap:** Multiple live browser transports are retained when they expose different host surfaces or compatibility roles; documentation records the distinction and current observation limit.

## Quality and boundaries

- Compatibility: Windows-first paths and optional Claude delivery remain supported.
- Security/privacy/data: owner-local absolute paths stay in owner-only inventory; no tokens, account data, or browser state enter repository docs.
- Recovery/external actions: source changes recover through Git; managed-home changes recover through the existing deployment manifest.

## Dependencies and risks

- The Codex app can expose a newer plugin or model catalog after this review; live status remains authoritative.
- Semantic trigger quality cannot be proven by counts alone, so descriptions and positive/near-miss cases still require review.

## UNKNOWN and HOLD

- HOLD: GPT-6 Astra is in the official API guide but absent from the current local Codex host model list; model switching requires a separate supported-route canary.

## Acceptance evidence

| ID | Success criterion | Evidence |
| --- | --- | --- |
| **SC-001** | FR-001~FR-002 pass modern-root, legacy, and explicit-only fixtures and a live inventory post-read. | `node --test test/skill-ecosystem.test.mjs` and live scanner output |
| **SC-002** | FR-003~FR-005 pass description, trigger, intent, and directive checks. | focused guidance/intent tests and `aicc guidance check` |
| **SC-003** | FR-006~FR-007 match current `codex mcp list --json`, plugin status, and dated documentation. | CLI post-read and document review |
| **SC-004** | FR-008 passes deployment and the complete Windows gate. | `npm run verify:windows` |

## Implementation outline

- Extend the existing skill ecosystem inspector instead of adding a second context audit tool.
- Narrow the execution skill and its trigger contract around the already deployed intent skill.
- Keep live capability changes observational because current transports have distinct ownership and no verified redundancy removal canary.
- Update canonical documents and deploy managed guidance once focused checks pass.

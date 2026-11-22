# Agent platform alignment specification

## Authority and document roles

- Owner/lifecycle/last reviewed: AICC repository owner, active, 2026-09-06
- Source intent: specs/agent-platform-alignment-2026-09/intent.md
- This specification: observable alignment and migration contracts
- Related authority: `docs/agent-platform-baseline.md`, `guidance/`, owner-local live status
- Supersedes: none

## Outcome

The agent platform exposes one consistent current policy across instructions, skills, documentation review, deployment, permissions, and readiness reporting while preserving separate capability and recovery boundaries.

## User value

The owner can ask Codex or AICC to do substantial work without hidden policy drift, unsafe global defaults, duplicate managed skills, or a misleading ready status.

## Scope

### In

- Astra-aligned common guidance and proportionate verification
- Concrete intent acceptance and skill composition rules
- Korean cold-skill discovery behavior
- Claude Academy Knowledge Review coverage and safer crawl diagnostics
- Plugin topology reporting
- Current Codex user-skill location and ownership-safe migration
- Owner-local Codex default permissions
- Baseline, review, context, and relevant tests

### Out

- Plugin uninstall, account connection, publication, route, or credential mutation
- A global intent hook across unrelated repositories
- Automatic source promotion or recurring review jobs

## Requirements

- **FR-001** — Explicit user instructions must outrank skill guidelines while system and tool boundaries remain effective; testing and delegation rules must be proportionate and unambiguous.
- **FR-002** — An agent-authored intent can be accepted only after its concrete outcome and boundaries are reviewable; an earlier broad implementation request authorizes drafting but not retroactive acceptance.
- **FR-003** — The intent skill must compose in a declared order with implementation, high-risk, and evidence skills without duplicate approval gates.
- **FR-004** — Korean substantial-change searches must find the intent workflow, while tiny-fix searches must not return unrelated workflows from weak body-token matches.
- **FR-005** — Knowledge Review must cover the exact official Claude Academy AI-Native SDLC course path, preserve manual-only boundaries, expose safe internal diagnostics, and flag unusually broad source changes for review.
- **FR-006** — Plugin status must distinguish required readiness, extra enabled plugins, disabled installations, feature drift, and unobserved account connections; extras are informational unless policy explicitly forbids them.
- **FR-007** — Managed Codex user skills must deploy to the current official `$HOME/.agents/skills` location and retire only manifest-owned copies from the legacy root after the new root is verified.
- **FR-008** — Codex defaults must use the current low-risk local automation preset: `workspace-write`, `on-request`, and user review, while the exact prior values remain recoverable.
- **FR-009** — Baseline and review documents must describe current source coverage, permission defaults, skill counts, invocation policy, plugin-status semantics, and remaining HOLDs accurately.
- **FR-010** — The pre-existing skill-description violation must be corrected without changing that skill's operational scope.

## Scenarios

- **S-001:** A Korean request for a new cross-cutting feature ranks `develop-from-project-spec` first.
- **S-002:** A Korean one-character typo request does not surface image generation or the intent workflow.
- **S-003:** A broad request before a generated intent leaves it draft; a later instruction referring to the reviewable proposal may accept it.
- **S-004:** Plugin status remains ready when allowed extras exist but reports their exact IDs and the fact that account connection was not checked.
- **S-005:** A source-internal failure has a stable diagnostic ID without leaking a path, body, credential, or stack.
- **S-006:** A source changing at least 80% of known pages emits a bulk-change review signal and still preserves every changed URL.
- **S-007:** Skill migration copies managed skills to the official root and removes only unchanged manifest-owned legacy copies, preserving unmanaged folders.

## Quality and boundaries

- Security: least-privilege workspace default, exact-host source policies, no secrets in diagnostics or repository files.
- Compatibility: Windows PowerShell deployment and existing optional Claude target remain supported.
- Recovery: Git restores repository policy; the Codex config backup restores owner-local permissions; deployment manifests prove skill ownership.
- Context: no duplicate skill copies remain in effective user discovery after migration.

## Dependencies and risks

- Official product behavior can change after this dated review; Knowledge Review remains manual and source-bounded.
- Current tasks may receive a host permission override that differs from the user default.
- Plugin installation does not prove account connection, so status must keep that field explicitly unobserved.

## UNKNOWN and HOLD

- UNKNOWN: effective permission-profile visibility is not yet implemented across every task host.
- HOLD: plugin account authentication, uninstall, and exact route consolidation require separate user-scoped transactions and are outside this change.

## Acceptance evidence

| ID | Success criterion | Evidence |
| --- | --- | --- |
| **SC-001** | FR-001~FR-004 pass focused instruction, intent, and Korean routing tests. | Node guidance and intent tests plus intent validators |
| **SC-002** | FR-005 passes registry, crawler, and live bounded source checks. | Knowledge Review policy/crawler tests and exact-source run |
| **SC-003** | FR-006 reports current plugin topology without calling extras drift by default. | Codex plugin adapter tests and live status post-read |
| **SC-004** | FR-007 deploys and validates the official root while preserving unmanaged legacy folders. | PowerShell deployment fixtures, plan/deploy/check, and fresh app-server skill list |
| **SC-005** | FR-008 live config matches the official low-risk preset and has a recovery copy. | Config post-read and Codex config parse/status canary |
| **SC-006** | FR-009~FR-010 and all affected code pass the repository Windows gate. | `npm run verify:windows` |

## Implementation outline

- Extend existing guidance, deployment, status, and Knowledge Review components rather than add a parallel control plane.
- Keep plugin extras observational and source promotion manual.
- Use manifest ownership for the one-time skill-root migration.
- Do not add an intent hook because "substantial" is a semantic decision; deterministic validators remain required after the skill is selected.

# Canonical project specification

Use this template for `<git-root>/SPEC.md` or a focused `specs/<change>/spec.md`. Keep it concise and replace prompts with repository-specific facts. Existing equivalent sections may be renamed, but the validation anchors and IDs must remain discoverable.

```markdown
# <Product or change> specification

## Authority and document roles

- Owner/lifecycle/last reviewed: <who owns this contract, active/archived/deprecated, current review date>
- Source intent: <specs/change/intent.md for a focused change, or none for the root product map>
- This specification: <verifiable behavior, edge cases, acceptance evidence>
- Related authoritative documents: <PRODUCT/DESIGN/TESTING/architecture/controller links and their non-overlapping roles>
- Supersedes: <older same-purpose specification, or none>

## Outcome

Who gets what observable outcome? State the current product contract in one paragraph.

## User value

- User/problem: <who is blocked by what>
- Value promise: <what becomes faster, safer, clearer, or newly possible>
- Success signal: <behavior or metric showing the value exists>

## Scope

### In
- <behavior, route, component, API, or data boundary>

### Out
- <explicit non-goal or external mutation>

### Later
- <accepted but not in the current implementation scope, plus revisit condition>

## Requirements

- **FR-001** — The system shall <observable behavior>.
- **FR-002** — When <failure or edge input>, the system shall <observable response/recovery>.

## Scenarios

- **S-001 / normal:** Given <state>, when <action>, then <result>.
- **S-002 / edge:** Given <state>, when <failure/empty/permission/offline>, then <safe result and next action>.

## Quality and boundaries

- Accessibility/responsive/performance/compatibility: <measurable contract>
- Security/privacy/data: <what is protected and where enforcement lives>
- Recovery/external actions: <what is not changed without a separate decision>

## Dependencies and risks

- Dependency/assumption: <observable dependency and how it is checked>
- Risk/recovery: <failure impact, prevention, rollback or safe fallback>

## UNKNOWN and HOLD

- UNKNOWN: <unverified fact> — verify with: <evidence> — owner: <person/task>
- HOLD: <observed blocking fact> — resume when: <condition> — owner: <person/task>
- If none, write `None` rather than deleting this section.

## Acceptance evidence

| ID | Success criterion | Evidence |
| --- | --- | --- |
| **SC-001** | <observable result linked to FR-001> | `<test command>` or <browser/API/manual flow> |
| **SC-002** | <edge/recovery result linked to FR-002> | `<test command>` or <browser/API/manual flow> |

## Implementation outline

- Existing stack and boundaries to preserve: <facts from the repository>
- Intended touchpoints: <files/modules/contracts, not speculative code>
- Key decisions and rationale: <only choices that change implementation>
- Rollout/recovery: <when applicable>
```

For a large feature, keep root `SPEC.md` as the durable product map and add:

```text
specs/<change>/
├── intent.md # accepted what/why and boundaries
├── spec.md   # slice-specific behavior, FR/SC, scenarios
├── plan.md   # architecture, interfaces, data, migration/recovery
└── tasks.md  # ordered tasks, owned paths, FR/SC, verification
```

Avoid work logs, raw research dumps, chat transcripts, generated command output, and secret or personal data. One review date and the intent decision are allowed.

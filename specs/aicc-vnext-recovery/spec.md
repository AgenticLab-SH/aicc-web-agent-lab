# AICC vNext recovery specification

## Authority and document roles

- Owner/lifecycle/last reviewed: demo-owner, active, 2026-09-14
- Source intent: specs/aicc-vnext-recovery/intent.md
- This specification: durable attempt and emergency-stop behavior
- Related authoritative documents: `docs/final-aicc-recovery-and-consolidation-plan.md`
- Supersedes: none

## Outcome

The owner can inspect, stop, reconcile, and later apply AICC-owned component changes
without a crash or restart silently repeating an uncertain side effect.

## User value

- User/problem: AICC helpers can restart or lose the outcome boundary.
- Value promise: one durable truth for each exact component attempt.
- Success signal: synthetic fault tests prove no blind replay after dispatch.

## Scope

### In
- Owner-only bounded JSONL attempt journal.
- Immutable operation, attempt, component, request, process, source, and route identity.
- Monotonic sequence and previous-event hash.
- Stop-before-dispatch and reconcile-after-dispatch classification.

### Out
- Live route cutover, task reactivation, browser/plugin publication, account mutation.

### Later
- Integrate the journal into restore v2 and each component adapter after isolated tests.

## Requirements

- **FR-001** — The journal shall append one fsynced, bounded, allowlisted event at a time.
- **FR-002** — The journal shall reject identity drift, sequence drift, hash-chain drift,
  invalid transitions, symlinks, concurrent writers, and events after a terminal state.
- **FR-003** — A stop before `dispatch_started` shall be safe; at or after dispatch it
  shall require reconciliation and shall not authorize replay.
- **FR-004** — Records shall never contain prompts, cookies, tokens, headers, raw
  conversations, or arbitrary error text.

## Scenarios

- **S-001 / normal:** Given a new attempt, sequential phases append and validate.
- **S-002 / crash:** Given `dispatch_started`, a new process may only enter
  `reconcile_started`, never dispatch again.
- **S-003 / concurrent:** Given a held writer lock, another append is rejected.
- **S-004 / stop:** Given pre-dispatch state, stop is safe; post-dispatch state is
  reconcile-required.

## Quality and boundaries

- Compatibility: Node.js ESM and Windows owner-local storage.
- Security/privacy/data: fixed field allowlist, hashes and typed codes only.
- Recovery/external actions: this slice writes only an explicitly supplied state root.

## Dependencies and risks

- Dependency/assumption: later adapters supply current process/source/route fingerprints.
- Risk/recovery: partial append after I/O failure is reconciled by validating the journal;
  no caller may infer absence or success from an exception alone.

## UNKNOWN and HOLD

- HOLD: live integration and AICC task reactivation — resume when isolated journal and
  restore-v2 evidence pass — owner: AICC single writer.

## Acceptance evidence

| ID | Success criterion | Evidence |
| --- | --- | --- |
| **SC-001** | FR-001/FR-002 event durability and validation | `node --test test/durable-attempt-journal.test.mjs` |
| **SC-002** | FR-003 crash/stop/reconcile boundary | same focused test |
| **SC-003** | FR-004 field and secret rejection | same focused test |

## Implementation outline

- Existing stack and boundaries to preserve: ESM, owner state root, existing coordinator.
- Intended touchpoints: new journal module/test; later coordinator integration.
- Key decisions and rationale: append-only hash chain makes crash evidence inspectable.
- Rollout/recovery: source-only now; no service or scheduled-task mutation.

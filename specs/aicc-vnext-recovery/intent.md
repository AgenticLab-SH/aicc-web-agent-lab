# AICC vNext recovery intent

- ID: INT-AICC-VNEXT-RECOVERY
- Status: accepted
- Owner: demo-owner
- Target: open-AICC local Windows control plane
- Supersedes: none

## Problem

AICC-owned jobs can restart independently after an emergency stop, while mutation
attempts and ambiguous outcomes are not represented by one durable, replay-safe record.

## Evidence

- `docs/final-aicc-recovery-and-consolidation-plan.md` requires a common durable
  attempt journal before live route, tunnel, plugin, or browser mutations.
- The 2026-09-06 incident repeatedly restarted owned scheduled work after a stop.
- The current checkout contains many unrelated owner changes that must be preserved.

## Desired outcome

AICC-owned changes become one-component, evidence-gated, durable attempts. Emergency
stop wins over startup, ambiguous post-dispatch work is reconciled instead of replayed,
and external Codex, OCX, WebGPT, and Chrome remain observation-only.

## Affected users and systems

- Users: the Windows owner operating AICC.
- Systems: AICC control plane, AICC-owned scheduled tasks, tunnel helpers, journals.

## Constraints

- Preserve every pre-existing dirty file and disabled task.
- No live service reactivation, external app mutation, account change, or hard delete
  until source and isolated canaries pass.
- One writer per component and owner-only bounded records.

## Out of scope

- Controlling Codex, OCX, WebGPT, or Chrome as AICC-owned services.
- Re-enabling current AICC scheduled tasks in this source batch.

## Success signals

- Every attempt has monotonic hash-chained events and an immutable identity.
- A stop after dispatch becomes reconcile-required and cannot authorize replay.
- Crash, fsync, stale-writer, and process-identity tests fail closed.

## Open questions

None.

## Decision

- Accepted by demo-owner on 2026-09-14 through the explicit request to apply the
  previously designed Astra AICC upgrade.

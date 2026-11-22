# Compatibility lab and guarded updates

AICC discovers versions and compatibility without treating a newer version as permission to install it. The public release matrix is `compatibility/release-matrix.json`; the installed/current/target observation and test evidence belong to a task-owned evidence bundle.

## Canary boundary

A canary uses its own absolute root, state, database, browser profile, artifacts and manifest-assigned non-production ports. Validation rejects overlap with active AICC, Codex or OCX writable roots and rejects production ports. No canary may share an active database or browser profile.

Use the read-only surfaces:

```text
aicc compatibility status --json
aicc compatibility matrix --json
aicc task run compatibility.status --json
```

## Update transaction

An update plan is immutable and component-scoped. It records the exact precondition and desired hashes, target version, exact-zero active-work proof, compatibility matrix hash, backup and rollback references, and all required direct-rescue results. Unknown or nonzero active work is a HOLD.

The only rollout order is:

```text
shadow -> canary -> default
```

Each stage requires a passing evidence reference. Default is prohibited unless Web GPT direct, OCX direct and Native direct remain healthy. Rollback is complete only when the restored component hash equals the recorded precondition hash.

## Restart budget

The same component gets at most two automatic restart attempts in one failure window. The second failed attempt moves only that component to `quarantined`; subsequent automatic attempts are rejected. A different component keeps its own budget and direct recovery paths stay available. A manual retry needs new evidence and a genuinely different failure fingerprint.

GUI launchers do not receive unbounded KeepAlive. The isolated login/start-once rehearsal requires one owner per label and listener, no duplicate durable job, no restart count above two and no GUI KeepAlive loop. A physical host reboot is never used as a routine fix and must not be attempted while an active user task exists.

## Recovery

Keep the active release unchanged until the isolated bundle passes source/schema, stable App Server, response pass-through, integrated/direct rescue, Web GPT six-mode, OCX dry-run, job/browser/remote, plugin lifecycle, update/rollback, restart/start-once and privacy checks. If any required check is FAIL or UNKNOWN, retain the previous release and its component-specific restore reference.

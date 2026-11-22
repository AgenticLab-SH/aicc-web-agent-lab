# Oracle upstream observer

This directory is the canonical, publishable implementation of AICC's optional
remote upstream adapter. The local AICC monitor is the primary path and checks
GitHub and npm directly with owner-local credentials. The Oracle adapter is
disabled by default and exists only for an explicitly selected remote observation
window.

When enabled, the observer performs metadata-only checks as a short-lived systemd
`oneshot`; it never clones, pulls, installs or applies an update. AICC may read its
owner-only remote `state.json` through the existing registered Oracle A1 connection
for comparison evidence, but ordinary monitoring never depends on that round trip.
There is no inbound webhook and no additional macOS LaunchAgent.

## Ownership

- `upstream_watch.py`: remote read-only observer
- `build_manifest.py`: secret-free manifest builder from owner-local registries
- `systemd/`: oneshot service and six-hour timer
- `ops/`: release, verification, and rollback scripts
- `deploy.py`: guarded deployment through an existing owner-only A1 contract
- `adapter_mode.py`: exact timer enable/disable with read-before-write verification

The legacy superproject copy is retained only as a migration recovery point
until a release built from this directory passes the same live verification.
Do not edit both copies for a new change.

## Apply boundary

Remote observation is never authorization to update. AICC may apply only a
source type with a named local action, fresh preview, pre-state match, post-state
verification and rollback. All other changes remain review-only.

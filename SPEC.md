# AICC product specification

## Authority and document roles

Existing product architecture remains in README.md and docs/agent-operations.md.
This specification owns the Slack response increment and the optional Oracle
Codex cycle watcher. It is not a retrospective specification of all AICC features.
The existing Slack requirements below remain unchanged. The watcher is owned by
`tools/platform/oracle/codex-cycle-watch/`; its README owns execution/recovery.

## Outcome / value

The owner can answer an AICC alert from Slack without guessing which Codex task
needs the answer. Deterministic reception uses no model tokens, preserves the
response across restart, and distinguishes receipt from actual execution.

## Scope and decision

Use the existing distinct AICC bot with Slack Socket Mode and structured buttons.
This requires an app-level connections:write token and interactivity, but not
DM history, channel history, user tokens, a public HTTP endpoint, or a tunnel.
Free-form messages, OTP capture, broad future approval, native permission bypass,
Desktop restarts, and a second app-server impersonating Desktop are out of scope.
Plain thread replies can be evaluated later if their extra im:history permission
has a concrete benefit; they are not silently enabled by this increment.

## Functional requirements and acceptance

| ID | Requirement / observable success |
| --- | --- |
| FR-1 | A request freezes exact project/task, operation summary, revision, expiry and random ID before publishing buttons. |
| FR-2 | Only the configured workspace/app/owner and exact bot DM/message may answer. Unknown, stale, edited, cross-task and replayed input never grants approval. |
| FR-3 | Acknowledge, done claim, approve, reject and hold are distinct. First valid response wins; changed scope needs a new request. Approval expires in at most 15 minutes. |
| FR-4 | Persist only structured response metadata before ACK. No free text, response_url, cookies, token or complete Slack payload is stored. Disk failure never acknowledges successful receipt. |
| FR-5 | Durable queue shows pending, agent-seen and expiry separately. No transport means pending, not delivered. Hooks only hint on a normal resumed turn; they do not wake idle Desktop. |
| FR-6 | Exact-task reads and compare-and-set acknowledgement prevent one task consuming another's response. Done claims require independent verification. |
| FR-7 | Feature is opt-in; existing outbound transport, policy and installed hooks are unchanged. Recovery is disconnecting the optional worker, without deleting pending responses. |

## Scenarios / security quality

Two tasks request approval simultaneously; an owner answers only one. A duplicate
Slack delivery, late button click, different workspace/user, expired approval,
stale revision, process crash and corrupt disk must fail closed or remain pending.
An agent that resumes after expiry must not act on old approval. Arbitrary Slack
text is never a shell command or developer instruction. Local state must be in
an owner-protected directory; POSIX mode bits alone do not prove Windows ACLs.
Single writer, durable atomic replace, bounded storage and exact identifiers are
required. Live readiness is separate from test readiness.

## Implementation and evidence

- src/notifications/slack-response-inbox.mjs: binding, button contract, persistence.
- src/notifications/slack-response-socket.mjs: official SDK event/ACK boundary.
- tools/platform/slack/response-inbox.mjs: scoped local queue inspection/receipt.
- tools/platform/codex/slack-response-hook.mjs: fixed no-authority pending hint.
- test/slack-response-*.test.mjs: fake Slack/disk/clock cases; no real approvals.
- docs/runbooks/slack-response-bridge.md: setup gates, usage, rollback and evidence.
- guidance/skills/notify-user/SKILL.md: readiness-aware agent procedure.

## UNKNOWN / HOLD and release gate

Windows Desktop 0.153.0-alpha.5 was observed with stdio-owned app servers and no
shared listener. The Unix daemon lifecycle is unsupported here. An official
existing-Desktop transport with exact task/turn ownership is NOT established.
App-native task-message tools available to an active agent are not a documented
standalone daemon API. Do not invent one or modify session databases/transcripts.

Full release requires separately verified Slack app permission/token setup,
protected Windows storage, an owned existing-task transport, and one harmless
live owner-response canary (received -> correct task seen). Until all pass,
code/test readiness is not live Slack-to-Codex readiness; outbound remains active.

## Outcome

An explicitly enrolled Codex account gets one short greeting when its weekly
usage window is confirmed dormant, including an unscheduled upstream reset.
No desktop login, OCX selection, reset credit or other application is modified.

## User value

Start the next weekly period promptly without opening the desktop or repeatedly
spending model tokens to check usage. Observation latency is normally two polling
intervals (about four minutes), plus upstream accounting delay.

## Scope

- In: Linux non-root oneshot/timer, two-minute token-free HTTP usage reads,
  three explicitly enrolled accounts, durable duplicate suppression and recovery.
- In: explicitly authorized durable SSH key enrollment on the existing A1 host,
  with a temporary managed-Bastion bootstrap, protected local key, and recovery.
- Out: automatic credit redemption, account creation, new IAM grants,
  Desktop or OCX changes, polling through model turns, guaranteed future API support.
- Server OAuth renewal is in scope after explicit enrollment. The owner authorized
  copying the three pool grants for this operation; Desktop authentication is excluded.
  Concurrent OCX renewal remains a disclosed risk, not a blanket prohibition.

## Requirements

- FR-101: Query the fixed ChatGPT usage endpoint without inference; only a newly
  confirmed dormant weekly window authorizes the fixed greeting with a small model.
- FR-102: Two fresh, time-separated observations must show a full unused weekly
  window whose deadline moves with server time. Zero percent alone or a five-hour
  reset alone does not authorize a greeting. Recheck immediately before sending.
- FR-103: Persist an attempt before POST. Completed/uncertain attempts must not be
  replayed after a crash. Only observation of a started weekly window rearms it.
  A four-attempt rolling daily cap bounds damage from upstream behavior oscillation.
- FR-104: Exact enrolled identities, bounded files/responses, no redirects, owner-only
  Linux storage, file locking, timeouts and bounded backoff protect the runtime.
  Optional explicitly enrolled refresh tokens renew before expiry under the same
  process lock. Validate identity and durably save the replacement before usage.
  Missing/failed renewal stops sending; no Desktop/OCX auth file is written.
- FR-105: The timer is opt-in, installation has a reviewed plan and recoverable
  receipt, and stop/rollback affect only the named watcher. Help/dry-run never mutate.
- FR-106: Report last observation, decision and uncertainty without tokens, emails,
  prompts, response bodies or credential identities in logs/state. A startup probe
  does not claim a deployed timer. No live auth file is written during development.
- FR-107: Preserve existing SSH keys and services. Bootstrap access with an owner-only
  new key, enroll it additively, verify a separate host-pinned SSH connection, then
  remove only task-created temporary access. Never promise perpetual availability.

## Scenarios

- S-101: Fixed weekly deadline and rounded 0% usage: watch without sending.
- S-102: Natural or early reset yields moving full-week deadlines: send once,
  then observe fixed deadline/countdown before marking cycle_started.
- S-103: Timeout after POST or crash: leave pending, reconcile by usage only;
  no duplicate greeting. A missing/invalid window never becomes zero usage.
- S-104: Concurrent timer/manual run, corrupt state, duplicate identity, expired
  token or upstream 401/429: lock, fail closed or back off without switching accounts.

## Quality and boundaries

Python standard library only. Runtime always executes as the existing non-root
credential owner. A user-manager service requires effective sandboxing and existing
linger. On this A1, live tests proved the user manager silently ignored read-only
home protection, while system-manager units with User=ubuntu enforced it. Therefore
use exact system-manager service/timer units running as ubuntu; no kernel/AppArmor,
linger, account or existing-service change. The root installer never reads OAuth.
No new network listener or runtime privilege escalation. State
and credentials stay out of Git. The greeting consumes a small number of tokens;
GET usage reads do not invoke a model. HTTP quotas and API availability still apply.

## Dependencies and risks

The observed ChatGPT OAuth endpoints are not a promised stable public API.
Permission/shape changes fail closed. Server must have an existing verified SSH
route and owner-only filesystem. Access-only credentials eventually expire. Optional
server renewal persists rotated tokens, but cannot synchronize an independently
running OCX writer; a revoked shared grant may require separate reauthentication.
No implementation can guarantee exactly-once delivery after an ambiguous network
failure; durable at-most-once attempts favor no duplicates over forced retries.

## UNKNOWN and HOLD

- Deployed on existing A1. Durable host-pinned SSH survives temporary Bastion removal;
  the three requested grants are owner-only on the server. Existing apps are preserved.
- One live paused-account OAuth renewal and usage read passed. Independent OCX
  refresh remains a technical risk; no promise of perpetual grant validity.
- Real future reset-triggered delivery remains event-dependent. No extra model
  turn or manufactured reset was used as a deployment test. Live exact-unit stop/
  resume passed; full removal is receipt/hash guarded, not claimed as live-tested.

## Acceptance evidence

Detector/IO/service/renewal/bootstrap fixtures: 65 passing on the actual A1 Linux
target, with zero skips; 61 passing and four POSIX cases skipped on Windows, plus
four Windows key protection/recovery fixtures. Fresh server usage reads for all
three accounts stayed observe-only. One live renewal/readback and exact-unit
stop/resume passed. Desktop/OCX fingerprints were unchanged. The current Windows
repository gate passed, including the system-manager addition and key fixtures.
Optional gitleaks is unavailable, not a completed secret scan.

| ID | Criterion | Evidence |
| --- | --- | --- |
| SC-101 | FR-101/102 normal, natural and exceptional reset detection | Python cycle policy fixtures; direct OAuth read-only observation |
| SC-102 | FR-103 no duplicate after ambiguous POST/restart | fake client/store persistence and crash-order tests |
| SC-103 | FR-104 secrets, expiry, corrupt state, response and filesystem boundaries | watcher unit tests; Linux permission tests on deployment target |
| SC-104 | FR-105 exact install/stop/rollback, dry-run purity | generated-unit/receipt tests; live system-manager install/status/stop/resume; full removal not live-tested |
| SC-105 | FR-106 Desktop/OCX preservation | before/after auth/config fingerprints; only server runtime credentials are writable |
| SC-106 | FR-107 recoverable durable access | synthetic recovery tests, actual second SSH connection and scoped bootstrap rollback |

## Implementation outline

- `tools/platform/oracle/codex-cycle-watch/cycle_policy.py`: pure detector/state machine.
- `cycle_watch.py`: fixed-origin OAuth HTTP client, protected storage and Linux CLI.
- `service.py`: alternative exact user-service plan/install/status/stop/rollback.
- `system_service.py`: actual A1 system-manager units running as non-root owner.
- `tests/`: synthetic credentials, responses, storage and service fixtures only.
- Validation: `python -m unittest discover -s tools/platform/oracle/codex-cycle-watch/tests -v`,
  project-spec checker, and the repository Windows gate. Deployment is separately gated.

# Codex Terminal task callback

Use this runbook when a bounded owner-local Terminal operation must finish after the
current Codex turn becomes idle and then resume that exact Codex task. It replaces
recurring polling automations; it does not replace task lifecycle or active-work
protection.

For route or Desktop maintenance that could remove the app process, prefer the
foreground rescue guardian below. It is a visible one-shot Terminal process, not a
LaunchAgent, cron entry, Codex automation or second Codex task.

For a Desktop transport recovery, run the product-owned foreground lifecycle command
instead of hand-writing a Zsh polling loop. Zsh reserves names such as `status`, and a
login-shell PATH is not a stable executable contract. Pin the candidate's absolute
Node and CLI paths, and let this command write the watched terminal result atomically:

```bash
/absolute/node /absolute/open-aicc/src/cli.mjs codex-desktop foreground-restart-once \
  --expected-pid EXACT_CURRENT_DESKTOP_PID \
  --expected-thread EXACT_CODEX_TASK_ID \
  --operation-id exact-desktop-recovery-v1 \
  --result-file /absolute/owner/runtime/foreground-rescue/exact-desktop-recovery-v1/result.json \
  --confirm-one-shot --json
```

This foreground command does not bootstrap a launchd job. It waits in the visible
Terminal process, never force-terminates Desktop, and records `PASS` or `HOLD` exactly
once under the owner-only AICC runtime.

## Contract

- One callback binds one project key, exact task ID, canonical project root, operation
  ID, future result path, accepted terminal states and an expiry.
- The arm step pins the signed Codex Desktop bundled executable by path, SHA-256 and
  version, plus the exact installed App Server manifest SHA-256.
- The result must be a regular owner-only JSON file. Its operation and terminal status
  must match the binding, and the Terminal worker must pass its exact SHA-256.
- Delivery uses only stable App Server methods: `thread/read`, `thread/resume`,
  `turn/start`, then `turn/completed`. The default owned-stdio transport requires
  Desktop to release its writer. The preferred same-Desktop transport connects to
  the owner-only local daemon control socket over Unix WebSocket, so Desktop and the
  Terminal callback share one App Server writer instead of competing writers.
- The exact task must resolve to the bound project root and be idle. Active, unknown,
  wrong-root, expired, changed-binary, changed-manifest, symlink and permissive result
  cases fail closed.
- `turn/start` has a stable `clientUserMessageId`. A completed callback suppresses
  replay. An ambiguous delivery is never retried; a known started turn is reconciled
  by turn ID without starting a second turn.
- The callback forwards only operation/status/path/hash and fixed continuation rules.
  It never forwards raw result content, secrets, browser state or logs.
- A callback turn is successful only when App Server reports `completed`.
  `failed` and `interrupted` are terminal delivery failures and remain HOLD even
  when the underlying Terminal operation itself passed.

## Foreground rescue guardian

Arm this only immediately before an exact route/Desktop transaction. The command
backs up the current Native config and Web GPT integration journal into an owner-only
run directory, binds the exact task and operation, and opens one visible Terminal
worker. It never installs or schedules a persistent service.

```bash
node tools/platform/codex/run-foreground-rescue-guardian.mjs \
  --project-root /absolute/project/root \
  --task EXACT_CODEX_TASK_ID \
  --operation exact-route-transaction-v1 \
  --operation-result /absolute/owner-only/future-result.json \
  --desktop-pid EXACT_CURRENT_DESKTOP_PID \
  --worker-pid EXACT_TRANSACTION_WORKER_PID \
  --manifest /absolute/installed-app-server-manifest.json \
  --callback-codex /absolute/daemon-matched/codex \
  --control-socket /absolute/owner/.codex/app-server-control/app-server-control.sock \
  --callback-retry-ms 5000 \
  --task-idle-grace-ms 15000 \
  --web-gpt-conversation https://chat.example.invalid/c/demoXTERNAL_RECOVERY_CHAT
```

The worker survives Codex Desktop exit because it runs in Terminal. It watches only
the bound result, Desktop PID, optional worker PID and TTL. If the operation or
Desktop disappears, it restores only backup or explicitly allowlisted transitional
file identities. Unknown config drift is not overwritten.

The guardian always proves and restores the installed `codex-native-rescue` route
before delivery. When Desktop remains open, `--control-socket` should select the
owner-only shared daemon and `--callback-codex` must pin the exact daemon-matched
client binary and manifest. When Desktop is closed, omit both options to use the
Native wrapper over owned stdio. The worker retries only proven pre-dispatch busy or
known-turn reconciliation states until its TTL. An ambiguous `turn/start` is never
replayed. After the exact callback reaches a terminal state, the worker opens the
signed Desktop app once only when it had disappeared.

With the shared daemon configured, the worker also observes the exact task and root
read-only. After it has seen that task active, an `active` to continuously `idle`
transition without the watched terminal result is treated as an interrupted
coordinator after the configured grace period. The sanitized recovery mirror and
optional exact-idle Web GPT advisor are refreshed, then the same Native callback
returns a HOLD event to that task. An idle task that was never observed active does
not trigger this path.

When an incident is detected, the worker mirrors a sanitized handoff at
`.aicc-recovery/TERMINAL-RESCUE.md`. If and only if 17841 reports two consecutive
exact-idle/ready health samples, it may make one non-streaming, read-only
`chatgpt-web/temporary/high` advisor request directly to `/v1/responses`. The bounded
sanitized mirror is included in the request, so this emergency advice does not need a
trusted local-tool environment. It creates no Codex Desktop task and grants Web GPT no
arbitrary shell authority. Native callback remains the actuator; Web GPT advice is
evidence only.

## Arm before the Terminal operation

Choose a result filename that does not exist yet. Send the binding over stdin so the
task and paths are not reconstructed from a title or process list.

```bash
printf '%s\n' '{
  "projectKey": "PROJECT_KEY",
  "taskId": "EXACT_CODEX_TASK_ID",
  "projectRoot": "/absolute/canonical/project/root",
  "operationId": "bounded-operation-v1",
  "resultFile": "/absolute/owner-only/runtime/result.json",
  "manifestFile": "/absolute/codex-app-server/manifest.json",
  "codexExecutable": "/Applications/ChatGPT.app/Contents/Resources/codex",
  "controlSocket": "/absolute/owner/.codex/app-server-control/app-server-control.sock",
  "terminalStatuses": ["PASS", "HOLD", "FAIL"]
}' | aicc codex-callback arm --json
```

Omit `controlSocket` only when Desktop will be closed before delivery. When it is
present, the socket and its parent must both be real, owner-owned and inaccessible to
group/other users. The pinned executable and manifest must match the daemon version,
not merely the newer Desktop bundle version.

## Enable one shared Desktop daemon

Use the signed Desktop Codex binary to start the managed daemon, then verify the
reported daemon version and socket before changing Desktop launch behavior.

`daemon version` is a pre-mutation identity gate, not an informational check. The
reported `appServerVersion`, canonical `managedCodexPath`, owner-only socket, exact
`thread/read` task ID, task root, and idle/notLoaded state must match the pinned
manifest and callback binding before `launchctl setenv` or a Desktop restart. A stale
managed daemon or a thread reconstructed at another root is `HOLD`; never attach the
Desktop first and hope the callback will reconcile it later.

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server daemon start
/Applications/ChatGPT.app/Contents/Resources/codex app-server daemon version
launchctl setenv CODEX_APP_SERVER_USE_LOCAL_DAEMON 1
```

After every Codex task is idle, quit and reopen Desktop normally once. The restarted
Desktop must have `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, must connect to the same
`~/.codex/app-server-control/app-server-control.sock`, and must not own a separate
`codex ... app-server --listen stdio://` child. A read-only `initialize` plus exact
`thread/read` is the pre-canary. Then a Terminal callback can create a turn in the
bound task without sending a message to another task.

When the shared daemon fails this identity gate, the bounded alternative is an
owner-stdio callback. After all routes are ready and the exact task is idle, quit the
Desktop normally once, use the current signed Desktop Codex binary plus its generated
version/SHA-pinned App Server contract to post-read the exact task root, deliver the
single callback without a control socket, and reopen the Desktop once after callback
terminal state. Do not switch Desktop to a stale daemon, do not use `codex exec resume`
as an untracked substitute, and do not reopen until the owned callback client has
released the task writer.

The terminal worker must print KST progress during idle proof, Desktop release,
callback delivery, and Desktop reopen. It writes the final operation result only after
the one reopen and preserved-route post-read. A callback payload is a separate
pre-reopen handoff artifact and must not be mistaken for the final result.

Rollback is component-scoped:

```bash
launchctl unsetenv CODEX_APP_SERVER_USE_LOCAL_DAEMON
/Applications/ChatGPT.app/Contents/Resources/codex app-server daemon stop
```

Quit and reopen Desktop normally once after rollback. Do not leave Desktop connected
to a daemon that is being stopped. `codex exec resume EXACT_TASK_ID PROMPT` is a valid
direct CLI fallback only after Desktop has released that task writer; it is not a
solution to concurrent-writer ownership.

Keep the returned callback ID and token file inside the owner-only operation directory.
The result directory and callback state are mode `0700`; binding, token and result are
mode `0600`.

## Complete from the Terminal worker

Web GPT exact-turn 완료를 기다리는 작업은 agent heartbeat 대신 Observer waiter를 callback에 연결한다.
먼저 아래의 미래 result path로 일반 callback을 arm한 다음, 같은 callback ID와 pre-registered watch ID를
one-shot Terminal worker에 넘긴다. worker는 Observer long-poll만 사용하고 terminal artifact metadata를
owner-only result JSON으로 기록한 뒤 이 절의 callback completion을 수행한다.

```bash
aicc web-gpt-callback wait \
  --watch EXACT_WATCH_ID \
  --callback EXACT_CALLBACK_ID \
  --json
```

watch owner task와 callback task가 다르거나 watch가 ambiguous/unknown이면 result를 쓰지 않고 fail closed한다.
active task와 Desktop writer busy는 dispatch 전 상태에서만 유한 재시도하며 ambiguous `turn/start`는 재발행하지
않는다. raw Web GPT 응답은 callback prompt에 포함하지 않는다.

After the operation has atomically written its terminal result:

```bash
RESULT_SHA256="$(shasum -a 256 /absolute/owner-only/runtime/result.json | awk '{print $1}')"
aicc codex-callback complete \
  --callback EXACT_CALLBACK_ID \
  --result-sha256 "$RESULT_SHA256" \
  --json
```

The command remains attached until the callback turn reaches a terminal state. If the
wait times out after a known turn ID was accepted, run the same complete command once;
it reconciles that turn and does not submit another. If the state is `dispatching`,
delivery is ambiguous and must remain HOLD instead of replaying.

```bash
aicc codex-callback inspect --callback EXACT_CALLBACK_ID --json
```

## Desktop maintenance

The Terminal operation may use `aicc codex-desktop quit-once` or `restart-once` only
under its separate exact-idle and survival contract. It requests normal macOS quit
once and never force-terminates active or unknown work. Reopen the signed app once if
the operation requires it, prove the new transport is healthy, write the terminal
result, and then invoke the callback.

If normal quit is refused, record `HOLD` in the result and deliver that terminal status.
Do not use `kill`, `pkill`, SIGTERM, SIGKILL, UI keystrokes, recurring automations or a
different task as a substitute. The foreground guardian is finite and must exit after
one terminal delivery or TTL HOLD.

## Explicit official proxy transport

The existing `codex-callback arm` JSON accepts `sharedDaemonProtocol: "official-proxy"`
with an absolute `controlSocket`, pinned `codexExecutable`, and its matching manifest.
This opts into `codex app-server proxy --sock EXACT_SOCKET`; inspect reports
`deliveryTransport: "desktop-shared-daemon-proxy"`. Existing bindings retain their
original transport. The proxy is hidden and its close affects only this client.
The existing daemon is never started, enabled, stopped, or replaced by this adapter.
An absent/unsafe/unavailable endpoint fails closed, with no owned-stdio fallback.
On Windows the socket parent must additionally satisfy the owner-only ACL policy.

This is a transport option, not queue authorization. Desktop continuity still needs
an identified existing Desktop daemon, fresh exact idle/route evidence, actual OCX
quota readiness, cleared HOLD, and reconciliation of outstanding attempts. Never
relocate the Desktop writer or enable a new daemon merely to satisfy those gates.
The callback retains its durable pre-dispatch intent, stable message ID, exact turn
ACK and unknown-delivery no-replay boundary. Do not report ACK or task completion
from a socket connection. CLI 0.162.0 exposes proxy, but the observed default Windows
control socket refused connection (10061); that is transport unavailable, not a
429 limit, 503 capacity result, or proof that the installed method is unsupported.
Implementation only; post-change verification has not been run.

## Group result scheduler scope

`node src/local-scheduler.mjs --group-followup-only` invokes only the existing
`GroupFollowupService`; upstream review, unrelated monitoring and notification
ticks are excluded. With no owner registration it sends no model request. This
entry point does not itself register a schedule or implement a delivery transport.
An injected delivery adapter must still supply exact-thread idle, writer return,
fresh selected-account quota, authority and stop-state evidence. Missing evidence
keeps the result in HOLD; one ambiguous delivery is never replayed. Source tests
do not establish installed automatic continuation or an observed new model turn.

### G1 follow-up strict helper integration (source-only, 2026-11-07)

The existing group-only scheduler now binds each observed result to the original
registration SHA, owner revision, stop epoch, worker operation, result SHA-256,
source-writer-return receipt SHA, terminal proof SHA, exact central thread/root,
and account 2. Callback and queue must both have no pending dispatch. If the
registration changes after observation, the original event is held rather than
re-authorized. The durable record is still the existing jobs store; no second
central ledger or model heartbeat is introduced.

The default adapter uses only the *installed and SHA-pinned* PowerShell runtime
and current `Invoke-AiccCodexContinuity.ps1 -Action StrictPreflight` for the
exact registered thread and selected account. Even when that action returns
`STRICT_ROUTE_READY_NOT_DISPATCHED`, the consumer returns
`STRICT_WORKER_ENQUEUE_UNBOUND`, `dispatchable=false`, and `modelRequests=0`.
An owner-only proof of the source writer return is not inferred from a result
file, task exit, an old callback, an unpinned helper, or pool quota.

Do not directly edit `registrations.json` or enable/restart the Task to clear
this HOLD. The remaining owner-managed transport must use the existing
installer's bounded preview, one-use confirmation, registry CAS, backup and
rollback. It must atomically bind the installed helper/bridge/official route
and Task exact pin, owner revision/stop epoch, exact worker operation and
callback/queue occupancy, original terminal/idle and writer return, fresh
strict account 2 quota, and one create-once group event to the helper's strict
worker claim. The worker must settle the exact original thread/turn and leave
UNKNOWN pending without replay. A queued intent is not a completed turn.

Until that *implemented and installed* enqueue/claim contract is verified,
actual automatic dispatch is HOLD. A historical disabled but unsettled queue
receipt is evidence, not authorization to clear, relabel or reproduce it.
Source-side fake checks are `node --test test/group-followup-service.test.mjs
test/group-followup-strict-adapter.test.mjs test/group-followup-scheduler.test.mjs`.
They do not prove a live strict route, an installed replacement, or user-goal
completion. Source restore uses the matching preimages stored with the G1
after-transport result; any installed release must instead use its owned
installer receipt and guarded rollback.

### G1 owner-group enqueue manager (source-only, 2026-11-07)

This section supersedes only the earlier STRICT_WORKER_ENQUEUE_UNBOUND source
gap above. Runtime acceptance is NOT RUN: the production Task still points
to its older helper, STOPPED_FOR_MAINTENANCE remains, and no original thread
has been newly registered or sent a request. No installer was applied.

The existing strict launcher / command-route-r2 (gpt-6.1-sol, high) is reused.
Installed pinned GroupInspect only reads exact event evidence; GroupAuthorise
is separate explicit owner-only event authorization; GroupEnqueue writes one
durable create-once intent without launching a model. Only the existing
Worker creates the once-only claim marker before its strict process launch.
It requires the exact installed worker operation in -OperationId. ACK loss
or an unknown prior outcome retains the claim, never replays. Legacy Enable
and Resume reject group-only rows. StopWorker increments their stop epoch
and disables them: removing a stop fence cannot revive old authority.

The owner places one exact event at
  OWNER_STATE/group-inbox/EVENT_SHA_ID.json
It must have schemaVersion=1, kind=aicc-owner-group-event,
issuer=aicc-owner-controller, the original thread, projectRoot/sourceRoot,
account 2, route, ownerRevision, stopEpoch, workerOperationId, source ID,
result path/SHA/status, source-writer-return receipt path/SHA,
registration path/SHA and terminal SHA. It carries a fresh observedAt and
explicit false pending/stop, true writer-return/authority observations.
The returned receipt must independently verify its own
aicc-source-writer-return schema and same owner/source/worker fields with
returned=true and closed=true. Do not manufacture a return receipt.
Event ID is SHA-256 over UTF-8 JSON [threadId,sourceId,resultSha256].
The source registration records that ID but not event SHA (avoids cyclic
hash dependency); the owner pins exact event bytes after registration.

A separate reversible installer lives at
tools/platform/windows/Install-AiccCodexContinuity.ps1:

1. -PreviewGroupOwner -ThreadId EXACT -TargetRoot EXACT -OwnerRevision SHA256
   -StopEpoch INTEGER -WorkerOperationId UUID -NodePath EXACT
   -PlanFile OWNER_STATE/plans/GROUP-PLAN.json creates one plan. It checks
   exact existing Task/action/VBS/SID, CLI rollout/root, pinned dependency
   closure, maintenance stop/lock, registry CAS and preserved queues. No
   Task or registry mutation.
2. -ApplyGroupOwner -PlanFile EXACT -ExpectedPlanSha256 SHA256
   -Confirm "INSTALL GROUP OWNER SHA256" performs a distinct one-use
   controller-approved change. It copies an immutable release, preserves
   old Task identity/triggers but swaps only its worker helper/VBS action,
   replaces the strict route pin, registers the exact thread as account2,
   groupOwnerOnly=true, enabled=false, and preserves the stop fence. It
   neither launches a worker nor makes a model request.
3. -RollbackGroupOwner -PlanFile EXACT
   -Confirm "ROLLBACK GROUP OWNER AFTER_REGISTRY_SHA256" restores exact
   preimage registry and Task only under the same maintenance fence, if
   post-state SHAs still match and no event/claim/pending record exists.
   Rollback is one-use; the release and backups remain available.

After real owner return and callback/queue reconciliation, the authorized
controller alone can run the *installed pinned helper*:
  -Action GroupAuthorise -StateRoot OWNER_STATE -ThreadId EXACT
  -StrictAccountNumber 2 -EventId EVENT_SHA_ID
  -ExpectedEventSha256 EVENT_FILE_SHA256
  -Confirm "AUTHORIZE GROUP EVENT EVENT_FILE_SHA256"
This records evidence but does not enqueue or execute. The scheduler's
GroupFollowupService then uses installed GroupInspect and GroupEnqueue only
after fresh exact READY and its durable no-replay claim. The owner must
separately activate the worker under current live gates; this source change
contains no operational activation. A group intent is not a completed turn.

Hold on wrong issuer/root/thread/account, stale revision/stop epoch/worker
operation, changed result/receipt/registration/terminal, busy owner,
historical or current pending/uncertain delivery, maintenance stop, or
non-fresh strict account-2 quota. Never promote pool READY, installed
helper presence or source success into actual model authority.

Isolated source fake tests only:
  pwsh -File tools/platform/test/Test-AiccGroupOwnerSyntax.ps1
  pwsh -File tools/platform/test/Test-AiccGroupOwnerFake.ps1
  pwsh -File tools/platform/test/Test-AiccGroupInstallFake.ps1
  node --test test/group-followup-strict-adapter.test.mjs

They do not prove an installed Task reload, live strict model request,
callback occupancy reconciliation or observed original-thread completion.
Prior strict and after-transport suites were not re-executed.

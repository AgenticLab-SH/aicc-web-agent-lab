<!-- portfolio-numbering:start -->
> 현재 상위 관리 그룹: G1 · AI 작업 기반 (20261102-r1). 번호 정본은 소유자의 portfolio/group-registry.json이다. 아래 날짜 있는 이전 관제/순번/동시 그룹 수/검사 제한은 당시 기록이며 현재 실행 지시가 아니다. 원 제품·요구·대화 ID와 기존 변경은 보존하고 현재 작업 범위/작성권을 먼저 확인한다.
<!-- portfolio-numbering:end -->

# Stock OpenCodex operations and recovery

## Current operation

The registered Windows command `ocx` opens the existing local dashboard without
starting another server. `ocx gui` and `ocx dashboard` do the same; `ocx --help`
shows the management commands. `ocx --version` reads the registered supplier,
and `ocx update` checks the official latest version without replacing the running
service. Use `codex` to start a coding conversation; account management remains
with the existing A1 dashboard. Unsupported supplier commands are refused rather
than starting an unmanaged server or rewriting the account/configuration owner.

The external adapter keeps the official supplier unchanged. Its independent admission ceilings are 97% for five-hour usage and 98% for long-window usage; an owner may configure stricter thresholds. Apply settings through the existing account policy preview/commit path and confirm `/api/aicc-local/policy` after installation. Changing stored settings alone does not change an older adapter's hard ceiling.

SSE `response.completed`, `response.failed`, `response.incomplete` and terminal `error` observations settle the admitted request before forwarding the terminal chunk. A provider that leaves the transport open after a failed terminal cannot keep the conversation marked active. Missing terminal evidence remains UNKNOWN, and actual overlapping work and identical uncertain replay retain their existing guards.

Accepted adapter rebuilds on the same 2.96 supplier use a fresh supported software snapshot, current fixture acceptance and the existing one-shot recovery worker. Historical acceptance is not reused as proof of a changed adapter.

### Request lifetime and switching contract

User turns retain thread-wide active exclusion and issuer continuity. Explicit `request_kind=memory` work has a separate issuer/fence per semantic request within the thread, so different background jobs can overlap without occupying the user turn. Identical in-flight memory work is still excluded. Both legacy memory UNKNOWN records and new per-request UNKNOWN records continue to reject identical uncertain retries, including after restart. Request bodies and credentials are not persisted by these fences.

An active-request conflict returns HTTP409 with `x-should-retry: false` and bounded first-party failure headers; this is not transient service unavailability. Do not automatically replay it. Terminal stream success/failure releases its own fence before exposing the terminal chunk; EOF/HTTP200 alone does not establish completion.

Automatic and preferred selection use fresh verified quota/model/auth/generation evidence. Strict selection never silently falls back. Five-hour97% and long-window98% are independent admission ceilings; stricter owner settings win, monthly-only entitlement explicitly declares the short window inapplicable. In-flight admitted responses drain to a terminal outcome. Account switching never forwards foreign ciphertext, response handles or account files without the existing portability checks. A newly supplied instruction is distinct from replay of an unresolved attempt.

Activation requires a current independently bound recovery worker, exact live-active/inflight zero, owner/CAS and software rollback. Historical UNKNOWN evidence is retained and is not a requirement to erase history to make the service idle. Source changes become operational only after supported immutable installation, running-version/hash readback and actual bounded request tests. Data-plane credentials do not grant management-plane authority; a management refusal must not be bypassed.
### Offline supplier compatibility intake

With PowerShell 7.3+, the existing preparation entrypoint can review an already downloaded supplier archive:

```powershell
$receiptPath = (Resolve-Path -LiteralPath $existingArtifactReceipt).Path
$planJson = & .\tools\platform\opencodex\Prepare-AiccOcxUpstream.ps1 `
  -Action PlanCompatibility -TargetVersion 2.96.0 -ArtifactReceiptPath $receiptPath
```

`$existingArtifactReceipt` is the existing owner-local `upstream-artifact.json` from
`Prepare`; this action does not download it again. Keep the returned JSON in the
existing owner-local operation evidence, outside tracked source. It verifies the
receipt/SRI/archive SHA512, package identity and safe regular archive entries, then
pins the archive inventory, current 2.81 registry/manifest and candidate adapter
sources. It reports target-only, changed-common and baseline-only files and each literal supplier import
as changed, unchanged or missing. The baseline tree can include installed dependencies;
baseline-only files are not an upstream deletion report. It reads archive streams without extraction,
code execution, dependency installation, account access or network calls.

A plan is **not compatibility acceptance**: imports being present does not prove
exports or behavior. `accepted=false`, `verification=NOT_RUN` and `canActivate=false`
remain explicit. The recorded baseline manifest is pinned; installed files and
live service identity are not reverified by this preparation action. Registry
metadata is not fetched again. Invalid input is refused without modifying it;
there is no software change to roll back, and all original receipts remain intact.

The existing release builders and transition still accept only supplier 2.81.0.
Next, review changed imports/exports and run the relevant isolated fake-state
contracts, then add separately reviewed version-bound builder/acceptance/rollback
support. A later service transition belongs to the current runtime owner and
requires the affected activity/recovery checks appropriate to that operation.
Historical UNKNOWN records, a separate READY and a clean Git tree are not prerequisites
for this read-only plan. No historical request is replayed or cleared.

### 2026-11-02 conversation continuity repair

`external-conversation-lifecycle.ts` now excludes only a live request from concurrent
same-thread dispatch. A settled or restarted UNKNOWN is evidence about one old
attempt, not a permanent veto on that conversation. A new instruction archives the
old operation in `external-request-history.jsonl` and preserves its physical issuer.
The lifecycle file retains unresolved fingerprints across completion and restart:
an identical ambiguous attempt gets nonretryable HTTP 409 `request_outcome_unknown`,
while a different instruction may proceed. Legacy rows without a fingerprint remain
unresolved evidence and do not prevent new instructions. No original request is replayed.

Health reports `unknownTurnsScope=historical-request-evidence`,
`conversationUnknownBlocks=false`, and `requestReplayProtection=semantic-fingerprint`.
`unknownTurns` includes archived unresolved attempts and is not an admission/idle gate.
Active concurrency, real account ownership/ciphertext/file migration checks, credentials,
entitlements, strict account selection and quota admission remain enforced. Codex hooks
and scheduled supervisors do not create this lifecycle lock and are not disabled.
Earlier dated statements about a permanent UNKNOWN conversation fence are historical.

For an authorized OCX-only installation, `Invoke-AiccOcxLocalRecovery.ps1` supplies an
explicit alternative to the remote standby: one model-free PowerShell worker, one exact
software snapshot/candidate, a process-bound READY receipt, a two-minute one-use signal,
and automatic CAS-protected rollback on a confirmed failed transition. Launch it hidden;
read the live READY before creating its matching `local-activate-signal.json`. Only its
child transition accepts `-LocalRecoveryReadyPath`; callers cannot reuse READY themselves.
No permanent task, model request, account switch, auth/history restore or bridge restart
is involved. A still-running transition is reconciled without starting a second transition.
Existing owner/drain/live-active checks and four-file rollback rules still apply.

Validation: 22 targeted continuity/pool tests passed, including restart, exact replay,
active exclusion, late settlement and HTTP 409 behavior. PowerShell parse checks passed.
This source record alone is not installation or live-model acceptance; exact release,
runtime readback and per-conversation queue receipts live in the owner-local operation
record. Full compatibility suite and phone/Termius interaction are separate checks.

2026-10-25 catalog proof source: `external-pool-state.ts` now offers
`catalogSnapshot()` returning `{models, accountRosterProofs,
accountRosterProofsStatus}` from one model-cache observation. Each private proof
contains the exact selector/account ID, credential generation, original cache
observation timestamp, entitled slugs and registered client version. The cache
must still match the credential owner's live generation, current account and
namespace, and be younger than 60 seconds after the final awaited roster read.
Missing/stale/ambiguous observations omit the proof and its pinned model row;
status is `UNSUPPORTED` or `PARTIAL`, never fabricated null success. Existing
`catalog()` callers retain the model array. Only the authenticated `/catalog`
response exposes proofs; `/models`, client-version model responses and discovery
keep their existing shape and omit private account identifiers.

The new isolated contract has 8 passing tests. Because runtime source changed,
the unchanged official search probe issued a fresh 9-check fixture-only search
acceptance with current source hashes; the release builder's existing exact
`SearchAcceptancePath` gate is unchanged. Earlier sealed candidates and receipts
remain immutable. This is source/fixture acceptance, not installation, live
account proof, account mutation, service restart or remote search verification.
The private v2 candidate owner consumes the new exact acceptance; the main owns
any later activation and live readback.


The live record in `context/PROJECT.md` supersedes the historical client notes
below. The registered Windows local runtime and release are recorded there;
A1 alone refreshes pool
credentials and owns the PC-independent cycle watcher.10100 and10101 share the
authenticated local data plane;10102 is the existing A1 management forward.
17841's installed OCX auth handoff is retained. Both effective windows are97%,
switch/switch. No99% promotion follows from a simulated transport cutoff.

`Invoke-AiccLocalOcx.ps1` owns local software maintenance and preserves the
independent Workspace recovery plane. `Invoke-AiccOcxUpdate.ps1` now refuses
the retired stock two-target updater while a local registration exists.
`build-local-policy.py` is the historical fork builder with local-selection
restart preservation and serialized rejected-token recovery. A clean supplier
release uses the separate `external-*` adapter sources; those sources are not
evidence of an installed or accepted release. Exact release/acceptance and deliberately discarded optional work are
tracked in `docs/operations/aicc-home-and-tray-control.md`.

## Historical stock-client evidence

A1 owns the account credentials. Windows is an upstream-only client. Native
Codex remains the global provider; neither this helper nor the OCX service may
rewrite the Native route. The authorized Desktop controller now routes non-Web
requests through the existing Web bridge to OCX data ingress 10101, while
preserving the Native login, global configuration and history.

## One-command recovery

```powershell
aicc-ocx-recover
# Also open the official client dashboard (pairing may be required):
aicc-ocx-recover -Open
```

The helper checks the registered A1 systemd owner and Windows scheduled task.
Healthy services are no-ops. Only an absent, attested existing service may start.
An unknown listener, leftover owner or changing preimage refuses a duplicate
start. It never kills processes, restores accounts, repairs tokens or resends a
model request. `-Open` opens localhost:10100 only after
readiness and owner checks pass.

`Install-HubAccountCli.ps1 -Commit` installs the small forwarding commands
beside the existing `aicc-apps` CLI. It refuses differing files and makes no PATH
or global shim change.

`-InstallStockCli` additionally forwards `ocx.ps1/.cmd` to the registered stock
package via its published Node launcher. Old packages stay intact. The installed
`aicc-ocx-update [-Check]` checks both targets; it never uses `ocx update check`.

## Current topology

2026-10-05 update: Windows runs stock 2.77.0. A1 runs the source-pinned,
software-only `2.77.0-aicc.windows.1` fork via an owned systemd drop-in, with
`AICC_OCX_WINDOW_THRESHOLDS=95,98`. The stock tree and all account homes remain
intact. `aicc-ocx-policy -Action status|rollback` attests the runtime or restores
the original service without restoring credentials. Never infer parity from
the stock CLI's version; read the actual A1 readiness version.

`build-window-policy.py` pins both the upstream version and source hashes. Its
separate software output changes quota selection math and, since `.2`,
rejects the GUI's stock update POST with a clear 409 so the custom policy cannot
be overwritten. After the live turn ended, five consecutive idle reads passed.
The `.2` deployment, actual rollback to stock and redeployment passed. Official
management calls confirmed update HTTP 409, nine models, account/settings HTTP
200 and unchanged configuration. Use the maintained two-target update command.
On 2026-10-05 the 2.77.0 upstream sources and the separate
`2.77.0-aicc.windows.1` policy were reviewed and deployed. Its strict admission keeps
95/98 window limits authoritative even when paid credits are available.
The 24 selector and 10 auth-context checks pass with no inference dispatched;
the A1 policy uses a separate software tree. Fresh owner/source attestation
proves both 2.77 runtimes ready and the 95/98 policy intact.
`aicc-ocx-update -Check` now returns `PASS_CUSTOM_CURRENT` and reports active
turns. `-WaitForIdleSeconds 300` shares a five-minute idle budget across both
targets without interrupting responses. Multiple PATH matches preserve the
old installs while attesting the first selected stock shim.
The upgrade's final Native-config hash check refused overall PASS; the existing
file was preserved. Independent fresh runtime checks and a response succeeded,
but the writer of the concurrent config change is unconfirmed. This is separate
from verified software deployment; do not restore an older config over live edits.
The update handler's source hash is also attested before a service mutation.

`aicc-ocx-open` uses the official one-use grant and memory-only session in a
dedicated Chrome context. It does not persist administrator tokens, alter the
main browser profile or bypass the official expiry rule.

The earlier `.2` 95% setting was a selection hint: when no replacement was
available, it retained the busy account. Its normalized score did not implement
a hard admission limit. `.3` now awaits generation-fenced fresh WHAM quota
before each pool selection, excludes accounts at 5h >=95% or weekly/monthly
>=98%, and refuses before inference when no verified replacement is available.
Explicit account models, pins, uploaded-file retention and cached/reused
selections cannot bypass the final guard. Missing, incomplete or failed fresh
quota reads fail closed; positive request observations expire after 60 seconds.
The process does not interrupt an already dispatched long response, so one
response admitted below 95% can finish above that number. Direct requests and
requests sent straight to OpenAI bypass this A1 pool policy.

Current isolated tests: 24 selector cases and 10 real auth-context cases pass
on both the local candidate and A1 Bun 1.4; the latter forbids inference dispatch.
Live `.3` ephemeral `gpt-6.1-sol` returned the exact marker with unchanged Native
configuration. The already weekly-100% `p1d05e5` explicit selector returned 429
with its reset deadline. No account was deliberately exhausted. Six SQLite
integrity and restorable-backup checks passed before the software-only upgrade;
configuration and original installations stayed intact. Main hard lock remains
raw-window based (90/98), independent of the pool admission policy.

The hub helper exposes `effectivePolicy` plus each account's `admission` state
and safe reason. Cheap CLI quotas omit observation timestamps, so below-limit
rows are `conditional` and `eligible:null`, rather than promising that a future
request's fresh check already passed. A threshold-blocked row is `blocked`.
At 22:17 KST, the parent controller completed the private Web config-only
Native-to-OCX cutover at an attested idle boundary, preserving the same `.35`
owner build, global configuration SHA and sixteen Web models. An ephemeral
fork of this existing Native controller history returned the exact marker
through 17841 -> 10101 (r150), without acquiring its writer or using tools;
subsequent controller request correlations show loopback 10101 and HTTP200.
Native encrypted-history continuation is therefore verified for that probe.
A real 5h-95% threshold crossing during a running user conversation remains a
separate acceptance check; fixture proof is not that live crossing. Receipts:
owner-local `ops/webgpt-recovery/native-ocx-r150-20261004/`.

Earlier baseline, superseded for A1 by the update above: the verified 2026-10-03 Windows and A1 packages were stock 2.76.0 in their default
Bun global roots. A1's original Node-shebang launcher uses an official Node
runtime on its service-only PATH. Windows retains the original vendor service
wrapper and scheduled task. At that baseline no vendor source patch was active;
the later A1 fork uses a separate software tree as described above.

Data uses localhost:10101 to A1:10100. Management uses supported client `relay`;
localhost:10102 still forwards A1's loopback management endpoint. On stock
2.76.0, direct mode rejected the GUI POST preflight with HTTP 404. Relay passed
actual pairing and Korean dashboard rendering. Stock GUI session tokens are
in-memory, so a new 10100 tab can require another pairing code. The stock hub
dashboard uses the internal localhost:10102 forward; users enter only localhost:10100.
Actual 10100 pairing, accounts/models, idempotent threshold save and independent A1 readback passed.
Reload and new tabs require pairing. Grants last five minutes; paired sessions expire after twelve idle hours.
The GUI update button updates the A1 hub, not the Windows package. Neither A1 listener is exposed publicly.

## Accounts and quotas

```powershell
aicc-ocx-hub -Action identity
aicc-ocx-hub -Action refresh
# Read-only preview; add -Commit only for the authorized exact account change:
aicc-ocx-hub -Action resume -Selector SELECTOR -ExpectedIdentity SHA256
```

The account helper uses the stock hub CLI through the existing authenticated A1
relay. It returns selectors, hashed identity, quota, pause and watcher state.
Account numbering must match live authenticated browser identity, not row order.
Main/native login is excluded: the server's isolated main identity is separate
from Native Codex and the same Team identity already exists in the pool. Do not
copy Native authentication to the server to make a main badge appear logged in.

Pause/resume requires exact identity and independent readback. Historical absent
watcher rows remain `presentInPool=false`; their history is retained. The 95%
policy is `autoSwitchThreshold=95` and `pool.cacheAffinity=false`. Live quota
refresh is evidence of the current read, not a future reset or threshold crossing.

## Software update and rollback

For a registered Windows-local AICC runtime, `aicc-ocx-update -Check` compares
the exact upstream base against the official npm registry. A custom suffix is
ownership metadata, not proof that the installed version is latest. The managed
update action prepares a separate integrity-bound official archive; it does not
activate a stock runtime or update A1. Clean activation requires a compatible
external AICC adapter, exact idle and software-only rollback. Stock source,
package version and GUI must remain supplier-owned. Keep A1 as the credential
writer and Windows as the ordinary request executor.

The older unregistered two-target updater remains a historical fallback for its
original topology. Its 2.76.0 read/no-op and fixture results do not prove a clean
Windows-local migration. Never run that fallback on a registered local runtime,
update Windows and A1 in one transaction, or rename a patched package to claim
that it is stock. The current migration record belongs to `context/PROJECT.md`.

`native-versions.py` snapshots only an exact Bun global software tree whose sole
direct dependency is OpenCodex. It inventories regular files and internal links,
rejects external links and restores only against the expected current digest
with all owned listener ports proven absent. It neither restarts a service nor
restores credential/config state. Actual 2.76.0 to 2.74.0 software rollback was
exercised on both Windows and A1 before retaining healthy stock 2.76.0.

The stock service repair can rewrite its service token using ambient admission
auth. Recovery uses the existing registered task and does not run service repair.
`ocx update check --json` has performed an update in the observed vendor CLI;
use an independent registry read to check versions.

## Historical compatibility layer

The old GUI patcher, drop-in and timer files are retained for historical recovery.
The A1 patch timer is disabled and the patcher is absent from the active service.
Do not re-enable it on the verified stock configuration or patch Windows vendor
files. These retained files do not describe the current startup path.

## 숨겨진 승인 검토 모델의 정식 지원

AICC external adapter는 일반 모델 수락에 계정별 fresh native roster를 사용한다. 정식 공급자가 일반 목록과 분리한 control-plane 모델은 공개 목록에 없다는 사실만으로 quota 소진으로 분류하지 않는다. pinned supplier의 `isCodexControlPlaneModel`과 `withCodexControlPlaneRows`를 재사용해 해당 계정의 신선한 일반 native 지원 근거에서 숨겨진 검토 모델 행을 도출한다. 지원 API·숨김 행이 단일하지 않거나 일반 native 근거가 없으면 수락하지 않는다.

이 분기는 bare control-plane 요청에만 적용하며 계정 namespace·preferred slug를 새로 합성하지 않는다. 원래 검토 모델명과 본문·추론 수준은 보존하고 다른 작업 모델로 치환하지 않는다. fresh quota, 97% 등 현재 owner 정책, pause/auth/generation, 기존 issuer·encrypted reasoning·file 귀속, one-send/no-replay, 공개 catalog 제외는 기존 경계를 유지한다.

이 변경은 소스 구현이다. 기존 immutable 설치본은 자동 수정하지 않는다. 실제 적용은 독립 복구 준비와 정상 승인 경로의 공식 교체를 요구하며, 소스 작성만으로 검토 503 복구나 실패한 원동작의 재개를 주장하지 않는다. 503 사유의 실측과 검토 도구의 정상 수락은 별도 근거다.
## Monthly-only quota and account-rotation continuity

The external facade now identifies an explicitly declared monthly primary window with no secondary/tertiary window as `shortWindowApplicable=false`. Missing usage in an applicable short window remains unknown; no synthetic zero is inserted. Pool selection, the HTTP admission boundary, and the inflight monitor share the same completeness predicate. Monthly-only candidates are ranked by their actual long-window usage, and all observed windows keep the existing 97% threshold.

The adapter-specific `assertReadableRotationInput` precheck has been removed. A completed conversation may pass its next undispatched request through the existing pinned supplier's account-change scrub and opaque recovery. Provider continuation references and account-bound ciphertext are removed by that existing path; reference-only items become explicit unavailable-context notices. When continuation/compaction context is discarded, the next model is told that context may be missing and that absence is not evidence that prior actions need replaying. Local conversation files are not rewritten. This permits continuation but does not promise lossless recovery of encrypted-only history.

Strict account selection, uploaded-file ownership, active/UNKNOWN lifecycle protection, and single physical dispatch remain unchanged. Source only: verification NOT_RUN; no build, installed-runtime replacement, service restart, or conversation-resume receipt. Activation belongs to the existing immutable-release workflow and an independent recovery owner.

## Admission vs in-flight quota policy and terminal settlement (G1-01/G1-02, 2026-10-31)

Source only; not installed in release `020bcf6c6c8773cc`; not verified.

- The 97% window rule now gates only new admission in `external-http-boundary.ts`. Any monitor reason before the single physical dispatch refuses the request as `window_threshold`/not sent (429, `dispatchStarted=false`).
- After dispatch, threshold and quota-freshness reasons no longer abort the stream. The admitted response drains and settles. Aborting it produced a 499 plus a durable `unknown` fence, and every later request in that conversation got `conversation_outcome_unknown`. Credential rotation/revocation (`credential_changed`) still interrupts, and is rechecked per chunk while draining.
- Settlement outcomes are `not_sent | completed | failed | rejected | unknown`. `failed` is an observed SSE `response.failed`/`response.incomplete`/`error` terminal and binds the issuer like a completion. `rejected` is a complete upstream 4xx answer other than 408, with no binding. Both clear the fence. 5xx, 408, missing terminal and client cancel before a terminal stay `unknown`.
- Consequence: usage may exceed 97% while one admitted response finishes; the provider's own hard limit still applies. The stock/A1 `.2` monitor path is unchanged.
- Fixture probes were added to `probe-external-boundary.ts` and have not been run.
- G1-05 (same slice): refusal `message` keeps the old English prefix and appends `[typed code; send state] next action` in Korean, built only from allowlisted codes. Wire `code`, `failure`, headers and `x-should-retry:false` are unchanged. Whether the official Codex client stops its own transport retries on these responses is not verified.

## Child/forked thread with foreign ciphertext (G1-04, 2026-10-31)

Source only; not installed; not verified; no fixture added. A new thread key without an issuer binding used to fail with `account_scoped_input_owner_unknown` whenever its input carried encrypted reasoning, which is the normal shape of a Codex child forked from a parent's history. When ciphertext inside a full input history is the only account-bound carrier, `external-pool-state.ts` now strips it with the existing `scrubAccountChange` path and binds the new thread as `portableHistory`, so later requests keep being scrubbed. `previous_response_id`, provider conversation IDs and uploaded files still refuse, because their state lives on the provider side. The parent thread is still never used as proof of an account. The child loses prior reasoning ciphertext and keeps the readable history. `[agents] enabled=false` in the user config was not changed.

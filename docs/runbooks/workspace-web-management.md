# Owner-bound Web asset manager

This optional Workspace MCP capability reuses an existing fixed browser manager for
Projects, personal instructions, owner-created personal skills, explicit-request
conversation title management and exact private-plugin deletion. Plugin creation
and updates use the existing native plugin creator. Tool publication and a completed
remote lifecycle are separate acceptance evidence.

The normal generic terminal remains under its existing OS sandbox. No unrestricted
terminal mode, ACL expansion, copied interpreter, alternative root or RDC fallback
is activated by this capability. A named host capability is a distinct owner-bound
API; it must go through normal runtime deployment and private app publication.

## Exact authority

The existing business-full config may opt in with `webManagement.enabled: true`,
`bindingFile` and its exact `bindingSha256`. No tools are added to disabled configs
or personal-read-fetch. The binding must be an owner-controlled regular JSON file
outside the registered remotely writable workspace. Its schema is:

```json
{
  "schemaVersion": 1,
  "kind": "aicc-web-management-owner-binding",
  "executionBoundary": "owner-registered-fixed-web-manager",
  "bindingId": "owner-operation-binding",
  "workspaceAlias": "REGISTERED_ALIAS",
  "workspaceRoot": "ABSOLUTE_REGISTERED_ROOT",
  "account": "REGISTERED_ACCOUNT_ALIAS",
  "identityHash": "SHA256",
  "workspaceIdentityHash": "SHA256",
  "allowedActions": ["project-inspect", "instructions-inspect"],
  "blockedRequestHashes": [],
  "blockedAssetKeys": [],
  "node": "ABSOLUTE_REGISTERED_NODE",
  "nodeSha256": "SHA256",
  "entry": "ABSOLUTE_FIXED_MANAGER_ENTRY",
  "entrySha256": "SHA256",
  "config": "ABSOLUTE_FIXED_ACCOUNT_CONFIG",
  "configSha256": "SHA256",
  "dependencyPins": [{"path": "ABSOLUTE_REVIEWED_DEPENDENCY", "sha256": "SHA256"}],
  "operationDirectory": "ABSOLUTE_OWNER_ONLY_OPERATION_DIRECTORY"
}
```

Review all entry/config/dependency pins as the complete fixed runtime closure,
including browser library, lease helper and receipt validator. Those files and the
operation directory must be outside the remote workspace. Protect owner config,
bindings and runtime files using the normal installer ownership policy; a hash
alone does not establish filesystem ownership. Register denied request hashes and
exact asset keys from prior incidents. An empty denial list is valid only when the
owner has no outstanding denied operations for that binding. This API does not
resolve, replay or delegate a previous safety denial.

## Invocation

For workspace-local package catalogs, SHA calculation and repeatable request JSON
preparation, use [the PowerShell request preparer](web-asset-request-preparation.md).
It uses these existing tools and never launches the browser manager through generic
exec. Package candidates and completed remote installations remain separate states.

Open the exact registered workspace with its existing writer authorization. Write
a request JSON under a non-hidden workspace path. The request supplies the fixed
manager's action fields, never its executable, account, identity, config or output.

Call `aicc_web_management_start` with the existing write lease, a Windows-safe
8–128 character request ID, relative `request_path` and exact file SHA256.
Poll `aicc_web_management_status` with the same workspace/read lease and
`operation_id`. Status calls do not consume a new write request ID. Repeated
start calls are unnecessary; the outer writer authority independently refuses
reused write IDs. A same-ID request reaching the executor never dispatches twice.

Mutations require `commit: true` and a regular `backupReceipt` inside this workspace.
Its bundle and optional Notion inline proof paths must also stay there. The fixed
manager still requires actual GitHub and Notion byte-readback receipts bound to
before/desired bytes. No confirmation override or fabricated VERIFIED flag is
introduced. Deduplicate backups by the existing bundle hash before uploading.

Sources must identify regular in-workspace files by exact filename, SHA256 and
byte count. Projects require the `w-` prefix and `memory: "default"`. Instructions,
source design and recovery follow the existing project-management skill. A created
shell returning `CREATED_CONFIGURATION_PENDING` still needs exact-ID configuration.

Personal skills use `personal-skill-list|inspect|plan-file|plan-add-file|upload|update|update-body|add-file|delete`
with a `skill` object containing only the existing companion's asset fields.
`file`, `bodyFile` and `descriptionFile` each require their matching `SHA256` field.
The preparer accepts bounded `project-source-read` and `personal-skill-plan-file`.
Source read uses a stable `read-` ID derived from the request SHA because it
downloads remote bytes. The support-file plan binds an exact existing Markdown
path, full preimage, desired bytes and a verified backup. Its original request
ID and returned `plan_sha256` bind a later `personal-skill-update-body` apply.
An uncertain original operation must be reconciled without a fresh ID. Source
support does not prove the pinned manager, owner allowlist, publication or
ChatGPT call has these actions installed.

The fixed host supplies the account, owner config, runtime library and identity
check. Delete additionally requires `confirm: "DELETE:EXACT_SKILL_ID"`.

Title operations use `title-inventory|read|rename` and a `title` object. Every call
requires the user's explicit title-management request. Inventory accepts literal
title/date/ID filters; reads export only to a registered non-hidden directory.
Rename requires the exact old/new title and actual native-content or local-import
reading evidence. Its backup binds both title byte sequences. No scheduled or
implicit renaming is introduced.

The Windows lease helper invokes its exact sibling identity guard in the current
PowerShell process, resets and observes its exit code, and parses the returned JSON.
A parent Node process resolving `pwsh` does not prove nested PowerShell command or
Windows Store executable activation works in that service environment. Deploy the
helper and guard together in the pinned fixed-manager release. Keep source modules
separate where their `import.meta.url` command-line guards depend on file identity.

Refresh the existing owned app's action metadata through its supported refresh
control. Read the actual remote tool names and enabled state afterward. A version
or publication step is needed only if that app's actual review state requires it;
do not create a duplicate app to refresh its tool catalog.

## Unknown outcome and publication

Durable dispatch intent precedes one shell-free fixed process launch. Results and
locks live outside the remote workspace. A service restart with an unobserved
request never resends it. Unknown results retain the single-writer lock. Observation
timeout/output overflow marks the request unknown without killing a browser worker
mid-save. Reconcile the same target/result before any owner-led recovery.

`COMPLETED` means the process returned a readable result, not that the whole user
goal is done. Inspect `result.status`, the remote readback and pending configuration.

Before activation, prepare immutable runtime and owner binding through normal
AICC deployment, preserve the active helper and unrelated components, and obtain
fresh operation-specific rescue READY if the current connection will restart.
Prepare-AiccWorkspacePublish includes the enabled tools in the actual manifest.
A published app's tool metadata requires its supported action refresh and any
review actually required by the app; editing a skill or restarting the local
service alone does not publish these tools.
Use ordinary Chat and the requested Extra High for the actual new-tool canary.
Do not mark complete before real CRUD, backup readbacks and cleanup are observed.

<!-- fixed-request-boundary-current:start -->
## 일반 Chat 요청파일과 로컬 CLI 입력의 구분

일반 Chat의 `aicc_web_management_start`는 소유자가 고정한 관리기만 실행합니다. 가장 작은 조회 요청파일은 다음과 같습니다.

```json
{"schemaVersion":1,"action":"instructions-inspect"}
```

등록된 정확 workspace에서 이 파일의 상대 경로와 실제 바이트 SHA256을 start에 전달합니다. 계정·신원·실행기·config·resultFile은 provider가 고정 binding에서 채웁니다. 로컬 CLI 입력 예제의 `account`, `identityHash`, `workspaceIdentityHash`, `config`, `resultFile`, `slotPort`, `allowBrowserStart`를 이 요청파일에 복사하면 `Unknown management request field`로 거절됩니다. CLI 지원 추가가 설치된 MCP 계약의 자동 확장을 뜻하지 않습니다.

수정은 fresh 조회 뒤 기존 지원 action의 변경 필드·preimage·검증된 백업 영수증을 추가합니다. 생성 파일·backupReceipt와 그 실제 복구 파일은 등록 workspace의 비숨김 경계 안에 있어야 합니다. 홈 상태 폴더의 로컬 CLI 영수증 경로를 그대로 넘기지 않습니다. before/desired 실제 원문과 GitHub·Notion 양쪽 VERIFIED를 유지합니다.

파일 작성 실패와 관리기 입력 거절은 별개입니다. 실제 오류 코드·원 request ID·대상 상대 경로·작성 여부를 남깁니다. 도구의 명시적 보안 거절은 경로나 executor를 바꿔 우회하지 않습니다. 원 응답이 보존되지 않았으면 거절 주체와 권한 원인은 미확인으로 기록하며 일반 오류를 권한 부족으로 단정하지 않습니다.

Workspace 패치 실패는 `diagnostics.code/stage/writeState`로 형식·경로 확인·사전 검사·준비·실제 적용 단계를 구분합니다. `NOT_STARTED`는 패치 쓰기를 시작하지 않았다는 뜻이며, 준비/적용 실패의 `UNKNOWN`은 일부 디렉터리나 파일 변경 가능성을 보존합니다. `PATCH_PREFLIGHT_FAILED`만으로 보안 거절이나 소유권 문제를 단정하지 않습니다. 이 진단 source 변경은 설치된 provider의 변경이나 과거 오류 원인의 증거가 아니며, 원 요청은 자동 재생하지 않습니다.
게시 준비기의 manifestScope=workspace-provider-only는 Workspace 제공자 계약 범위다. 설치된 통합 gateway의 host 도구는 installedHostRegistration에서 따로 읽으며, 두 값을 같은 전체 도구 수로 해석하지 않는다. Tunnel이 응답해도 source/installed identity 차이로 게시 사전검사가 attention일 수 있다. 실제 도구 호출 성공과 정식 배포 준비 증명은 각각 기록하고, identity 차이를 재시작이나 pin 덮기로 없애지 않는다.
### 일반 Chat의 로컬 편집과 명령 실행을 따로 인수하기

등록 alias의 write lease를 열고, 관련 파일과 기존 변경만 읽은 뒤
`aicc_workspace_apply_patch`로 수정하고 같은 도구의 read로 결과를 확인합니다.
이 도구는 `--- a/path`·`+++ b/path`·`@@`가 있는 **통합 diff**를 받습니다.
`*** Begin Patch` 형식을 그대로 넘기지 않습니다. 새 파일의 이전 경로는
`--- /dev/null`입니다. 경로는 열린 workspace 안의 상대 경로만 사용합니다.

파일 수정 성공은 `aicc_workspace_exec` 성공을 뜻하지 않습니다. 명령이 session을
반환하면 원 session과 output cursor를 이어 기다리고 같은 명령을 다시 실행하지 않습니다.
sandbox 준비 중 하위 경로의 접근 거부가 나오면 그 경로·단계·원 request 결과를
보존합니다. 읽기·패치의 성공과 실행 실패를 별개로 보고하며, 다른 executor 사용,
ACL 확대, 민감 경로 검사 생략으로 통과시키지 않습니다. 등록 workspace 소유자가
기존 지원 절차로 원인을 조정한 후에만 새 실행을 인수합니다.

프로젝트 인계에는 목표·exact root·담당·변경 파일·검사/적용 결과·남은 장애와
원 결과 위치만 넘깁니다. 대화 전체나 반복 상태 조회를 새 모델 작업으로 보내지 않습니다.
작업을 끝내면 소유한 실행 session을 회수하고 workspace lease를 닫습니다.

### 게시 전에 소스·설치·원격 목록 구분
기존 `node tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs --json`의 publication은 Workspace 제공자 소스 계약이다. installedRegistration은 현재 등록 gateway의 manifest/config 및 dependency pin을 대조한 제공자별 이름 목록과 합계다. VERIFIED_NAME_REGISTRATION은 전체 입력 schema, 실제 원격 게시 또는 도구 실행을 검증했다는 뜻이 아니다. 경로·신원·명령·키를 출력하지 않고 불완전한 pin/링크/중복은 NOT_VERIFIED로 표시한다.
원격 목록은 기존 등록 앱 관리기의 schema 결과와 대조한다. 새로고침 성공(PASS_REFRESH_REQUEST)과 새 게시 완료는 구분한다. 초기 refresh의 requiresReviewedPublication은 후속 확인이 필요한 보수적 표시이며, 읽기 전용 admin-inspect --publish-review는 정확한 소유자·앱·workspace에 결속된 관리 화면과 그 화면이 받은 설정 응답을 읽는다. 검토 버튼이 없다는 사실만으로 완료하지 않는다. 정확 API200/전체 기대 개수/활성화와 actionsChangedSinceReview=false가 모두 확인되고 열린 검토창이 없을 때만 EXISTING_REVIEW_RETAINED로 표시한다. 이는 새 게시·전체 도구 이름·실제 도구 실행을 입증하지 않으므로 각각 별도 근거를 둔다. 변경 있음·잘못된 신원·불완전 응답·불명 창은 HOLD를 유지한다. 기대 개수나 확인란 수를 추측하지 않고 비활성화 검토를 게시 검토로 사용하지 않는다. 정확 현재 계정별 schema·계약·단회 요청·게시 상태는 기존 비공개 원장과 제품 current가 소유한다.

## Source-read/plan-file의 설치 전 owner-binding 준비

`tools/platform/workspace-mcp/Prepare-AiccWebManagementBinding.ps1`은 기존 binding과 별도 manager binding의 exact SHA를 입력받아 `aicc-web-management-binding-preparation / DRAFT_NOT_INSTALLABLE` 파일 하나를 create-once로 작성한다. 출력 폴더는 미리 존재해야 하며 원격 writable workspace 밖이다. 실제 config·binding·runtime·registry·Task·ACL을 바꾸거나 manager/browser를 실행하지 않는다. 준비 파일 자체는 owner binding schema도 updater의 `PREPARED_NOT_ACTIVE` candidate schema도 아니므로 등록 입력으로 전달하지 않는다.

```powershell
# 아래 값은 기존 owner operation이 지정한 exact 절대경로와 승인 SHA다.
& tools/platform/workspace-mcp/Prepare-AiccWebManagementBinding.ps1 `
  -PreviousBindingFile $previousBinding -ExpectedPreviousBindingSha256 $previousSHA `
  -ManagerBindingFile $managerBinding -ExpectedManagerBindingSha256 $managerSHA `
  -OutputFile $newOwnerLocalPreparationFile
```

준비기는 기존 action 순서와 identity/workspace/account/node/operationDirectory/limits를 유지하고 추가 동작을 `project-source-read`·`personal-skill-plan-file` 두 개로 한정한다. 기존 blockedRequestHashes/blockedAssetKeys는 제거할 수 없다. 제안된 entry/config/dependencyPins는 원 manager binding에서 가져오되 실제 closure 수용을 주장하지 않는다. 기존 updater의 action delta에도 `personal-skill-plan-file`을 포함한다. 이 수정은 source 허용 목록이며 설치판의 허용 목록 확장이 아니다.

후속 owner는 source-read와 plan-file을 실제 제공하는 같은 고정 manager의 새 immutable closure를 materialize/seal하고, 현재 provider의 실제 contract/toolHash와 기존 native/host graph를 보존한 후보를 정상 경로로 준비한다. manager account config 권위 보존, 원 차이와 rollback bytes의 GitHub·Notion VERIFIED, fresh independent READY·device lease·root normal completion·idle/unknown·owner CAS·one signal/no replay는 기존 updater 계약 그대로다. 과거 source-read 후보의 20 action과 현재 설치판의 19 action, 두 동작을 제안한 21 action 초안은 서로 다른 산출물이다. 오래된 candidate나 준비본을 새 plan-file 설치 근거로 재사용하지 않는다.

provider API의 두 도구 `aicc_web_management_start/status`, 요청 JSON의 action, owner binding의 allowedActions, 고정 manager 구현, 설치·등록판과 원격 schema/실호출은 별도 층이다. action 추가는 MCP tool 이름 개수 증가를 뜻하지 않는다. 기존 Source 원불명·same-ID 누락 지원파일·거절 대상은 준비나 설치로 해제되지 않는다. browser offline의 의도가 불명이면 기동하지 않는다. 새 준비 source는 검증 미실행·미실행이며 실제 생성/설치 수용을 주장하지 않는다.

Add-file source preparation now supports an explicit `-AdditionalActions` choice of
`personal-skill-plan-add-file` and `personal-skill-add-file`. Omitting this option
preserves the original two-action draft. A selected action is only a proposal;
installed allowedActions remain unchanged. See the request-preparation runbook for
file/tree preimages, receipt path binding, fixed companion adapter and remaining
private-dispatcher sealing. No manager launch or external dispatch is part of preparation.

### Frozen Workspace generation recovery

`Repair-AiccWorkspaceRuntime.ps1` repairs a closed failed generation without installing a candidate or changing any installed files. Prepare pins the complete current provider graph, Task definition, owned process identities and one explicitly selected unresolved patch. It refuses any active/reconnecting call, additional unknown, foreign generation or changed preimage. Apply requires a fresh independent worker READY, preserves the old journal and UNKNOWN verbatim, stops only the exact owned generation, proves process exit and starts the identical original Task once. This is a planned maintenance stop, not a successful drain or proof of the old patch result.

The unresolved-operation receipt remains permanent and the old replay records are not removed. Historical UNKNOWN count remains one; a new generation's admission counters are reported separately. Never replay the original request or label it successful because connection recovery worked. A later plugin update must still satisfy the formal updater's admission gates and obtain a fresh consumed drain with no active or unknown calls in the current generation. Prepare, backup, independent READY and live verification are separate acceptance stages.

### Nested patch parent overlay

The explicit `workspace-patch-parent-update` candidate changes only
`components/workspace-mcp/platform-ops.mjs` and the two release hash manifests.
It uses the existing inventory and graph-preservation verifier. The shared
version-one overlay proof retains its `brokerSecurity` field names for compatibility;
the candidate kind selects the exact reviewed module hashes and `patchParentOverlay`
manifest metadata. It cannot be used to install an arbitrary module revision.
Actual source test output, test bytes, source bytes, before/desired inventories,
configuration and rollback bytes must be in the verified recovery bundle.

Every hunk is validated before missing directories are created. Parents are
created individually within the workspace, with directory/link checks, and only
newly created empty parents are removed on failure. Existing text and permissions
remain unchanged by a rejected patch. Installed revisions without this overlay
require creating the parent directory explicitly through `workspace_exec` first.

This candidate requires the same two-destination byte-verified backup, fresh
independent READY, owner CAS and consumed empty current-generation maintenance
state as the security overlay. Invalid backup authentication is a HOLD, not a
reason to relabel a receipt VERIFIED or reuse another candidate's backup. Source
acceptance, candidate preparation, installation and ordinary Chat use are separate.

### Explicit Windows owner command approval

When the user explicitly approves running commands with their Windows user
permissions, the patch-parent candidate may pin a private
`workspace-owner-command-approval/v1` record. The only configuration change is
`permissions.commandIsolation: appcontainer-windows -> owner-unrestricted-windows`;
existing network/command permissions, registered roots and manager identity remain
unchanged. This is a deliberate owner configuration, never an automatic fallback
after a denied sandbox command. Read-only leases and destructive-command checks
continue to apply. This mode does not enforce an OS filesystem sandbox.

`workspace-owner-environment-update` then permits the exact reviewed server and
`windows-owner-environment.mjs` module, the exact reviewed runtime-integrity
source-list entry and their two manifests. Before maintenance, the installer
runs the candidate's actual static import-closure audit. It restores
Windows native executable discovery (`ComSpec`, `PATHEXT`, runtime PATH) and UTF-8
output in that explicitly approved mode. Full inventory, exact graph preservation,
source acceptance, fresh independent READY, consumed empty admission and rollback
checks still apply.

### Durable store size and writer contention repair

`workspace-store-checkpoint-update` permits only the reviewed
`src/jobs/durable-store.mjs` bytes and their two release manifests. Owner config,
provider code, the host runtime and unrelated dirty source changes must remain
unchanged. Its exact candidate requires byte-verified GitHub and Notion recovery
backups, passing candidate tests, fresh independent READY and an empty consumed
current-generation gateway drain. The owner-local backup exception does not apply.

The WAL checkpoints at 8 MiB or the existing record-count limit. A single state
larger than that cap remains intact; the cap must never truncate state or hide
integrity failures. The store waits up to two seconds for a foreign live writer
before mutation begins. Nested writes in the same process fail immediately, and
unreadable/live lock files remain protected. Waiting never retries a mutation or
replays an UNKNOWN delivery. A failed lock acquisition is an error to reconcile,
not permission to remove the lock or repeat a tool request.

After installation, distinguish the exact installed module hash, new runtime
readiness, an actual Workspace write/read/command/cleanup/close sequence, and a
complete ordinary Chat response. A successful local tool sequence alone does not
establish that ChatGPT login, saved response collection or ordinary Chat use works.

### Empty-generation transport recovery

If an exact host install consumes an empty drain but then refuses before mutation
with `Runtime ownership changed`, do not edit its plan or relax the ownership
comparison. Completed command children can legitimately disappear between Prepare
and Apply. `Repair-AiccWorkspaceRuntime.ps1 -Mode Prepare -EmptyDrained
-FailedInstallDirectory <exact failed owner operation>` supports this specific
recovery. It requires PREPARED with zero start attempts, the original refusal,
the unexpired original consumed operation, unchanged owner files/Task, no live
write lease and exact current process ownership. A fresh independent worker must
accept the recovery plan before Apply restarts the identical installed graph.
Preserve the failed operation and original UNKNOWN records; then prepare a new
install against the new generation. A new install plan cannot claim the old
consumed drain, and `resume` applies only to DRAINING, never CONSUMED.

The same empty-generation recovery accepts an exact queue update or owner
replacement rejected with `QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN` while its
journal is still PREPARED with zero start/rollback attempts. Preserve the actual
refusal in `apply-error.json`. Original operation binding, unexpired consumed
state, unchanged owner files/Task, zero active/unknown work, no live write lease,
independent READY and installed dependency pins still apply. Recovery restarts
the identical installed graph; it does not install or authorize the refused
candidate or weaken its original issuer check.

If tunnel health is ready while actual initialize/tools calls return upstream 502
before gateway admission, do not broaden filesystem permissions. The existing
`Repair-AiccWorkspaceRuntime.ps1 -Mode Prepare -EmptyDrained` path prepares a
restart of the identical installed Task and provider graph. Preparation requires
the exact open initialized three-provider generation, zero active/reconnecting/
unknown calls and no unexpired writer lease, read from the durable store and WAL.
It does not revoke another writer or clear historical UNKNOWN records.

After a real independent recovery worker accepts that fresh plan, use
`Invoke-AiccUnifiedMaintenance.ps1` with its exact operation/nonce/expiry to begin
and consume an empty drain. Apply requires that consumed state, matching gateway
identity, Task/config/dependency hashes, unchanged process ownership and no live
writer. It preserves the original journal, stops only that owned process tree and
starts the unchanged Task once. Record process/readiness and actual remote tool
calls separately; ready endpoints alone are insufficient. Use the same plan's
rollback if stop succeeds but the start has not yet been attempted. A recorded
start intent must be reconciled rather than replayed.

An explicit user decision to defer GitHub backup can be represented by a
`workspace-owner-approved-local-backup/v1` receipt for these two owner candidates
only. The bounded approval binds the exact task, backend and config hashes.
Every required recovery file is copied and hash checked locally. GitHub status
remains `DEFERRED_BY_USER`; it is never relabeled `VERIFIED`. Without that exact
approval, the existing two-destination backup requirement remains unchanged.

### Process exit and output completion

Workspace command results distinguish an observed OS child exit from closed
stdout/stderr. `os_exit_code` and `os_exit_signal` report only the actual child
`exit` event. `process_running=false` means that exit was observed, or the session
already reached a terminal state; a null value means the OS exit is not known.
`output_complete=true` is set only by the child `close` event. The existing
`running` field remains conservative until that close, so incomplete output keeps
Workspace close blocked. Actual late output remains readable. No exit code is
inferred from a missing PID, and a signal exit is never reported as success.

After an observed exit the process timers are cleared and later stop/input calls
do not signal or write to the exited child. This prevents accidental signaling
of a reused PID. An older installed broker without these observations cannot
recover an original exit code from a source update; preserve its original unknown
result and capability expiry separately. Source tests, installed provider hashes,
new-session behavior and historical request reconciliation are separate evidence.

### Queue tools: prepare without replacing the installed backend

`Prepare-AiccGptQueueRuntime.ps1 -OperationDirectory <new owner asset-control directory>`
stages the queue delta over the current managed Workspace generation. It preserves
unrelated installed fixes and records complete before/after inventories.
`Verify-AiccGptQueueRuntime.mjs <stage.json>` checks exact source pins, import
closure, release metadata and actual in-memory MCP tool lists. These steps do not
enable tools or send messages.

After `Prepare-GptQueueOwnerBinding.mjs` has inspected the two actual leased saved
conversations, pass its original receipt to:

```powershell
./tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1 `
  -StageReceipt <stage.json> -OwnerPreparedReceipt <prepared.json> `
  -ExpectedOwnerPreparedSha256 <exact SHA256> `
  -OperationDirectory <new owner asset-control directory>
```

This creates and validates an immutable gateway/config candidate. It preserves
the existing manager binding, host/native providers and owner permissions, adding
only the five business-full queue tools. A missing target, stale binding or
unfinished original request must be reconciled; never fabricate owner evidence.
Candidate preparation is not installation. The existing
`Update-AiccWebManagementRuntime.ps1` remains the only Apply/Rollback path, with
reviewed backup in both existing destinations, fresh independent READY and an
exact consumed drain. Check actual Chat tool exposure and delivery separately.

Queue target ownership expires independently of the installed code. Prepare and
Apply must reject expired or substituted owner proofs before accepting a candidate.
Closing the two owned tabs also ends their use for dispatch; a saved conversation
URL alone cannot renew that authority. Do not install an expired binding or edit
its sealed proof timestamps. Reacquire the original owner's exact targets through
the registered lease issuer and prepare a new reviewed binding, or leave activation
pending until the owner refresh contract is available. Historical backup receipts
remain valid backups of their original bytes, not current dispatch authorization.

For the same original request and the same still-owned targets, the owner may run
the preparer with `--verify-current-only true` and the exact prior receipt/SHA
to inspect current issuer ownership after a long immutable verification. This
read-only mode validates the complete original request, private history, native
pins and both current identities, then returns bounded observation times without
writing a generation, changing config, registering or authorizing execution.
Its result is an observation, not a replacement deployment candidate or permission
to install an expired binding. Updater/runtime integration remains a separate
required step; do not skip existing freshness gates based on this result.

To publish a new immutable proof generation instead, the owner may run
`Prepare-GptQueueOwnerBinding.mjs` with its original arguments plus
`--prior-receipt <prepared.json> --prior-receipt-sha256 <exact SHA256>`.
The preparer verifies the complete historical binding/proofs, exact request and
native installation pins, then asks the registered issuer to inspect both targets
again. Account and workspace identity must match the prior proofs. It writes a new
immutable generation linked to the prior receipt, preserving the operation, role
definitions and derived native run ID. It never extends old timestamps, overwrites
old evidence, changes installed config, or registers/activates a run. Repeating the
same observation is refused as an existing preparation, requiring reconciliation.
Released or closed targets, unavailable issuer, changed accounts/native pins and
substituted history remain HOLD. A different target needs a separately authorized
rebind contract; this refresh does not substitute one. Use the new receipt for a
new reviewed deployment candidate and backup. Fresh evidence is still required
at Apply and queue activation; the original UNKNOWN request remains preserved.

If the original temporary targets were released, prepare a new private request
with the same operation/binding/owner, accounts, workspaces, conversations, role
IDs, title and prompts. Only target ID, target nonce and lease token may change.
Pass its SHA and the original preparation plus
`--rebind-from-request <original private request>` and
`--rebind-from-request-sha256 <original SHA>` to the same preparer. Both new
targets must be acquired and verified by the registered issuer. Old files remain
immutable. This path queries the installed native run before and after inspection
and accepts only an explicit RUN_NOT_FOUND. An existing run, unknown result,
changed identity or task definition stays HOLD; no cancellation, registration,
activation or dispatch is attempted. A newly prepared candidate and reviewed
backups are required. This is owner-local preparation for an unregistered task,
not a way to replay a prior uncertain delivery.

Deployment verification can exceed a target proof's two-minute lifetime when it
hashes the complete baseline and candidate inventories. A proof accepted at entry
does not remain fresh at exit. Preserve that failed candidate and its source
evidence; do not extend sealed timestamps or treat file verification as a live
lease check. The remaining integration must re-inspect current issuer ownership
after long verification and before cutover, retaining exact account/target checks
and failing if the target was released. Candidate preparation alone is not proof
that this final operational check is implemented in the installed service.
The owner replacement source now rechecks both targets after the complete inventory
and reconciles the exact Native read-only terminal state. No production cutover is implied.

### Queue owner binding replacement (already-installed five tools)

The explicit replacement operation is distinct from the first queue overlay install.
The existing business-full config.gptQueue.enabled must already be true. The desired
owner config changes only gptQueue.bindingFile and gptQueue.bindingSha256; the
installed Workspace backend, permission scopes, web-management binding, Host/Native
provider graph, tool names and tool schema/hash are preserved. Previously canceled
or completed operation, immutable owner receipts and sealed proof bytes are retained.
Never reuse/re-register the historical g1-queue-canary-20261111-a (CANCELLED_UNSENT)
or any UNKNOWN operation. New acceptance requires a new binding and operation ID.

Use the existing Prepare-AiccGptQueueDeployment.ps1 with the following exact flags:

```powershell
./tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1 `
  -ReplaceExistingOwnerBinding `
  -OwnerPreparedReceipt $newPrepared `
  -ExpectedOwnerPreparedSha256 $newPreparedSha `
  -PreviousOwnerPreparedReceipt $previousPrepared `
  -ExpectedPreviousOwnerPreparedSha256 $previousPreparedSha `
  -ExpectedPreviousBindingSha256 $previousBindingSha `
  -NativeUpgradeEvidenceFile $nativeUpgradeEvidence `
  -ExpectedNativeUpgradeEvidenceSha256 $nativeUpgradeEvidenceSha `
  -ExpectedInstalledConfigSha256 $configSha `
  -ExpectedInstalledRegistrySha256 $registrySha `
  -ExpectedInstalledBackendReleaseSha256 $releaseSha `
  -ExpectedInstalledDriveManifestSha256 $driveManifestSha `
  -ExpectedInstalledGatewayConfigSha256 $gatewayConfigSha `
  -ExpectedInstalledGatewayManifestSha256 $gatewayManifestSha `
  -OperationDirectory $newOwnerAssetControlOperation
```

The owner-local Native upgrade attestation is pinned to its own immutable file
(kind aicc-gpt-queue-native-upgrade-readback/v1; status INSTALLED_VERIFIED). It
requires ownerBoundActivation=true, exact installed Native executable/config/
manifest SHA, current registered manifest, original binding SHA, a separate exact
installReceiptFile/SHA and currentGraphFile/SHA. Attestation by itself is not
proof of an actual installed host; the validator also reads the current native
registration and requires the installed host to return owner activation capability.

During preparation and before Apply, only Native orchestration_capabilities
and exact orchestration_get of old/new derived run IDs are allowed. Old run
must be terminal canceled without dispatch or completed with full message
readback and no UNKNOWN. New run must be definitively RUN_NOT_FOUND. Registered,
active, unknown, missing native, changed owner or unavailable issuer => HOLD.
Both target slots 9222/9223 must be proven by the current issuer after expensive
verification, not only by sealed historical observedAt/expiresAt.

The new candidate kind workspace-gpt-queue-owner-replacement is source-only
PREPARED_NOT_ACTIVE: it pins the original installed backend inventory and release
manifests, registry/config/graph CAS, new prepared proof and old proof SHA.
Only the desired Workspace config pin and gateway-profile path advance as the
existing immutable gateway replacement contract requires. All Native/Host
provider files, permissions and full actual MCP tool hash remain unchanged.
Reviewed GitHub/Notion backups, the current updater Prepare, independent READY,
consumed active/unknown-zero drain, Apply and rollback gates still apply.
Preparation does not install, restart, register, activate, dispatch or send.

Legacy registration-only predecessors without ownerBinding require explicit
LegacyCancelReceiptFile / ExpectedLegacyCancelReceiptSha256 preparation inputs.
The sealed original request must reproduce the exact run definition and owner;
the native run must be cancelled, paused, with attempt zero, empty history and
no activation, claim, dispatch, result or uncertainty fields. Its immutable
CANCELLED_UNSENT receipt must match the current revision and both original roles.
Missing evidence remains HOLD. This branch never updates or replays the old run;
owner-bound completed/cancelled checks retain their existing strict contract.
The cancellation receipt joins the reviewed recovery bundle; the original request
with lease credentials stays in the sealed local owner store.

#### Unregistered same-operation owner rebind (separate opt-in)

This is NOT terminal cancelled/completed replacement. It applies only when the
currently installed operation has NEVER registered in the original Native ledger.
Closed/unproven CDP targets cannot by themselves establish registration absence.

The existing private Prepare-GptQueueOwnerBinding.mjs accepts
--rebind-from-request and its SHA, previous prepared receipt/SHA and obtains
fresh two-target proof. This source task does not obtain live targets.

Use the existing Prepare-AiccGptQueueDeployment.ps1 inputs above with BOTH
-ReplaceExistingOwnerBinding and -RebindUnregisteredSameOperation.
LegacyCancelReceiptFile or mixing with terminal replacement is forbidden.

Exact operationId/bindingId/ownerId/ownerIdentityHash/workspaceAlias/workspaceRoot,
and the private request title, role id/slot/conversationId/prompt/accountAlias/
browserWorkspace must remain identical. For BOTH roles only targetId,
leaseToken and targetNonce may change, and each must be replaced. Previous and
new private original requests must independently match the pinned binding
originalRequestSha256 and currentIssuer.requestSha256. Definition SHA follows
each verified title/role set including its current nonce. Native executable,
config, manifest, helper identity and account/workspace identity are preserved.

The new prepared receipt seals previous prepared receipt path/SHA, old binding
SHA, old original request SHA, new binding SHA and new request SHA, with
reboundUnregisteredRequest=true, refreshedByOriginalIssuer=true,
originalRequestDispatched=false and independently inspected two targets.
Original request and lease-token bytes stay only in the owner-private store;
external reviewed backups preserve pinned receipt and binding hashes, not raw tokens.

Dedicated unregistered Native readback checks original owner-bound capabilities
and TWO consecutive orchestration_get reads of the SAME original run ID, both
exact WEBGPT_ORCHESTRATION_RUN_NOT_FOUND. Registered/active/paused/terminal/
UNKNOWN, inconclusive or one-sided results HOLD. No register, activate, cancel
or send is performed by preparation. Prepare and candidate/Apply validation
rerun the exact native absence and sealed source-chain checks. Terminal
cancelled/completed replacement still mandates distinct old/new operation IDs.

The source candidate retains the existing workspace-gpt-queue-owner-replacement
kind with an explicit flag; only config.gptQueue bindingFile/SHA can change.
Installed config/registry/runtime/manifest/graph/tool-hash CAS, unrelated
permissions/manager/Host/Native providers, reviewed GitHub/Notion backups,
independent READY, consumed active+UNKNOWN-zero drain and immutable updater
Prepare/Apply/Rollback gates remain unchanged. Private original requests stay in
the sealed owner-local store; remote recovery contains their pinned hashes and
prepared receipts, never leaseToken bytes. Do not duplicate the installer or Native ledger.

Status is source-only: closed targets have not been reacquired; no live
production candidate, registration, activation or model dispatch was executed.
The central owner must independently prepare fresh current issuer evidence
and satisfy existing owner backup/READY/drain/CAS before any Apply or canary.

### 2026-11-14 Installed queue provider-only diagnostic update (source-only)

A registered business-full Workspace may already have five queue tools, an
existing gptQueue owner binding and an immutable installed release. This
generation MUST NOT be staged as a first install or disguised as an owner
replacement. Use the separate -UpdateInstalledProvider opt-in for a reviewed
change to only components/workspace-mcp/gpt-queue-provider.mjs. Existing
backend server, input/tool schema, manager, permissions, owner binding,
runtime-integrity source and Host/Native remain unchanged.

Stage source using the existing owner-only command, with all five exact
fresh SHA256 pins acquired from the CURRENT installed files and reviewed source:

    pwsh -NoProfile -File tools/platform/workspace-mcp/Prepare-AiccGptQueueRuntime.ps1 -UpdateInstalledProvider -OperationDirectory $newStageDirectory -ExpectedInstalledConfigSha256 $currentConfigSha -ExpectedInstalledProviderSha256 $currentProviderSha -ExpectedSourceProviderSha256 $reviewedSourceProviderSha -ExpectedInstalledReleaseSha256 $currentReleaseSha -ExpectedInstalledDriveManifestSha256 $currentDriveSha

The stage checks installed release file hashes, full queue integration,
config binding, and CAS. Partial, unpinned or changed baseline, no-op provider,
existing operation directory, or other file modifications are HOLD. The
generated candidate is a NEW immutable release copy, not an installed release.
Only three actual file bytes differ: provider, .aicc-release.json, and
workspace-drive-manifest.json. Other installed code is retained byte-for-byte.
Existing Verify-AiccGptQueueRuntime.mjs remains the verifier; its explicit reconciliation branch verifies the new sealed provenance without relaxing the original path.

Prepare a candidate for the existing immutable updater, with the SAME
installed owner prepared receipt and no replacement/rebind switch:

    pwsh -NoProfile -File tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1 -UpdateInstalledProvider -StageReceipt $newStageReceipt -OwnerPreparedReceipt $sameInstalledOwnerPreparedReceipt -ExpectedOwnerPreparedSha256 $sameInstalledOwnerPreparedSha -OperationDirectory $newCandidateDirectory

Do NOT combine UpdateInstalledProvider with ReplaceExistingOwnerBinding or
RebindUnregisteredSameOperation. The resulting kind remains
workspace-gpt-queue-update, with queueProviderOnlyUpdate=true. The candidate
copies the exact current config bytes, retains the original binding and
exact provider pin, and recomputes the full tool schema hash; it MUST match
the originally installed tool names and tool hash.

GptQueueRuntimeDeployment.ps1 validates the explicit mode, stage receipt,
installed provider/config/release/drive/runtime-integrity SHA, the exact
three-file inventory delta, Native/issuer freshness, gateway/config/graph
CAS, and unchanged manager/Host/Native/permissions. Those checks repeat in
the existing Update-AiccWebManagementRuntime.ps1 Prepare and Apply paths.
The existing two reviewed GitHub/Notion backup receipts, independent READY,
consumed active=0/UNKNOWN=0 drain, CAS, Task gates and rollback remain
mandatory. This source-only change does not run operational stage/Apply,
acquire target leases, register/activate, dispatch, or restart services.

#### Already-installed web-management provider baseline reconciliation (source-only)

An already applied runtime can have an immutable *historical* release manifest
whose one recorded provider SHA/size differs from the current file, even though
the **currently registered** Workspace gateway graph and the previous owner's
sealed inventory agree with the actual bytes. Historical metadata is not
authority to rewrite live code. Conversely, the current graph alone cannot
approve an unrecorded file change. Both authorities must match the same exact
one-file sealed evidence, and every other release file must still match.

The reviewed 2026-11-14 example is strictly limited to
components/workspace-mcp/web-management-provider.mjs. The release manifest
recorded ff93330827da... / 18474 bytes; the current graph, actual file,
process-lifecycle prior release, and exact prior c inventory agree on
d6399941dd56... / 18751 bytes. The older drive manifest has a still earlier
SHA for this file and may omit unrelated historical file keys. Do not
normalize, adopt or rewrite any other drive manifest entry or its history.
The source stage accepts ONLY this exact path after all checks below; a
second mismatch, unrelated file, new hash without the current graph pin,
or unsealed/changed receipt is HOLD.

The existing provider-only stage accepts a separate explicit opt-in,
-ReconcileInstalledBaseline, only alongside -UpdateInstalledProvider.
Use a fresh named asset-control operation directory and current exact SHA pins.
The prior c candidate receipt and its candidateSHA256 in prepared.json seal
inventory.before.json, whose original SHA must be verified. Never copy the
private original request or lease token into a candidate or remote backup.

    pwsh -NoProfile -File tools/platform/workspace-mcp/Prepare-AiccGptQueueRuntime.ps1 -UpdateInstalledProvider -ReconcileInstalledBaseline -OperationDirectory $freshStageDirectory -ExpectedInstalledConfigSha256 $configSha -ExpectedInstalledProviderSha256 $installedProviderSha -ExpectedSourceProviderSha256 $reviewedSourceProviderSha -ExpectedInstalledReleaseSha256 $historicalReleaseSha -ExpectedInstalledDriveManifestSha256 $historicalDriveSha -BaselineEvidenceReceiptFile $sealedPriorCandidateJson -ExpectedBaselineEvidenceReceiptSha256 $sealedPriorCandidateSha -ExpectedInstalledRegistrySha256 $currentRegistrySha -ExpectedInstalledGatewayConfigSha256 $currentGatewayConfigSha -ExpectedInstalledGatewayManifestSha256 $currentGatewayManifestSha

The stage verifies: exact managed root and current registry; previous
immutable owner replacement candidate, matching prior prepared receipt and
SHA-pinned inventory; exact current graph and gateway manifest hashes;
all registered graph file pins; exact SHA/size of the sole web provider
from the graph and sealed inventory; and the complete historical release
inventory with exactly that one mismatch. It does not change the historical
release or drive manifests. The new immutable candidate preserves the
web-management-provider bytes, changes only queue provider code, and
writes two new manifests reflecting the already-applied web provider
SHA/size while retaining every unrelated historical drive field unchanged.

The stage receipt and BOTH generated manifest proofs seal a
workspace-provider-baseline-reconciliation/v1 record including prior receipt,
sealed inventory, old/current file SHA and size, original manifests,
current registry and registered gateway config/manifest pins. The existing
Verify-AiccGptQueueRuntime.mjs rechecks current graph, original receipt,
complete inventory, actual file hashes and the exact one-file historical
mismatch; no verifier bypass or manifest wholesale adoption is allowed.
Prepare-AiccGptQueueDeployment.ps1 carries the same record in the existing
workspace-gpt-queue-update candidate. GptQueueRuntimeDeployment.ps1
revalidates it during existing updater Prepare AND Apply and requires the
prior receipt, prepared receipt, sealed inventory, current graph and
manifest bytes in the reviewed two-destination recovery bundle.

The rest of the command remains the standard -UpdateInstalledProvider
candidate preparation described immediately above. Operational staging,
backups, independently verified READY, consumed active=0/UNKNOWN=0 drain,
current issuer proof and cutover are separate central-owner actions.
This source run performed none of them.

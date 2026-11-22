<!-- portfolio-numbering:start -->
> 현재 상위 관리 그룹: G1 · AI 작업 기반 (20261102-r1). 번호 정본은 소유자의 portfolio/group-registry.json이다. 아래 날짜 있는 이전 관제/순번/동시 그룹 수/검사 제한은 당시 기록이며 현재 실행 지시가 아니다. 원 제품·요구·대화 ID와 기존 변경은 보존하고 현재 작업 범위/작성권을 먼저 확인한다.
<!-- portfolio-numbering:end -->

# Registered CDP identity bootstrap

`cdp-identity-bootstrap.mjs --mode identity-bootstrap-read-only --ports all`
is an explicit, limited inventory mode, not an authenticated-slot lease.
It reads owner-local `guidance/coordination.toml`, includes pending slots, and
keeps disabled and unregistered ports closed. Explicit inventory may inspect a
reserved workflow slot without promoting it into the authenticated pool. Normal
`Manage-CdpChromeSlotLease.ps1` eligibility is unchanged.

- It never starts a browser. Preview and start an exact registered launcher separately.
- Existing endpoint/process/profile guards run before attachment, before target
  creation and after the read. Coordination drift invalidates the operation.
- Each selected port has one private exclusive bootstrap lock and one new hidden
  task-owned target. No existing user target is selected, navigated or closed.
  The new target is closed on success/failure and belongs to the CDP connection.
- The task-owned page passively observes its own real GET responses for identity
  and account membership. It does not guess endpoints or issue additional backend
  requests. An isolated-world GET of `/api/auth/session` is a fallback only.
  User ID, normalized email, account ID and explicit workspace ID are SHA-256
  hashed inside the browser. Tokens, cookies and response bodies never leave the
  browser or get saved by the tool. No arbitrary URL/expression or mutation API is exposed.
- A ready login UI without a composer or challenge is reported as `signed_out`.
  An anonymous composer alone is not proof of authentication; a successful observed
  identity response supplies the user hashes. A session-only negative is not enough.
  A `WARNING_BANNER`-only envelope is restricted/unknown, never proof of logout.
  HTTP errors, redirects,
  unsupported shapes and incomplete identities remain `unknown`, not signed out.
- Selected account hashes require observed selection plus matching membership.
  Membership order never selects an account. Account/workspace fields absent from
  their respective responses stay null. They are never
  inferred from slot numbers, names, email domains, or the user ID.
- Results are streamed independently one port at a time, including safe error
  codes. A failed slot never discards another slot's successful evidence. Reserved
  workflow slots remain optional even when signed out or unknown and always set
  `login_action_required: false`; required slots
  without a verified alias binding fail the command. Consumers must process each
  result rather than discarding stdout based on the aggregate exit code.
  Alias comparison uses the actual normalized email local-part hash, not a guessed
  email domain. This establishes local-part agreement, not domain ownership.
  Missing explicit workspace identity is `account_only`, never replaced with the
  selected account hash. Every result keeps `mutation_authorized: false`.
  This preserves the raw `workspace_id` field as null; it is not an unconditional
  inventory HOLD. A consumer whose existing contract defines workspace-scoped
  identity as the verified selected account ID may bind that account hash to
  `expectedIdentity.workspaceIdentityHash` after selection and membership checks.
  This adapter mapping neither fabricates a raw workspace ID nor automatically
  grants mutation permissions; existing identity and authorization guards remain.
  A crashed run's lock is not automatically stolen: verify the old owner is gone
  before removing its exact private lock. Browser/account mutations stay separate.

## Windows launcher reapplication

`Start-AiccCdpChromeSlot.ps1` is the portable source for the owner-local launcher
of the same name. Existing registered command wrappers keep their current target.
It validates that the registered profile matches the deployed base launcher,
then runs extension `Ensure` with `NoStart`. An already-running slot skips the
base launcher, so repeated calls do not open another user tab or restart Chrome.

Use the exact port in this sequence:

1. `-Action Status`
2. `-Action Ensure -DryRun -NoStart`
3. `-Action Ensure -NoStart`
4. `-Action Status`

For an explicitly approved cold start, omit `-NoStart` after reviewing the preview.
The extension manager still enforces source pins, manifest identity, trusted
roots, and permission allowlists. No profile files or OS startup registrations
are edited. Session extension reapplication is not persistent installation.

After fresh successful identity verification, propose a separate private binding transaction:
exact port + registered profile identity + user/email hashes + account/workspace
hashes where independently verified + observation time + expected prior revision.
Do not promote aliases or clear pending automatically. This inventory alone does
not authorize app deletion, registration, workspace selection or route changes.

Tests: `node --test tools/platform/web-automation/tests/*.test.mjs` and
`pwsh -NoProfile -File tools/platform/web-automation/tests/Test-CdpChromeSlotLease.ps1 -AsJson`.
Launcher tests use fake commands and never launch real browsers.

## 등록 브라우저 broker — 기존 target 읽기 인수 source · 2026-10-23 KST

담당 AI 기반 개발 관제 [00000000-0000-4000-8000-000000000000](codex://threads/00000000-0000-4000-8000-000000000000).
메인01a160f7의 원요청 AI_PLATFORM_RESUME_20261022_MAIN01A160F7에 따라
Manage-CdpChromeSlotLease.ps1과 이 계약 문서·browser-slots의 필수 부분만 인수했다.
기존 dirty source의 AllowBrowserStart/PreferredPort/신원·보존 변경은 유지했다.
정비01a15385 idle 인계 근거를 재사용하고 이 exact 파일의 다른 활성 소유 기록은
기존 current에서 발견하지 못했다. 준비01a1610a의 사용자 ready 대기는 그대로다.
이번 turn ID는 01a16763-c4a4-72f0-a740-6f4134c263d3이다. 메인이15:34:41 KST 원task_complete/noerror·CLI17664exit0 근거로 회수하고 메타만 결속했다.

PRIVATE turn01a1675a-48f6-7ea1-b2f5-670ba502b264의 기존 source와
read-existing-readonly/v1 / released-task-target-read/v1 계약을 재사용한다.
Status capability는 이 소스의 구현 계약이며 설치판 지원 증거가 아니다.
새 채팅 제출과 ReadExisting은 별도 action이고 원 cadence·발신 수·HOLD·오류는 고치지 않는다.

### 미래 원요청을 결속하는 순서

1. 기존 Acquire는 broker가 직접 만든 target에만 기존 per-port lease 디렉터리 안의
   target-ID.history/creation.json을 원자적으로 남긴다. 소유자·등록 slot/profile/coordination 해시·
   endpoint·target과 쓰기 lease/target nonce의 해시를 저장하며 token·세션·응답 전문은 저장하지 않는다.
   기존 호출을 유지하기 위해 실제 신원 증명은 선택적 -RecordReadHistory로만 수행한다.
   이 옵션은 미래 읽기 인수를 준비하는 원 Acquire에서 지정한다.
   exact 새 target의 단일 session GET으로 실제 user/account 해시를 확인하며,
   account 해시를 PRIVATE workspaceIdentityHash 계약으로 사용한다. 포트/별칭으로 추정하지 않는다.
   로그인·불완전 신원·아직 준비되지 않은 페이지는 HOLD이며 자동 재조회나 navigation은 하지 않는다.
   기본 생성 이력의 identity_verified=false는 읽기 권한이 아니다.
2. 원 쓰기 lease가 살아 있는 동안 기존 immutable 원 receipt를 완성하고,
   Release -KeepTarget -LeaseToken <원 token> -OriginalReceipt <원 파일>
   -OriginalReceiptSha256 <원 bytes SHA256> -PromptSha256 <원 prompt SHA256>으로 반환한다.
   token 권한·ready/비만료 상태를 먼저 검사하고 실제 동일 신원/등록을 다시 확인한다.
   이때만 creation→원 receipt/prompt→공식 KeepTarget release를 결속한다.
   receipt는 사용자 홈 내부의 링크 없는 일반 파일, 최대8MiB·엄격 UTF-8/JSON·중복 키 금지다.
   기존 등록 sender receipt의 원 owner/target/endpoint/slot/account/workspace·발신1·cadence committed·
   user1·retryable=false·task-created target 해시를 대조한다. 첨부는 현재0건만 지원한다.
   receipt 경로·본문·error/body는 이력에 복제하지 않고 해시/필수 식별 projection만 남긴다.
   반환 이후 원 receipt bytes를 덮어쓰면 읽기 인수는 HOLD다.
   **현재 PRIVATE 제출 caller가 이 opt-in·반환 인자를 전달하도록 잇는 작업은 아직 남았다.**
   이번에는 PRIVATE·설치본을 수정하지 않았다.
3. 이후 같은 원 owner만 ReadExisting -OwnerId <원 owner> -AccountAlias <등록 별칭>
   -Workspace <등록 작업공간> -SlotPorts <exact port> -TargetId <원 ID>
   -OriginalReceipt <동일 원 파일> -OriginalReceiptSha256 <동일 SHA256>
   -PromptSha256 <동일 prompt SHA256> -ExclusiveSlot을 요청한다.
   공식 생성/KeepTarget 이력과 현재 실제 신원을 대조하고 별도의 exclusive 읽기 lease·proof를 반환한다.
   target 존재는 신원 guard 뒤 exact page만 확인하며 새 target 생성·이동·새로고침·발신은 하지 않는다.
   원 conversation API·429 재시도는 호출하지 않는다. broker는 원 user/assistant 본문을 반환하지 않는다.
   PRIVATE collector의 prompt/순서/유일 대응/URL·DOM/persistence 구분 검사는 그대로 필요하다.
4. Heartbeat는 원 token·단일 읽기 lease·미반환 이력을 확인하고 비만료 ready 읽기만 연장한다.
   Release는 읽기 lease를 별도 반환 기록으로 남기며 **KeepTarget 인자를 빠뜨려도 닫지 않는다**.
   만료된 읽기 lease/반환 불명/다른 lease/고아 read 기록은 일반 Acquire·stale cleanup도 침범하지 않는다.
   새 읽기 acquired→lease 쓰기 또는 returned→lease 제거 사이에서 실패해도 이력은 보존되어 HOLD다.
   history temp·손상·중복·경합은 자동 복구/삭제/재시도하지 않고 원 owner/broker 담당이 조정한다.

각 이벤트는 기존 lease control-plane 안에 immutable 임시 파일→원자 이동으로 기록한다.
hash chain은 broker의 정상 생성/반환 순서를 결속하며 OS 사용자 권한을 대체하지 않는다.
원 token은 기존 private lease 응답/파일에만 있고 history에는 SHA256만 남는다.
이력 기록 실패 시 생성 target과 lease를 UNKNOWN으로 보존한다.

### 현재 한계와 인수

과거 생성/반환 history가 없는 target은 **HOLD_HISTORY_UNPROVEN**이다.
이전 KeepTarget stdout·mtime·현재 탭 존재·caller receipt만으로 backfill하지 않는다.
NativeMe의 원 target도 이력 부재일 수 있어 이번 소스로 해제됐다고 주장하지 않는다.
원 GPT URL/ID UNKNOWN과 CONTROL6ad9822c API429/retryable=false 미회수는 보존·재발신0이다.
이번 결과는 broker source1·기존 문서3 작성, 검증 미실행이다.
테스트/빌드/린트/타입/import/실행/CDP·API/브라우저/사후 재읽기·위임0,
실제 lease 발급·target 조회·설치/배포·HOME helper·runtime/config·서비스/계정/route 변경0.
다음은 메인이 source를 인수하고 PRIVATE 원 caller의 미래 receipt 결속 순서/제공판을 조정하는 것이다.
설치·정식 지원 인수 전 use-web-gpt의 unsupported HOLD는 유지한다.
이번 writer/sender는 메인에 반환한다. AI+Trading 최대2그룹/전체7그룹30 유지·AI5 전체 완료 아님.
후속도 기존 OCX·모델과 CLI -C <root> -a on-request -c 'approvals_reviewer="auto_review"' -s danger-full-access, exact resume,
지침/제품/current 먼저·완료 재사용·차이만·실제 보안 거절 우회0을 따른다.

### G1 2026-11-15: exact currentIssuer task-owned target retention (source only)

Observed installed owner binding 9222/9223: original active lease absent,
valid immutable creation.json present, no release.json, and two expired
historical active proofs. Exact historical cause of lease disappearance
is UNKNOWN; creation is not an authorized KeepTarget return. Original queue
operation remains NEVER_REGISTERED / native RUN_NOT_FOUND.

Confirmed source mismatch: the existing Release -KeepTarget removes the
original write lease, while the original QueueOwnerInspect demanded the
very same active lease. Both statements cannot remain true for a future
legitimate retained target.

Two independent source and installation phases for a future authorized,
fresh exact owner rebind (NOT a replay of the old target or original request):
1. Prepare-GptQueueOwnerBinding.mjs --current-issuer true produces an active
   owner binding with targetLifecycle =
   queue-owner-keep-target-before-registration/v1, but does NOT return leases.
   The existing installed provider can verify active proofs during the
   formally authorized separate owner-replacement stage.
2. Use the EXISTING installed-provider-only update route to stage/install the
   reviewed components/workspace-mcp/gpt-queue-provider.mjs separately.
   This route allows only provider and two manifest pins; it cannot also
   replace the owner binding. Central must validate source SHA, pinned
   immutable release, backups, READY/drain, CAS and rollback.
3. The original owner can later explicitly call
   Prepare-GptQueueOwnerBinding.mjs --finalize-retained-targets true
   with the exact prior prepared receipt and SHA, installed config path
   and SHA. This is a distinct mutation mode, NEVER --verify-current-only.
   Only after exact installed-binding CAS, it invokes the existing pinned
   Manage-CdpChromeSlotLease.ps1 Release -KeepTarget exactly once per
   original task-owned ready lease, with original private request SHA.
   The manager seals creation -> bound original request -> KeepTarget release
   history without raw credentials, and verifies current CDP account,
   workspace, exact target, conversation and nonce. It then observes fresh
   original retained proof. Missing/partial/unknown outcome is HOLD, not
   a blind repeat. The original binding and config remain byte-identical.
4. The reviewed provider blocks PAUSED registration and activation on the
   lifecycle-bound binding until BOTH live currentIssuer inspections show
   OWNER_KEEP_TARGET_RETAINED with exact signed creation/release evidence.
   Legacy active-only bindings retain existing guards. No automatic target
   creation, arbitrary client authority, account switch, or model send.

Source-only fake regressions: node --test test/gpt-queue-owner-binding-prep.test.mjs
test/workspace-gpt-queue-provider.test.mjs; PowerShell fake:
tools/platform/web-automation/tests/Test-GptQueueTargetRetention.ps1 and
Test-CdpQueueOwnerUri.ps1. Source fixes alone do not change the installed
provider/helper, registered binding or failed operation. Central handles
any later verified provider-only release, owner rebind, and actual queue
registration. No global UNKNOWN completion/clearing.

### G1 2026-11-15: explicitly pinned currentIssuer helper upgrade (SOURCE ONLY)

Problem observed in the registered Workspace release: the existing
QueueOwnerInspect helper SHA d708ae20a793a0623dfb9ea11edfe10786093c3e6987f24c965749d183a3c371
does not accept -QueueOwnerRequestFile. The reviewed provider sends that
argument unconditionally; provider-only preflight fails exit 1 as
QUEUE_CURRENT_ISSUER_INSPECT_NONZERO. A new provider alone is NOT installable
against that old issuer release. The old helper and sibling identity guard are
immutable, and must never be edited in place or bypassed by omitting an arg.

New explicit, *same-operation unregistered owner rebind only* contract:
- The original owner must first obtain two fresh task-owned target leases and
  a new exact private rebind request, preserving original operation, binding,
  role meaning, account/workspace/owner, installed Native host and target
  identity. Current Native run absence MUST be verified by the existing
  official orchestration_get twice; old historical UNKNOWN/NEVER_REGISTERED
  is never upgraded to completed and is not resent.
- Prepare-GptQueueOwnerBinding.mjs --current-issuer true
  --upgrade-issuer-helper true with three exact old/new helper/guard SHA pins
  checks the trusted current open-AICC helper source and its sibling guard,
  their immutable bytes and required QueueOwnerRequestFile parameter,
  old sealed helper/guard/powershell generation, then privately creates the
  new helper/guard generation (create-once), binding and prepared receipt.
  No prior immutable release is overwritten.
- Prepare-AiccGptQueueDeployment.ps1
  -ReplaceExistingOwnerBinding -RebindUnregisteredSameOperation
  -UpgradeCurrentIssuerHelper plus exactly matching three SHA pins and all
  existing installed/predecessor/Native/graph CAS fields creates the normal
  owner-replacement candidate and prepared receipt only if the same pinned
  source metadata, target owner proof and Native twice-NOT_FOUND readback
  agree. GptQueueRuntimeDeployment.ps1 checks the SAME evidence during
  updater Prepare and Apply, plus both generation source/guard hashes and
  backup coverage. The standard Gateway/Workspace config preimage,
  reviewed GitHub+Notion backup, READY, drain and rollback are unchanged.
- The OLD installed provider ignores extra binding.targetLifecycle and
  binding.issuerHelperUpgrade metadata and accepts an OWNED_ACTIVE proof.
  It invokes the new helper without QueueOwnerRequestFile while source
  owner replacement is being validated. The NEW reviewed provider adds the
  argument and requires exact retained-history evidence before its later
  queue register/activation. Keep the two original task-owned leases alive
  until the separate post-install, explicit owner KeepTarget finalization.
- ORDER: OLD provider -> NEW owner/binding and pinned helper -> NEW provider
  in a separate provider-only candidate -> explicit KeepTarget finalization
  -> exact registerPaused -> separate activation -> native response readback.
  Existing pre-owner-change stage.json and incomplete deployment candidate
  must NOT be reused after config/install SHA changes. Provider-only stage
  must be regenerated from the then-current installed release+config.

Owner-local future command templates below are **NOT run by this source task**.
All angle-bracket inputs are distinct approved exact private evidence, not
arbitrary values. Never paste raw requests or leaseToken into reports/backups.

1. After *new* target acquisition, private exact request and fresh source
   official Native NOT_FOUND, issue the source-only owner preparation:

   node.exe tools/platform/web-automation/Prepare-GptQueueOwnerBinding.mjs --request "<new-private-request-file>" --request-sha256 <new-private-request-SHA256> --workspace-alias <registered-alias> --workspace-root C:\demo\open-AICC --native-exe "<installed-native-exe>" --native-config "<installed-native-config>" --native-manifest "<installed-native-manifest>" --prior-receipt "<current-private-owner-prepared.json>" --prior-receipt-sha256 <prior-prepared-SHA256> --rebind-from-request "<prior-private-request-file>" --rebind-from-request-sha256 <prior-request-SHA256> --current-issuer true --upgrade-issuer-helper true --expected-prior-issuer-helper-sha256 d708ae20a793a0623dfb9ea11edfe10786093c3e6987f24c965749d183a3c371 --expected-next-issuer-helper-sha256 c0aa977a8a2e08e3829957bec383e2c4be0823a5f4dbca3a841c53f196426ab0 --expected-next-issuer-guard-sha256 63e6fd6fbc34800afda4dddec561abe065bc917567a87480ddb539694219ded8

2. After matching current installed config, registry, Gateway, Native
   predecessor and receipt pins, prepare the exact one-use owner replacement:

   pwsh.exe -NoProfile -NonInteractive -File tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1 -OwnerPreparedReceipt "<new-owner-prepared.json>" -ExpectedOwnerPreparedSha256 <SHA> -OperationDirectory "<new-private-asset-control-owner-folder>" -ReplaceExistingOwnerBinding -RebindUnregisteredSameOperation -UpgradeCurrentIssuerHelper -ExpectedPriorIssuerHelperSha256 d708ae20a793a0623dfb9ea11edfe10786093c3e6987f24c965749d183a3c371 -ExpectedNextIssuerHelperSha256 c0aa977a8a2e08e3829957bec383e2c4be0823a5f4dbca3a841c53f196426ab0 -ExpectedNextIssuerGuardSha256 63e6fd6fbc34800afda4dddec561abe065bc917567a87480ddb539694219ded8 -ExpectedInstalledConfigSha256 <SHA> -ExpectedInstalledRegistrySha256 <SHA> -ExpectedInstalledBackendReleaseSha256 <SHA> -ExpectedInstalledDriveManifestSha256 <SHA> -ExpectedInstalledGatewayConfigSha256 <SHA> -ExpectedInstalledGatewayManifestSha256 <SHA> -ExpectedPreviousBindingSha256 <SHA> -PreviousOwnerPreparedReceipt "<prior-owner-prepared.json>" -ExpectedPreviousOwnerPreparedSha256 <SHA> -NativeUpgradeEvidenceFile "<approved-existing-native-upgrade-evidence.json>" -ExpectedNativeUpgradeEvidenceSha256 <SHA>

3. Only after the create-once owner-replacement candidate gets an actual
   prepared.json and reviewed source backup, use the EXISTING updater:
   pwsh.exe -NoProfile -NonInteractive -File tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1 -Mode Prepare -OperationDirectory "<new-private-updater-folder>" -CandidateReceipt "<new-owner-candidate.json>" -ExpectedCandidateSha256 <SHA> -ChangeBackupReceipt "<verified-change-backup-receipt.json>"
   Then independently satisfy the updater's READINESS/drain/plan SHA gates
   before -Mode Apply; do not infer them from the candidate or this document.
   Re-stage provider-only against newly installed config and exact release
   pins (the prior g1-queue-target-retention-provider-20261115/stage.json
   must be treated stale). No automatic follow-on mutation is authorized.

Source isolated tests: node.exe --test test/gpt-queue-owner-binding-prep.test.mjs
test/gpt-queue-runtime-deployment.test.mjs. Source test success is NOT proof
of the installed immutable release or user Chat tool delivery.


### Slow original issuer inspection
The owner-binding preparer uses the registered PowerShell resolver and allows
130 seconds for one read-only QueueOwnerInspect (previously 30 seconds).
ETIMEDOUT returns HOLD_ORIGINAL_CDP_ISSUER_TIMEOUT without printing private
arguments or replaying the inspection. This does not extend the 120-second
proof lifetime: each proof is timestamped after live identity inspection and
both proofs are checked again before use. Identity failure remains a refusal.

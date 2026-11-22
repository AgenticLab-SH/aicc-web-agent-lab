# Task-owned Windows host control

## G1 Windows actual install vs browser-process lifetime (2026-11-10)

Central accepted the latest official Host candidate through Prepare,
independent READY, drained three-provider active/unknown=0, Apply, installed
bundle SHA/runtime readiness and **real remote capabilities/workspace_list**.
That acceptance confirms **CDP default, Aside auxiliary and the registered
identity selection contract**. The older sections labeled source-only describe
the state at the time those source changes were written, not a reason to
repeat now-completed installation or tests.

The installed Host's on-demand Aside attach is established by the pinned
source path and previously accepted fake lifecycle checks; a capabilities
call alone does **not** observe a child process launch/exit or prove zero
remaining browser/Aside resources. Host session idle after 600 seconds
is not Chrome OS process idle. The current CdpLeaseProvider.acquire does
not pass AllowBrowserStart; the registered Windows launcher has a separate,
explicitly requested cold-start contract. Exact target Release is not
a whole-browser Quit. Do not infer permission to stop a listener or Chrome
from source-only wording or a returned last owned target.

Canonical Windows-versus-macOS gate, complete code pointers and safe
unverified owner/lease/OS-exit conditions are in
[browser-resource-lifecycle Windows contract](../../docs/runbooks/browser-resource-lifecycle.md#windows-등록-cdp-슬롯의-필요시-기동과-안전-반환-2026-11-10).
Original ce9a, yt_project_inspect and G3 66da holds remain unchanged.
Real OS exit, child-process ownership and same-condition RAM savings
are still unverified. No new stop/restart/daemon/port/identity policy.


## G1 original-owner Host return-evidence diagnosis · source-only (2026-11-10)

The *existing* read-only `aicc_host_operation_status(request_id,client_key)`
still verifies the exact original owner and returns the original
`OUTCOME_UNKNOWN/resultEvicted/replayed=false` without replay. For an
unreturned original `operation=open`, it now also returns `returnEvidence`:
only boolean indicators for a recorded session ID, source generation,
original lease hash and exact target hash, plus `missingProofs` ending
with `VERIFIED_NORMAL_CLOSE_RECEIPT`. The original hashes, account,
lease, PID, target, URL and session content are **not** returned.
The same boolean evidence is visible only for the matching owner's
`aicc_host_sessions(client_key).recovered` entries; other owners remain
excluded. This is a proof *checklist*, not a release, owner adoption,
new lease, terminal result, active resource measurement, or authority to
repeat the original request. A recorded hash by itself does not prove
the original result or normal close.

For the original `yt_project_inspect_20261108_01` / session
`00000000-0000-4000-8000-000000000000`, the private source owner
reported no original lease hash, exact target hash or tagged verified
normal-close return. The historical journal remains `OUTCOME_UNKNOWN`,
and `HOST_HISTORY_UNPROVEN` still blocks new opens. The official exact
owner/issuer must recover original resource and normal-return evidence;
missing proof cannot be manufactured by this diagnostic or by a new
request ID. Never fallback to Aside, infer owner from OS process parent,
or delete/backfill UNKNOWN.

The source change is additive *output only*, keeps all **8 existing Host
tools and their input schemas** and requires a separately reviewed
official pinned Host candidate/READY/drain/Apply before runtime use.
Only new synthetic proof/status tests were run, not a real Host open.
Related root pending gate: [continuity maintenance runbook](../../docs/runbooks/codex-continuity-maintenance.md).


## G1 Aside lazy lifecycle and safe return · source-only (2026-11-09)

The installed Host source is distinct from a future installed bundle. The
already-registered CDP default does **not** spawn Aside on Host init,
`aicc_host_capabilities`, `aicc_host_sessions` or CDP open. The existing
`attach(kind)` creates `StdioClientTransport` only for an admitted
`browser_backend=aside` request or a registered CUA desktop request.
Previous explicit `HOST_HISTORY_UNPROVEN` and capacity refusals occur
before that attachment; no alternate backend is attempted.

**Confirmed small source defects:** browser Aside close previously printed
`AICC_OWN_TAB_CLOSED` even without an owned `page`, and the open journal
was changed to `CLOSED` **before** `s.client.close()` acknowledged normal
executor transport return. A later close failure could therefore show a
premature return. The server shutdown path also closed every active owned
session and made another transport-close attempt even for unknown/pending
returns. These are source-level observations, not evidence that any specific
running process is an orphan.

The narrow fix refuses a missing owned page; requires normal
`await closeTab(page)` and the existing REPL ACK; then awaits exact executor
transport close (and CDP disconnect where relevant) **before** persisting
`CLOSED` and removing that session. Failure retains the original
`OUTCOME_UNKNOWN`/session `UNKNOWN` and owner capacity, without retrying
an ambiguous transport. On Host shutdown, recently active, `UNKNOWN` and
`CLOSE_PENDING` sessions are left unclosed; only an exactly owned session
past the **existing 600-second idle threshold** may be normally closed.
The existing 30-second idle poll and one-attempt guard are unchanged.
On restart an open original journal still blocks new admission; it is
never inferred returned from process disappearance, age, or empty session
memory. This fix does not add process kill, task adoption, a daemon, or a
new history reconciliation route.

**Bounded OS observation:** two `Aside`-named Windows processes ran under
the currently authenticated OS user, with `codex.exe` parent classification.
This shows neither Host task ownership nor active target leases, and
neither process was touched. The owner-scoped active Host session/lease
inventory is unavailable here without the original `client_key` and
exact owned runtime proof. A successful Stdio client close is **not** a
proof of a child PID's actual exit, unrelated process idle, or freed RAM.
Owner must prove exact process/lease ancestry and empty active+UNKNOWN
state separately before shutdown of any installed executor.

Scoped fake regression: `node --test --test-name-pattern='Aside lifecycle'
test/host-control-cdp.test.mjs` (six cases: lazy connection, normal
return ordering, transport failure, missing owned page, pending release,
active vs truly idle shutdown). New source changes do **not** change any
of the eight Host tool schemas; they still require a new officially
pinned Host candidate, independent READY/consumed drain/Apply and installed
runtime acceptance by central. No real Host open, stop/restart, lease
release, source reinstallation, or RAM saving is claimed.


## G1 CDP identity discovery (2026-11-09, source-only)

Call **`aicc_host_capabilities({})`** first. When CDP is enabled,
`cdpIdentityDiscovery.status=REGISTERED` exposes only the exact `identityIds`
from the *already pinned* `config.cdp.identities` Host allowlist. Use one
explicitly owner-approved value as `aicc_host_open.browser_identity` with
`kind=browser` and default CDP (or `browser_backend=cdp`). Never guess a
port/account name, auto-pick the first ID or treat an ID as a lease/login
proof. The ID values themselves are the sole selection handles; no account,
workspace, profile, executable, endpoint, hash, owner, token or private path
is returned. A distinct Host owner would require a distinct trusted private
binding; this zero-input tool **cannot authenticate the caller's account**.

`cdpIdentityDiscovery` reports `NO_REGISTERED_CDP_IDENTITY`,
`REGISTRY_UNVERIFIED`, `OWNER_SCOPE_UNVERIFIED`, or `CDP_DISABLED` with
`identityIds=[]`. Malformed, duplicate, different-owner or unregistered
identities are **never** offered or accepted by `aicc_host_open`. The
existing CDP target owner/in-page identity verification remains authoritative
at acquisition and observation. The explicit Aside auxiliary path remains
`browser_backend=aside` **without** `browser_identity`; it is not a fallback
for a failed CDP request or an old UNKNOWN operation.

Discovery is read-only and **does not clear history admission**. An exact
registered ID can still return `HOST_HISTORY_UNPROVEN/NOT_DISPATCHED` when
the original resource was not proved returned; preserve that journal and
do not replay/open another identity to bypass it. No new Host tools,
registry file, service or account settings were added. The capabilities
**tool description/published tool snapshot changes** (8 tools retained);
central must create and verify a new immutable Host release through the
existing official Prepare/READY/consumed drain/Apply path before advertising
this discovery as installed. Current installed Host and FBTT QA are not
tested or modified by this source-only change.

Focused synthetic tests: `node --test --test-name-pattern='identity discovery' test/host-control-cdp.test.mjs`. The related failure-stage guidance is in
[capture-operational-knowledge / 완료 근거 단계](../../guidance/skills/capture-operational-knowledge/references/문제와-해결책/완료-근거-단계.md).


## 과거 결과와 현재 점유 분리 · 2026-10-30 source

구형 journal의 결과 미확인·반환 미입증을 모든 새 작업의 점유로 취급하던 조건을 수정했다. 과거 결과는 기존 상태 그대로 원 요청 조회에 남기며, 원 request/owner/hash 일치 검사와 재전송 방지는 유지한다. 별개 새 요청의 용량은 현재 controller의 세션으로 계산한다.

- 구형 COMPLETED/OUTCOME_UNKNOWN 및 개별 session 작업의 결과 불명만으로는 새 open을 전역 차단하지 않는다. 과거 결과를 완료/반환으로 바꾸지는 않는다.
- 명시적 operation=open 기록에서 세션 반환이 미입증이면 기존 HOLD를 유지한다. 손상 journal·부분 저장 역시 원래 결속을 신뢰할 수 없어 HOLD다.
- capacity.history는 과거 상태 표시다. UNPROVEN만으로 현재 점유를 추정하지 말고 historyBlocksNewWork와 unreturnedRecordedSessions를 읽는다. historyAdmission=session-evidence-v1에서 구형 기록만 남았으면 availableSessions는 현재 세션 수로 계산한다.
- 현재 세션의 lease·불명 동작·미저장 창·기존 URL 거절·대기 순서·동일 요청 재생 금지는 그대로다.

수정 source와 회귀 시험을 작성했으며 검증 미실행이다. 설치판은 별도 pinned host.cjs여서 source 수정만으로 바뀌지 않는다. 기존 prepare-update와 등록 updater의 정확한 후보·복구·단회 적용 절차로 설치해야 하며, 이번 번들 생성·설치·실제 브라우저 동작은 미실행이다. 아래 10월24일 전역 차단 관측은 당시 이력이다.


## 운영 인수 현재 · 2026-10-24 KST

- 메인이 기존 3-provider를 보존하는 host 8도구 설치·기동과 관리기 API의 8도구 노출을 인수했다. 첫 실제 호출은 설치판 reader의 `HOST_HISTORY_UNPROVEN`으로 실행 전에 차단됐다. 아래 호환 reader 개선은 소스 작성·관련 검사까지이며 새 후보 생성/설치판 직접 수정/추가 운영 호출은 하지 않았다. 도구 노출과 실제 작업 허용·세션 반환은 구별한다.
- 설치 config가 가리키는 기존 호스트 journal 29건은 `COMPLETED` 15 / `NOT_DISPATCHED` 8 / `OUTCOME_UNKNOWN` 6이다. 모두 legacy 형식으로 `operation`·`sessionState`가 없다. 불명 6건의 저장 오류는 모두 `DRIVER_REFUSED`이고 `resultHash`는 없다. 이 일반 오류만으로 로그인 신원·소유권·도구 scope·서버 실행 권한의 어느 경계가 거절했는지 단정하지 않는다. journal 집계는 현재 점유나 gateway의 활성 요청 수가 아니다.
- 기존 owner-private `web-maintenance-20261020-goal/host-control/runtime-apply/acceptance.json`은 당시 별도 7개 원 operation의 완료와 정상 browser/desktop 반환을 증명한다. 이후 불명 6건의 exact 요청과 일치하는 결과 근거가 아니며, 과거 provider active/unknown=0도 현재 fresh READY가 아니다. 원 journal·원 요청·기존 보안 거절을 그대로 보존했다. 기록의 `COMPLETED` 또한 제품/부모 goal 완료나 모든 세션 반환을 뜻하지 않는다.
- 불명 조정 담당은 각 원 요청의 원 client와 기존 host owner다. 원 `request_id`·원 `client_key` 및 해당 owner/hash 결속을 회수한 뒤 **같은 요청**의 기존 `aicc_host_operation_status`로만 읽기 조정한다. 이번에 그 원 client 실행 문맥을 인수하지 않았으므로 임의 key·새 요청·새 executor를 만들지 않았다. status는 새 실행이나 lease 재발급/반환 증거를 만들지 않는다. 정상 반환 근거가 없으면 `HISTORY_UNPROVEN`을 유지한다. 실제 보안 거절이 확인된 요청은 status 회수를 재실행·다른 도구 우회의 구실로 쓰지 않는다.
- 호환 reader는 옛 bundle의 원 schema를 확인해 `operation` 누락을 곧바로 불명 결과로 취급하던 차이를 수정했다. 과거 `NOT_DISPATCHED` 8건은 불명에서 제외하고, `OUTCOME_UNKNOWN` 6건은 원 불명으로 보존하며, `COMPLETED` 15건은 `LEGACY_OPERATION_KIND_UNPROVEN`으로 따로 둔다. 완료 hash는 원 호출 결과의 근거일 뿐 open/close·세션 반환 근거로 추정하지 않는다. source의 `recoveredUnknown`은 불명/미완료 dispatch만, `recoveredReturnUnproven`은 작업 종류/반환 미입증을 센다. `knownSessions`는 현재 instance만 세며 과거 원장 수를 현재 active로 바꾸지 않는다.
- source 읽기 결과는 legacy29 + 새8도구의 `NOT_DISPATCHED` 1건으로 총30 JSON이었다. 비원장 하위 디렉터리1은 `nonJournalEntries`로 구분해 읽기 실패로 부풀리지 않으며 내용은 읽지 않는다. 손상 JSON·연결 파일·request/파일 이름이나 hash 형식 불일치·부분 저장 파일은 별도 읽기 실패/partial HOLD다. 한 손상 항목 때문에 나머지 정상 원장의 분류를 중단하지 않는다. 실제 원장 bytes의 읽기 전후 hash가 같음을 확인했고 원 phase/request/client/lease·내용·stateRoot는 수정하지 않았다. 관련 `node --test test/host-control-history.test.mjs` 5 PASS/0 FAIL, 원 불명/반환 HOLD 해제0·driver/앱 실행0이다.
- 설치 인수는 이 불명/반환 근거와 기존 보안 경계를 보존한 상태에서 메인이 단일 owner·정확 대상·fresh 독립 operation-specific READY·현재 active/unknown/drain·rollback을 조정한 다음 맡는다. 과거 `build-host.mjs`는 gateway를 다시 만들고 host provider를 추가하는 최초 설치용이므로 현재 3-provider graph에 재사용하지 않는다. 아래 기존 graph 보존 교체 경로를 사용한다. 기존 helper의 첫 교체는 승인된 계획 정비 중단이며 정상 프로세스 종료로 기록하지 않는다.

## 기존 graph 보존 교체 — 2026-10-24

`prepare-update.mjs`는 기존 registry의 gateway와 manifest/pin을 읽어 새 immutable 후보만 만든다. 기존 host 하나를 같은 index에서 교체하고 Workspace·Native·gateway 실행 코드·manifest의 다른 파일·호스트 config·driver/app/journal 경로와 pin은 그대로 둔다. 새 host 실행 파일과 8도구 snapshot만 바꾸며 원본 설치본을 수정하지 않는다. 후보 config와 profile은 기존 private operation 아래에 남기고 개인 상태를 공개 repo로 복제하지 않는다.

기존 승인된 Bun 1.4 실행 파일로 다음을 수행한다. `OPERATION`은 기존 owner asset-control 아래의 새 후보 디렉터리다. 이미 존재하면 덮지 말고 원 결과를 조정한다.

```powershell
& $Bun14 components/host-control/prepare-update.mjs --state-root "$env:USERPROFILE/.ai-control-center" --operation $OPERATION
```

준비된 `candidate-receipt.json`은 기존 `tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1`의 `host-runtime-update` 분기로 검증한다. 이 분기는 owner config/backend 변경이나 provider 추가를 허용하지 않는다. 기존 updater의 Prepare에는 정확 후보 SHA·실제 GitHub/Notion 변경 백업·정확 Task/프로세스 소유·원본 rollback snapshot이 필요하다. 새 plan의 challenge는 기존 gateway maintenance와 호환되는 64자리 nonce다.

예전 Workspace overlay 설치기가 gateway config를 repin하고 복사된 manifest를 갱신하지 않은 경우에만 `--workspace-overlay-operation EXACT_COMPLETED_OPERATION`을 추가한다. 원 plan·registry.before·journal 시작 1회·원 config와 현재 owner config 불변·원 gateway consume의 raw request/response hash와 baseline config SHA를 확인하고 Workspace provider의 경로/pin 변환을 재현해 현재 graph 전체와 대조한다. 다른 provider 차이나 근거 부족은 실패한다. 원 manifest는 그대로 두고 새 후보에만 현재 graph의 manifest를 만든다. 과거 consume을 현재 정비 근거로 재사용하지 않는다. 로컬 준비가 중간에 멈춘 경우 `--resume-local-prepare`는 새로 빌드한 bytes가 기존 partial과 동일할 때만 같은 operation을 이어 쓰며, 완료 receipt나 다른 bytes를 덮지 않는다.

Apply 전에 메인이 기존 gateway owner maintenance 경로에서 같은 plan `request_id`/`challenge`로 begin→현재 3-provider drain 확인→consume을 수행하고 원 `state.json`을 `-MaintenanceStateFile`로 전달한다. updater는 현재 소유 supervisor·gateway config SHA·operation/nonce/expiry·CONSUMED·closed/initialized·active/unknown/reconnecting=0·calls/unknown 빈 목록을 대조한다. 과거 상태나 호스트 journal의 불명 이력을 현재 0건으로 치환하지 않는다. 기존 작업 결과/보안 거절은 그대로 보존한다.

새 fresh 독립 READY·one-shot plan·CAS·rollback과 위 정비 근거를 통과한 첫 교체만 `bootstrap-planned-maintenance-stop`으로 수행한다. 기존 helper의 exact owned process-tree 중단은 강제 계획 정비이며 `normalProcessStop=false`다. Tunnel의 정식 정상 종료/ACK 채널을 제공하는 것으로 표현하지 않는다. 이후 정상 종료 경로는 실제 Tunnel 지원과 owner supervisor 계약을 연결해야 하며 단순 Node signal을 정상 drain으로 승격하지 않는다. 원래 updater의 rollback/CAS·시작 1회·불명 시작 재시도 금지는 그대로 적용된다.

현재 구현 검사는 graph/manifest/타 provider 보존, pin 변경 거절, 실제 PowerShell 후보 검증, operation이 다른/불명/미소비 정비 상태 거절, 원 overlay provenance/타 provider 차이 거절, local partial 보존 재개를 포함해 7개 통과했다. 별도 실제 Bun 1.4 번들 + Node MCP list 검사도 격리된 임시 journal에서 8도구와 tool hash 일치를 확인했다. 사용자 앱·driver 실행·원 journal 접근0이다. 실제 등록 graph의 원 overlay provenance를 조정해 host 8도구 후보 `PREPARED_NOT_ACTIVE`와 updater `VALIDATED_NOT_ACTIVE`를 확보했다. 설치·게시·새 일반 Chat 수락·live cutover는 아직 수행하지 않았다. 다음 owner는 메인이며 정확 후보/업데이트기 변경 백업과 fresh plan·독립 READY·현재 gateway maintenance/CAS를 조정한다.

## 현재 인수 · AICC 호스트 제어 / AI 개발 관제 · 2026-10-23 21:51 KST

- 원요청: “세션 점유·공유 대기와 안전한 반환 구현”. source 담당 대화 [00000000-0000-4000-8000-000000000000](codex://threads/00000000-0000-4000-8000-000000000000), 인수/반환 담당 메인01a160f7-a073-7b53-825b-679c6d0a6fca. 이번 turn ID는 도구 미제공 UNKNOWN이며 메인이 원 task 근거로 보충한다. 이전 turn01a16853-8055-7f91-be16-ca0e2584cd9b의 source5/문서2는 재검토·재실행하지 않았다. GPT ID/URL 해당 없음·새발신0.
- 작성권/근거: 공개 core의 기존 components/host-control/server.mjs와 이 README만 단일 writer로 인수했다. Git root와 두 파일의 기존 미추적 상태, 제품 지침·운영 지도·PROJECT 현재·PRODUCT·이 README의 설계, 기존 source/공개 노출 의존을 사전에 읽었다. 원본/다른 dirty 보존·PRIVATE/HOME 중앙 정본·설치 provider/공유 runtime 변경0. 기존 설계·도구 schema/provider가 server.mjs의 HOST_TOOLS를 함께 사용하므로 같은 정본에서 additive 연결했다. 새 registry/스케줄러/daemon/driver0.
- 원 증거 보존: communication_project_inspect_20261023_01은 HOST_SESSION_LIMIT / NOT_DISPATCHED였으며 실제 점유 owner/session은 UNKNOWN이다. 원 요청 재실행·옵션 변경 재생0. 이번에는 현재 세션/앱/브라우저를 조회하거나 닫지 않았다. 원409/stockbearR1 UNKNOWN/f222 격리/옛 CONTROL429·불명 GPT/26모델6대화·보안 거절도 그대로다.
- 작성 결과: source1(server.mjs)·기존 정본문서1. 본인 세션 상세/공유 집계 조회와 명시 대기 claim·취소, 기존 journal을 통한 단계·반환 상태, 재시작 불명 HOLD를 연결했다. 새 source 기준 schema는 기존6+신규2도구이며 task-owned-v1·총4/browser3/desktop1·idle600초를 유지한다. 현재 설치본은 기존6도구라는 원 증거만 있으며 새2도구 사용 가능/실제 점유 해소/설치 완료를 뜻하지 않는다.
- 상태: 소스 작성 / 검증 미실행 / 미설치·미배포·운영 미인수. tests/build/lint/type/import/브라우저/실행/추가 코드 review·검증 재읽기/위임0. 새 테스트 형식/중복 fixture0. 실제 lease·원 요청·외부 API·계정·프로필·ACL·서비스/route/모델·GUI/트레이/Tailscale·commit/push0.
- 남은 일/다음 actor: 메인이 운영 정지·독립 operation-specific fresh READY·active0/unknown0·rollback·기존 관리자권한을 조정한 뒤 provider/gateway pin과 published tool snapshot의 정상 적용/실제 수락을 별도 인수한다. 과거 journal의 반환 근거가 없으면 현 점유를 0으로 만들지 말고 기존 host owner가 원 증거를 조정한다. source를 썼다는 이유로 기존 HOST_SESSION_LIMIT나 다른 운영 HOLD를 해제하지 않는다. writer/sender 메인 반환.
- 후속 원칙: 전체7그룹30·AI→자동매매→재무→영상콘텐츠→제작서비스(Study Tool 포함)→커리어→사용자검토·비겹침 최대2그룹·기존 통합/분리/폐기/제외/보존·옛12관제 보관 유지. 사용자 명시 재개 후 새 종료시각 없음. 기존 OCX/model·CLI -C <root> -a on-request -c 'approvals_reviewer="auto_review"' -s danger-full-access·exact ID resume, 실제429/503은 원 turn/부분 파일을 남기고 정상 초기화 대기·보안 거절/계정/Native 우회0. 다음 담당도 문서 우선/완료 재사용/변경만 읽기·소스/설치/실작동 분리 원칙을 유지한다.

## 세션 조회·공유 대기 계약 — 소스 후보

사용자 여정은 다음과 같다. 아래는 새 소스의 계약이며 설치본 지원을 선언하지 않는다.

1. aicc_host_capabilities에서 sessionInventory=owner-only-v1, sharedWait=explicit-claim-v1 지원을 확인한다. 미광고/미설치는 기존 지원 범위로 남긴다.
2. aicc_host_sessions(client_key)로 본인 세션과 대기만 상세 조회한다. 공유 정보는 용량·종류별 사용량·대기 수·과거 불명 수의 aggregate뿐이다. 본인 request/session ID, 종류, 입력한 담당 역할/목적, 생성/마지막 활동/관측 시각과 반환 이유는 볼 수 있지만 lease/PID/화면/본문/다른 owner의 ID나 역할은 반환하지 않는다. 조회는 idle 수명을 연장하지 않는다.
3. 별개로 승인된 새 open 요청은 기존 request_id/client_key를 보존하고 필요할 때만 wait_for_capacity=true를 명시한다. owner_label/purpose는 등록 신원이 아닌 본인 제공 작업 설명이며 비밀·개인본문을 넣지 않는다. 확인된 capacity 부족 또는 앞선 실행 가능 대기가 있으면 dispatch하지 않고 QUEUED로 저장한다. 실제 열린 세션의 반환 미입증·원장 손상으로 HISTORY_UNPROVEN이면 opt-in도 대기로 바꾸지 않고 원 request를 NOT_DISPATCHED로 보존한다. 구형 결과 불명만으로는 새 별개 요청을 차단하지 않는다. 같은 request의 operation_status에서 결과를 읽고 원 client와 host owner가 원 증거를 조정한다. 기존 NOT_DISPATCHED/UNKNOWN 요청의 ID나 옵션을 바꿔 자동 재생하는 기능은 없다.
4. 같은 원 request_id/client_key의 operation_status 또는 sessions로 대기를 확인한다. aicc_host_wait(action=claim)은 기존 직렬 admission 안에서 현재 용량과 실행 가능한 대기의 순서를 다시 대조하고 한 번만 dispatch한다. 조회 때의 claimable은 슬롯 예약이 아니다. 종류별 슬롯이 막힌 요청 때문에 사용 가능한 다른 종류를 멈추지 않도록 가장 앞선 실행 가능 요청을 고른다. claim이 없으면 자원이 생겨도 자동 실행하지 않는다. action=cancel은 QUEUED만 CANCELLED로 바꾸며 화면·세션을 닫지 않는다.
5. 실제 open 결과의 원 lease를 보존하고 기존 observe→fresh observation_id로 act→정확한 close 요청을 사용한다. 목록은 lease를 복구하거나 다른 owner의 세션을 채택하는 수단이 아니다. lease 분실·불명 결과는 기존 원 operation 조회/host owner 조정으로 남긴다.

용량 부족은 CAPACITY이지 인증/권한/모델 사용량 거절이 아니다. 총 세션4/browser3/desktop1, 기존 직렬 pending12·cache24, 새 명시 용량 대기12로 각각 제한한다. 기존 open 기본값은 용량 부족 시 NOT_DISPATCHED이며 자동 큐 전환하지 않는다. 공유 대기가 있으면 새 기본 open도 앞선 실행 가능 claim을 추월하지 않는다. slot 수를 올리거나 새 호스트를 생성하지 않는다.

URL 표시는 기존 safeUrl/blocked 경계를 통과한 요청의 origin만 사용하고 path/query/fragment는 REDACTED다. actual current URL은 UNPROVEN이다. 화면 내용/현재 URL을 추측하거나 조회를 위해 브라우저를 건드리지 않는다. 담당/목적은 본인 메모이며 권위 신원으로 승격하지 않는다.

QUEUED·NOT_DISPATCHED·DISPATCHING·COMPLETED·OUTCOME_UNKNOWN·CANCELLED는 기존 원 request journal의 별개 상태다. COMPLETED는 호스트 도구 호출 결과가 기록됐다는 뜻이며 부모 goal/제품 작업 완료 증거가 아니다. 원 request hash/client owner 검사를 유지하고 원 동작/결과를 덮어쓰지 않는다. queue 원문·owner label·URL·lease는 journal에 쓰지 않으며, 실행 인수에 필요한 원 args는 현재 프로세스 메모리에만 둔다.

재시작하면 QUEUED 기록이 있어도 인메모리 원 실행 문맥이 없으므로 HOLD_QUEUE_CONTEXT_LOST로 남기고 claim을 실행하지 않는다. 원 QUEUED 취소만 가능하다. 완료 결과가 cache에서 없으면 metadata만 반환하고 새 실행/lease 재발급0이다. 신규 open journal에는 생성 instance·원 session 결속과 OPENING/OPEN/CLOSE_PENDING/CLOSED/UNKNOWN 반환 상태를 덧붙인다. 명시적으로 열었던 세션의 정상 반환 미입증과 손상/부분파일은 available=null·HISTORY_UNPROVEN/HOLD로 표시하며 새 admission을 막는다. legacy 결과만 불명확한 기록은 과거 상태로 보존하고 현재 점유로 세지 않는다. 과거 기록 backfill·mtime/세션 Map 부재를 0/반환 증거로 사용하거나 자동 수리/삭제하지 않는다. 기존 작업 조회/자기 소유 세션 정상 반환과 독립 제품 source 업무를 전체 차단하는 gate로 확대하지 않는다.

idle 정상 반환은 기존600초·자기 소유·직렬 호출 유휴 조건을 유지한다. CLOSE_PENDING·불명은 자동 반환에서 제외하고 idle close의 불명 실패는 UNKNOWN으로 보존한다. 반환 가능 표시는 원 lease로 정상 close를 요청할 수 있다는 뜻이며 미저장 내용의 폐기 승인이 아니다. 미저장/닫기 거절이면 자기 창을 관측하고 처리하는 기존 경로만 사용하며 강제종료/다른 owner 조작/불명 close 재생은 하지 않는다.

---

This component adds a separately pinned host provider to the existing authenticated AICC gateway. It does not expand Workspace exec or exchange Workspace, Codex and host capabilities. No additional model, account, profile, public port or tunnel is created.

Use aicc_host_capabilities, then aicc_host_open(kind, request_id, client_key, url/app_key). Keep session_id and lease private. Open returns the first observation. aicc_host_observe returns current state and observation_id. Use that exact observation_id plus an observed browser ref or Cua element_token with aicc_host_act. The action returns a new observation. Finish with aicc_host_close. On missing acknowledgement use aicc_host_operation_status with the original request_id/client_key; never invent a new ID to replay uncertain work.

Aside uses a persistent fixed REPL transport. Only openTab/closeTab and generated named page actions are exposed; arbitrary caller JavaScript, fetch, files, other tabs and a second AI agent are not exposed. The existing profile is fixed in private deployment config. Previously refused exact resources remain blocked.

Windows uses a persistent Cua MCP lifecycle from launch to close. Apps come from the owner registry, not caller paths/arguments. Already running registered app processes are rejected before launch; a returned pre-existing PID is also rejected. PID creation time/image and exact HWND are checked on actions. Only the launched window is observed. Input uses background delivery first. A foreground retry requires the same action's actual background_unavailable result and a new observation. Close uses an observed native close button, then only documented hotkey escalation; no kill tool is exposed.

Four sessions (three browser and one desktop), twelve serial calls, twelve explicit capacity waiters and twenty-four bounded cached results prevent unbounded concurrent resources. Idle normal-close runs once after ten minutes. Uncertain operations and unsaved/failed closes remain HOLD; never force-kill or adopt unrelated windows. Private operation journals store request/owner hashes and phase, not capabilities, inputs, URLs, images or page text. A restart can return metadata but cannot replay a previous operation. A full journal stops new work for owner maintenance rather than silently deleting evidence.

Deployment must distinguish source tests, installed gateway/provider pins, published tool snapshots and fresh ordinary ChatGPT calls. The fixture is a new blank application with no user files; it is not proof that every installed Windows application behaves identically.

## G1 Windows registered CDP / Playwright auxiliary selection (2026-11-08, source only)

The existing `aicc_host_open` gains optional `browser_backend=cdp|aside` and
`browser_identity`. There is no new MCP server, controller, scheduler, profile,
port or model. The same eight host tools and original `request_id` journal
remain authoritative; changing optional input fields and adding `download`
changes the published **tool schema hash**, so installed consumers must use
the exact reviewed host provider/gateway snapshot. Existing installed browsers
are **not** switched by a source edit.

- The default is **Aside** while owner-private `config.cdp.enabled` is
  absent/false. Only after an independent private binding transaction sets
  `enabled=true` does the default become CDP, and each CDP open requires
  a `browser_identity` registered to one exact account, workspace, profile,
  executable, and loopback endpoint. The original fixed Aside transport and
  profile are kept; `browser_backend=aside` opts into it explicitly.
- The owner-private config must supply a SHA-pinned lease helper, the existing
  identity guard, PowerShell, SHA-pinned Playwright entrypoint, and an exact
  registry of `registered-cdp` identities. ChatGPT use additionally requires
  the official in-page identity audit module and a previously verified identity
  hash bound to the selected private account alias. This file does not store
  aliases, profile roots, identity hashes, credentials, or login state.
- The existing `Manage-CdpChromeSlotLease.ps1` is sole authority for
  Acquire/Heartbeat/Release. It **does not** receive `AllowBrowserStart`:
  a dormant slot is not a failure or an invitation to start another browser.
  The selected Chrome process, account, workspace and user-data root must
  match private coordination. The client attaches by `connectOverCDP` and
  finds exactly one background task-created target by CDP target ID; it never
  activates or adopts user tabs, copies cookies or switches accounts.
- Per operation, heartbeat and original target ID are checked. ChatGPT pages
  also recheck the in-page identity hash, account and exact workspace identity
  hash (explicit null only for a verified personal workspace). Missing workspace
  evidence is refused before dispatch and a changed live workspace preserves
  the original lease as uncertain. All pages retain
  the original blocked URL policy. A DOM accessibility snapshot and unique,
  fresh `[ref=...]` references control click/fill/press/select/check;
  screenshot uses existing `aicc_host_observe(screenshot=true)` and download
  uses `aicc_host_act(action=download, ref=...)` to an explicitly configured
  owner-only download root with size limits. No arbitrary JS, URL privilege,
  attached user target or profile/credential management is exposed.
- The lease helper closes **only the exact owned target**. The Playwright
  client disconnects without closing Chrome. A failed acquire/operation/close
  remains `OUTCOME_UNKNOWN`, `SESSION_RETURN_UNPROVEN` or
  `CLOSE_PENDING` under the original journal; never retry an uncertain
  Acquire/Release, infer unused slots from process count, or fall back to Aside
  or another account. Cached large screenshots are omitted from RAM results;
  the original result hash and journal remain.
- A target client inherits the registered broker's slot capacity. It does not
  override `MaxTargetsPerSlot` for the entire shared slot. Retained or unknown
  leases still consume the broker's capacity; a genuinely full slot remains
  busy without acquiring again or changing another owner's records.
- Disconnect is a terminal transport state for that adapter instance. Later
  observe/action/close calls refuse locally; the owner must reconcile and
  normally release the original lease. Disconnect never releases or recreates
  the target, and repeated disconnect does not close the transport twice.
- The existing host idle timer stays at **600 seconds** with one normal
  close attempt of owned sessions only. Neither the host listener nor the
  owner-private Workspace Tunnel/task is shut down by this patch. An executor
  can be stopped only after the owner proves no sessions, commands, leases,
  unresolved outcomes or other GPT work; verifies an independent restartable
  receiver and normal stop/ACK. Fifteen to thirty minutes is a future
  measurement candidate, **not** an applied timer change.

### Source, install and run acceptance

1. Run `node --test test/host-control-cdp.test.mjs
   test/host-control-history.test.mjs test/host-control-update.test.mjs`.
   These fake tests do **not** log in, start Chrome, access private state or
   prove live account identity. The source graph receipt now pins all four
   CDP-related imports (`hostSourceClosure.pins` and `.sha256`).
2. A separate existing owner operation creates a candidate using
   `components/host-control/prepare-update.mjs` and the previously accepted
   `host-runtime-update` branch of
   `tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1`.
   This updater **preserves owner config bytes**, the other two providers,
   the gateway binary, the manifest provenance and existing journals. It
   cannot silently enable CDP or change profiles/permissions. Require exact
   verified source/build closure, frozen tool-schema hash, independent
   READY, operation-specific maintenance consume, active/unknown/drain=0,
   preimages, one-use CAS and rollback before any installation.
3. Any future enabled CDP default requires **separately approved and tested**
   private config binding and in-page identity/lease acceptance for each
   registered account (including concurrent accounts), navigation, DOM
   reference, input, screenshot, download, precise close, reconnect/UNKNOWN
   and recovery. A prepared binary alone is not a live route switch.
   Existing saved conversations, user Chrome focus, Aside update route,
   17841/10100/10101, Workspace read-only and personal auth remain separate.

Only an already-authorized runtime with complete source/installation
prerequisites may do the actual owner transaction. No external URL, new service,
Cloudflare/Oracle deployment, credential migration, scheduler or user tab
termination is implied.

## G1 owner-local CDP binding through the official host updater (2026-11-08, source only)

The host source CDP option no longer requires manually editing the installed
`host.json`. The *existing* `prepare-update.mjs` accepts two matching,
explicit arguments in addition to the original flags:

```powershell
& $PinnedBun components/host-control/prepare-update.mjs `
  --state-root $ExistingOwnerStateRoot --operation $NewOwnerOperation `
  --owner-cdp-binding $ExactOwnerLocalBindingFile `
  --owner-cdp-binding-sha256 $VerifiedBindingSha256
```

This is an **owner-local input contract**, not an instruction to create a live
binding before the existing owner has verified all accounts and lease ownership.
The binding is a separate regular file under the existing private state root,
with `schemaVersion=1`, `kind=host-cdp-owner-binding/v1`,
`hostConfigBeforeSha256`, exact private
`guidance/coordination.toml` location/SHA, and a single additive `cdp`
object. `cdp.enabled=true` requires registered identity records bound to
the exact coordination slot, account alias, workspace, user-data root, profile,
loopback endpoint and a non-empty in-page identity SHA. No port, alias,
stored session or fee tier alone establishes identity.

The CDP object accepts only `identities`, pinned existing
`leaseHelper/leaseHelperSha256`, `identityGuard/identityGuardSha256`,
`powershellSha256`, `playwrightModule/playwrightModuleSha256`,
`identityAuditModule/identityAuditModuleSha256`, `enabled`, and optional
existing owner-private `downloadRoot`. Each identity also pins its existing
browser executable SHA. Registered profiles/slot paths are *read-only* inputs;
no account, port, login, profile, auth store, user target or service is created,
selected for fallback, copied, reset or started by prepare. Missing, duplicate,
relative, different-workspace or unregistered identities and changed pins
fail before an operation is written.

With a valid binding, preparation creates a **new immutable**
`releases/host-control/host-update-*/host-config.json` beside `host.cjs`,
pins entry/config and the complete copied CDP closure in its manifest; the
candidate gateway changes only Host `args[2]`, its unique config pin and the
explicit closure file pins. The previous entire
host config bytes/SHA and all old Aside/Cua apps, journals, state, refusal
rules, Workspace owner and Native provider remain untouched. The candidate
receipt carries `hostConfigUnchanged=false`, original/desired config hashes,
owner binding and coordination hashes, dependency pins, preparer source pin,
and the original host source closure. Without the two explicit CDP flags,
`hostConfigUnchanged=true` and existing config/argument/pin behavior are
unchanged. Candidate creation is **not** an installed default switch.

`Update-AiccWebManagementRuntime.ps1` in its existing
`host-runtime-update` branch independently rechecks the exact delta,
official helper paths and SHA pins, installed coordination, source closure,
unique Host entry/config pins, immutable release manifest, unchanged other
providers/gateway code and original owner files. Its existing
`host-runtime-local-backup/v1` required-source list now **automatically
includes** original/desired host config, exact binding/coordination, ordinary
executor dependencies, every non-linked copied closure file, source/preparer,
new manifest and old Host executable. The raw npm/pnpm HardLink entries are
read-only source provenance, never installed or backed up as executables.
During Prepare the operation takes another exact `host-config.before`
preimage; Apply and Rollback require matching original bytes. A failed
post-apply start still uses the original Task/registry one-shot CAS rollback.
Original fresh independent READY, consumed three-provider gateway with
active/unknown/reconnecting=0, exact prior SHA, task and owner check, one
planned stop/start and refusal of ambiguous outcomes remain mandatory.

Source tests: run the new `owner CDP` cases of
`test/host-control-update.test.mjs`, and the existing host graph
backward-compatible case. These use temporary fake private files and
PowerShell's real pure candidate validators, **not** the operational
updater entrypoint. No HOME config edits, install, runtime/browser test,
credentials, account switch, Task change, network publication or model
dispatch are in this source-only work. Central alone may review the private
owner bundle and request fresh official Preview/Apply after readiness/drain.


## G1 dependency materialization · npm/pnpm HardLink release boundary

The earlier official host owner Prepare failed **before any live effect**
because its pinned Playwright `index.js` was an npm/pnpm HardLink and
updater `Regular()` correctly refuses all linked executable/recovery files.
This is not evidence of an ACL, account or service refusal. Keep
`Regular()` unchanged: do not repin a linked path into a gateway or
delete/unlink/mutate the original `node_modules` tree.

For explicit owner CDP candidates only, the existing preparer reads the
already SHA-pinned source **without modifying it** and accepts exactly:
`playwright-core-only` (one complete physical `playwright-core` package),
or `playwright-plus-core` (full `playwright` and exact matching-version
`playwright-core`, and no third package). It checks the package directory,
name, version, `index.js` entry, `exports["."].require/default`, ESM/type
exports and every exported file. Published `playwright-core` may omit
`main`; full `playwright` must declare `main: index.js`. It then collects
all static relative imports from the approved audit entrypoint (ESM imports/exports, literal `require`,
dynamic literal `import` and `new URL` assets). Unknown/dynamic imports,
unlisted bare packages, missing/ambiguous relative imports, unexpected
package dependencies, symlinks/junctions/reparse ancestors, path traversal,
oversize or duplicate files fail closed. HardLinks are accepted **only as
read-only source provenance**. No browser or external URL is opened.

The preparer creates independent, regular, `nlink=1` immutable files under
the existing `releases/host-control/host-update-*/node_modules/playwright-core`
(and `node_modules/playwright` **only** for full+core), plus `cdp-audit/`.
The candidate provenance and updater independently pin exactly one of these
two package kinds and its matching immutable `index.js` path. A full package
cannot be assumed present. It writes a full per-file
`dependency-provenance.json` containing the SHA/source/target/relative path
closure, plus the existing `host-config.json`, `host.cjs` and complete
host manifest. The *candidate* `cdp.playwrightModule` and
`cdp.identityAuditModule` point only to these copied, SHA-pinned entrypoints;
the owner binding continues to pin the original source entrypoints and
unchanged registered account/workspace/profile identities. Only the Host
provider gains the copied dependency file pins. All other providers, tools,
permissions, Aside/Cua and the owner's installed Host configuration are
unchanged.

The existing updater runs a **pure, pinned Node verifier** from the exact
`preparerSourceFile` at both official Prepare and Apply validation. It
recomputes source package + audit import closure, compares every original
source byte and immutable copied file/manifest/pin, refuses unexpected
release files/links, and checks that Host config differs from the previous
one solely by the additive `cdp` section and substituted copied-module
paths. This is a named read-only source provenance path, **not a relaxation**
of `Regular()`. In the old `host-runtime-local-backup/v1` required file list,
raw HardLink paths are not executable/backup inputs; their SHA-sealed
nonlinked release copies and the complete provenance/manifests are required.
Existing exact operation backup, independent READY, three-provider consumed
drain active/unknown=0, CAS, one-time stop/start and rollback remain required.

Tests are bounded fake npm packages and a fake HardLink audit module:
`node --test --test-name-pattern='owner CDP|host replacement preserves graph order'
test/host-control-update.test.mjs`. Includes source HardLink denial by
`Regular()`, regular immutable copy, missing import, source SHA drift, added
package file, extra release file, symlink/junction refusal, backup/rollback,
and old no-CDP Aside path. No live Playwright/browser/8-tool runtime release
claim is made by these fixtures. Central alone builds/receipts and applies
a **fresh** private official operation after exact owner and drain gates.


### G1 core-only owner follow-up (2026-11-08)

A later, fresh private owner Prepare refused `CDP_OFFICIAL_PACKAGE_IDENTITY_REQUIRED`
before touching the live host: the registered raw entry was
`playwright-core/index.js` at package version 1.62.1 and no full
`playwright` package was installed. The source candidate now accepts
that exact `playwright-core-only` kind without resolving `playwright`.
`playwright-plus-core` still requires an exact matching two-package
closure. Both kinds must preserve `packageKind` across source provenance,
immutable entrypoint, updater and recovery SHA pins. Missing/altered
package exports, extra dependencies, dynamic imports, optional packages,
linked executable/ancestor or incomplete audit closure still fail closed.
The core-only binding's private identity-audit import closure belongs to
central's **separate** private owner work; this source update does not
create or change it. No installed config, profile or default Aside route
changes until a fresh approved owner transaction.


### G1 Host history · exact normal-return reconciliation source (2026-11-09)

After the approved CDP cutover, an older explicitly opened Host session
still returned `OUTCOME_UNKNOWN` with `resultEvicted=true`; no original
resource-return proof survived that Host generation. `HOST_HISTORY_UNPROVEN`
is therefore a real admission hold, not evidence of a current driver/security
denial. Do not replay the open, drop a journal, clear the hold, adopt the old
Aside tab or close any unrelated target.

The **same eight Host tools** remain. `aicc_host_operation_status` stays
read-only with the original `request_id` and `client_key`; an original
unknown result remains unknown. The existing write-capable
`aicc_host_close` alone gains an *optional*, exact
`history_recovery={open_request_id,close_request_id,client_key}`
alongside the original `session_id`, original 64-hex `lease`, and a **new**
`request_id` for one reconciliation attempt. This is **not** a new open,
Act, lease, provider, manager or target adoption. The published
`aicc_host_close` input schema/tool hash changes; the currently installed
bundle is unaffected until central applies a fresh source-pinned Host
replacement with its normal gates.

A successful reconciliation requires the exact original owner hash,
source instance/generation, kind, session and original lease hash, plus the
same resource-target hash. The independent **original normal-close**
session journal must have `hostAction=normal-close/v1`, phase COMPLETED,
exact request hash and the canonical **successful** CLOSE result hash.
A completed refusal/`CLOSE_PENDING`, bare status, absent process,
in-memory session loss or an old result hash is not normal return.
Only when both original records prove closure does the controller create
one private `.history-return-receipts/<open_request_id>.json`, using
create-new/fsync, with SHA pins of both original journals and a hashed
reconciliation request. The original open/close journal bytes are
**never rewritten** in reconciliation. Duplicate identical attempts return
the existing receipt; foreign/tampered/replaced evidence holds. On restart,
the reader revalidates the receipt against both immutable original
records and refuses any changed original or sidecar. The old original
operation status stays `OUTCOME_UNKNOWN`; only the exact verified
resource-return admission blocker is removed, not unrelated holds.

New CDP and task-launched CUA sessions pin a hash of their exact owned
target/process in their *private* open journal; normal close writes the
same target hash and the tagged completed normal-close receipt. Existing
Aside REPL sessions do **not** have a persistent target identity, and old
Host records without an original lease/resource hash or a tagged normal-close
record are **not eligible**. No CUA historical attach/re-adoption tool is
present here. For such originals, only explicit read-only status/capacity
diagnosis remains; central must obtain independent authorized exact
resource/return evidence through a supported owner tool before any further
design, otherwise preserve HOLD. A private admin assertion, expired
TTL, absence of process or manual JSON edit is **not** proof.

Focused source tests: `node --test test/host-control-history.test.mjs`
in isolated temporary journals. No real Host calls/Chrome/Aside work,
service restart, original UNKNOWN replay or installed cutover in this task.
The incident's reusable distinction is linked in
[capture-operational-knowledge / 불명 전송 조정](../../guidance/skills/capture-operational-knowledge/references/문제와-해결책/불명-전송-조정.md).

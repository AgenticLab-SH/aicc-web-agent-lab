# 정비 중인 자동재개 실행기 갱신

## 원 실행기 재개 기능의 구현 경계 · 2026-11-17

공식 goal에는 내부 goal ID, 원 runtime, goal 변경 잠금과 idle 단회 시작이 있다.
공개 스키마에 AICC의 `ownerRevision`/`stopEpoch`라는 필드가 없다는 사실만으로
이 기능 전체가 없다고 판단하지 않는다. 다만 설치된 원 runtime에서 장기 승인,
철회 세대, 동일 issuer의 fresh 한도 회복, 단회 소비를 결속하는 접점은 별도 구현이
필요하다. 외부의 signed callback이나 source 영수증으로 그 권위를 만들지 않는다.
같은 살아 있는 writer가 이어가는 경우 프로세스 종료를 요구하는 legacy handoff와
구분하며, 실제 중복 writer·미결·정비 stop은 그대로 보호한다.

OCX의 실제 300분 창 소진(`100%`와 backend 사용 불가가 함께 확인됨)만 공식
`usage_limit_reached`와 원 `resets_at`/`limit_window_minutes=300`으로 전달한다.
97/98% 선제 보호, 일반 429, 주간 소진이나 UNKNOWN을 이 오류로 바꾸지 않는다.
`x-should-retry:false`와 원 요청 미재송을 유지하고 private bridge도 원 응답을
보존한다. 오류 호환 소스 수리와 원 runtime의 자동재개 설치·실사용은 별도다.
원 runtime 후보는 기존 소유자 문서에서 추적하며 현재 터미널을 강제로 교체하지 않는다.

## 원 selection callback 발행 모듈

`src/original-cli-issuer-producer.mjs`의
`sealRegisteredOriginalIssuerCallback`은 기존 서명 검증기에 전달할 실제
Ed25519 callback 파일을 create-once로 봉인한다. 입력은 exact registry
파일/SHA, thread, goal SHA, 원 selection의 ownerRequestId·attestation SHA·
recovery SHA와 새 출력 파일이다. 발신·등록·키 생성·worker activation은 없다.

기존 owner registry가 독립적으로 고정한 producer에는 기존 executable/
공개키/keyId 외에 `privateKey={file,sha256}`와
`authorityReader={moduleFile,moduleSha256,exportName:'readOriginalIssuerAuthority'}`가
필요하다. 기존 `originalOcxSelectionReader`의
`readOriginalCliQuotaReceiptChain`을 재사용한다. 이 두 실제 모듈만 import하며
호출자 JSON/함수나 callback의 공개키를 권위로 받지 않는다. producer executable은
현재 프로세스의 실제 executable과 일치해야 한다. 키와 출력은 같은 owner-local
디렉터리에 두며 원격 번들·로그·Git에 포함하지 않는다.

authority reader는 원 thread/root/route/goal SHA, 등록 owner revision·현재/이전
stop epoch·issuer receipt·writer process identity 및 원 selection pin을 받아
`aicc-original-cli-issuer-authority-observation/v1`을 반환한다. 동일 binding,
failedTurnId/terminal SHA/account SHA/credential generation/ownerRequestId,
attestation/failure/admission SHA, 실제 `originalIssuerBound`, `writerReturned`,
`writerClosed`, `pendingSettled`, `stopRequested`, `goalStatus`, `observedAt`을
**원 발신자 자신이 관측해야 한다**. 등록하지 않은 reader나 임의 true 값은
인수하지 않는다. source-only quota/rollout만으로 이 authority reader를 구현할
수 없으며 기존 원 TUI의 공식 owner/sender 계약 지원이 선행돼야 한다.

발행자는 전역 pending과 정비 stop을 보존하고 reader/key/executable/registry를
await 후 다시 검증한다. source·quota·owner 관측은 60초 이내, 동일 실패 turn의
terminal과 정상 writer 반환이 필수다. 반환 상태
`ORIGINAL_CALLBACK_SEALED_NOT_REGISTERED`는 서명 파일 작성만 뜻한다.
등록/CAS·원 sender 단회 claim/ACK·새 turn·업무 결과는 별도다.
`inspectRegisteredOriginalIssuerProducer`는 파일 작성 없이 첫 차단 조건만
반환하며 등록 존재를 signing/activation 가능으로 승격하지 않는다.

검사: `node --test test/original-cli-issuer-producer.test.mjs`.
실제 등록 authority가 없는 운영 상태에서는 소스 검사 통과만으로 설치나
자동재개 완료를 주장하지 않는다.

## 원 OCX selection 영수증을 기존 continuity에서 읽기

### 원 selection과 서명된 owner 연결

`inspectOriginalOcxSelectionQuotaChain`은 같은 등록의
`originalIssuerQuotaCallback`이 있으면 독립 producer 공개키로 원 payload를
검증한다. `quotaSourceKind=ocx-selection`, ownerRequestId, credentialGeneration,
attestationSha256을 서명과 원 selection 연쇄 양쪽에 결속한다. 등록 owner의
originalIssuerOwnerRevision/StopEpoch/PreviousStopEpoch/ReceiptSha256 및
originalIssuerWriterProcessIdentitySha256도 정확히 일치해야 한다.
실제 정책 거절을 100% backend exhaustion으로 바꾸지 않는다.

현재 goal은 active 또는 usageLimited만 source 검사 대상으로 받는다.
paused/blocked/budgetLimited/complete는 quota 회복으로 해제하지 않는다.
검증된 callback의 반환도 sender 권한이 아니며, 원 pending·정비 stop을
보존하고 단회 sender claim/ACK·새 turn을 별도로 인수한다. callback/source
조회 도중 registry나 모듈·callback SHA가 바뀌면 HOLD한다.

`inspectOriginalOcxSelectionQuotaChain`은 실제 private adapter의
`readOriginalCliQuotaReceiptChain` 계약을 그대로 소비한다. App Server의
`usageLimitExceeded` 영수증으로 변환하거나 97% 정책 거절을 100% 소진으로
만들지 않는다. 일반 CLI의 별도 App Server quota는 원 OCX 계정 증명이 아니다.

owner registry의 독립 `originalOcxSelectionReader`에는 `moduleFile`,
`moduleSha256`, `exportName=readOriginalCliQuotaReceiptChain`을 결속한다.
소비자는 등록 SHA를 검사한 실제 모듈을 직접 import한다. 호출자가 준 함수나
가짜 JSON을 등록 reader 대신 받지 않는다. 기존 private runtime의
`app/original-quota-owner.js`가 해당 export를 제공하며 설치 manifest의
`originalQuotaConsumer.sidecarSha256`과 실제 파일을 함께 확인해야 한다.
등록은 기존 owner-local preview/CAS 설치 거래가 맡으며 이 reader는 등록을
추가하거나 source-only 증거로 발신 권한을 부여하지 않는다.

읽기 진입은 `tools/platform/codex/inspect-original-ocx-selection.mjs`다.
exact thread/root/goal SHA, registry SHA, reader SHA, 원 ownerRequestId와
attestation/recovery SHA, 기존 App Server manifest SHA를 명시한다.
원 pending과 역사 pending, 정비 stop, 미등록 reader를 daemon 접속 **전에**
거절한다. 읽기 동안 source module/registry/goal 변경도 거절한다. 필요한
daemon을 새로 기동하거나 TUI writer를 다른 서버로 옮기지 않는다.

`ORIGINAL_OCX_SELECTION_CHAIN_VERIFIED_OWNER_CALLBACK_REQUIRED_HOLD`는
실패·fresh 같은 계정 회복의 source 연쇄만 검증한 상태다. 원 sender의
ownerRevision/stopEpoch·정상 handoff·단회 ACK·새 turn 및 실제 작업 결과는
별도 인수한다. 현재 운영 pending/stop을 지우거나 등록만으로 자동복귀
완료라 보고하지 않는다. 영향 검사는 `test/codex-goal-resume.test.mjs`에 있다.

## 2026-11-14 G1 nonweb OCX10101 원 quota 발행자 (source-only)

기존 원 goal ACTIVE·기한 없음이며 original user request·ce9a·UNKNOWN을
재발신하지 않는다. stop/Task/원장/모델/계정/Native 경로는 변경하지 않았다.

### 원 account 선택과 실제 5시간 quota 증거

- 실제 원 발행 위치: tools/platform/opencodex/external-pool-state.ts 안의
  selectOne(), admission(), usage()와 external-http-boundary.ts 안의
  createExternalOcxHttpBoundary() quotaRefusal() 경계.
- source 모듈: tools/platform/opencodex/external-original-quota-receipt.ts.
  선택 owner만 자신이 실제 고른 단 하나의 물리 account와 credential
  generation, 원 요청 UUID, client request/thread/turn correlation,
  fresh WHAM quota 및 전송 전 dispatchStarted=false를 기록한다.
  요청 헤더는 상관관계 표시일 뿐 원 TUI 신원 증명이 아니다. 계정이
  미선택·모호하거나 원 turn UUID가 없으면 영수증을 발행하지 않는다.
- 백엔드 WHAM /backend-api/wham/usage의 primary/secondary 중 실제
  limit_window_seconds=18000 창 단 하나에 대해 used_percent, reset_at,
  rate_limit.allowed(true/false/null)만 읽는다. 기존 parseQuota의 shortPercent
  와 일치해야 한다. 창이 없거나 값이 틀리면 HOLD.
  **OCX 정책 threshold 97% != 백엔드 100% 소진**이다.
  providerLimitProven=true는 실제 usedPercent=100 및 allowed=false가
  함께 관측된 경우에 한정한다. 97% 정책 거절은 policyThreshold=97,
  providerLimitProven=false 그대로다.
- 파일은 등록된 private owner home의 external-original-quota-receipts/
  아래 <OCX-request-UUID>.refusal.json, .attestation.json, .recovery.json
  3종만 필요시 create-once(w x)/0600/fsync로 기록한다. 원 account ID,
  token, body, encrypted context, provider raw exception은 넣지 않는다.
  다시 읽을 때 크기·file type·symlink·canonical JSON·exact SHA를 검사한다.
  다른 pool 계정이나 generation으로 자동 교체하지 않는다.

### 중앙 17841 private adapter의 정확한 소비 계약

1) 원 요청이 실제 pre_dispatch quota 거절을 받았을 때, 기존 OCX
POST http://192.0.2.1:10101/v1/responses 의 429 JSON
error.ownerQuotaEvidence가 존재할 수 있다.
필드: schemaVersion=1, kind=aicc-ocx-original-fivehour-pre-dispatch-refusal/v1,
ownerRequestId=<OCX generated UUID>, receiptSha256=<64 lower hex>,
sourceOnly=true, originalIssuerVerified=false, dispatchable=false.
기존 error.quotaRefusal의 x-client-request-id/thread-id/x-codex-turn-id
값은 인증이 아니라 correlation이다. ownerQuotaEvidence가 없으면
관리 소비를 진행하지 않고 HOLD해야 한다.

2) 중앙 private adapter가 실제 원 TUI request/thread/turn을 자신의
정식 원발신자 경계에서 검증한 뒤에만 다음 관리 API를 호출한다.
POST http://192.0.2.1:10101/api/aicc-local/original-quota/attest
인증: 기존 /api/aicc-local 관리 token과 localhost OCX10101; 다른 포트
및 비인증 요청 거절. Content-Type: application/json, body 4096바이트
이하. **키는 정확히 7개**:
schemaVersion: 1
kind: aicc-17841-original-turn-binding/v1
ownerRequestId: <OCX UUID>
refusalSha256: <exact private refusal SHA>
requestId: <actual original request correlation>
threadId: <actual original TUI UUID>
turnId: <actual original TUI turn UUID>
response state=ORIGINAL_OCX_MANAGEMENT_CORRELATION_BOUND_SOURCE_ONLY,
kind=aicc-ocx-management-bound-turn-correlation/v1, receiptSha256.
Refusal SHA·원 correlation·최대 10분 source freshness를 대조하고
create-once attestation만 쓴다. boolean 인증 필드는 받지 않는다.
관리 token 결속은 원 TUI terminal/goal/owner writer를 증명하지 않는다.

3) resetAt이 지난 뒤 동일 원 account를 다시 읽으려면
GET http://192.0.2.1:10101/api/aicc-local/original-quota/recovery?ownerRequestId=<OCX-UUID>&attestationSha256=<exact-SHA>
동일 관리 token/10101이 필수다. 요청자가 계정 ID, model/selector,
새 thread, quota percent 또는 generation을 지정할 수 없다. 원 refusal
안의 account SHA와 credential generation에 맞는 A1 snapshot 계정이
**정확히 하나**여야 하며 실제 usage(id) fresh read, 동일 300분 창,
backend allowed=true, 원 policy threshold 미만, long-window 정책
통과를 재검증한다. reset 전·타계정·세대 변경·UNKNOWN은 HOLD.
성공한 source-only 상태는 ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_SOURCE_ONLY,
private <OCX-request-UUID>.recovery.json 및 반환된 receiptSha256.

4) OCX quota source와 중앙 원 issuer/goal/stop/writer 권위는 다르다.
ownerRevisionVerified=false, stopEpochVerified=false, goalVerified=false,
writerReturnedVerified=false, originalCodexTurnTerminalVerified=false,
issuerAuthorityGranted=false, dispatchable=false, modelRequests=0,
newTurns=0 그대로다. 원 ce9a 결과 정산·STOPPED_FOR_MAINTENANCE·Disabled
Task와 workerStopRequestedAt는 유지한다. 중앙은 별도 reviewed backup,
READY, active/UNKNOWN consumed drain, registry CAS 및 rollback 뒤에만
정식 설치/원 sender 단회 ACK·새 turn·실제 goal 재착수를 판단한다.

이 소스는 OCX owner selection→pre-dispatch refusal→관리 인증 경계에
연결했다. 중앙 소유 17841 private adapter의
src/server.ts routeResponseRequest/readQuotaRefusalCorrelation은 수정하지
않았다. 원 private adapter가 위 ownerRequestId/SHA와 실제 TUI turn을
결속하는 것이 **다음 중앙 작업**이다.

근접 검증: bun test test/external-original-quota-receipt.test.ts
test/external-quota-refusal.test.ts test/desktop-account-picker-pool.test.ts.
runtime Bun build는 소스 compile 확인이며 운영 설치/모델 발신이 아니다.

## 2026-11-14 G1 original-issuer five-hour recovery: official read-only slice

Latest user `RESUME-20261114-0006` has **no expiry**. Do not reapply the
2026-11-10 deadline or turn the original five-hour rejection into another send.
The central goal is already ACTIVE as user-supplied state, not a claim proved
by this source. Do not issue `thread/goal/set`, a new goal or a new turn.

Official Codex App Server docs specify `account/rateLimits/read`,
`account/rateLimits/updated`, `thread/read`, `thread/goal/get` and
`turn/completed` (including failed terminal error info). The installed
`codex.exe --version` returned `codex-cli 0.167.0`; its `app-server --help`
advertised `generate-ts` and `generate-json-schema`. Actual generated
per-version schema inspection was **not completed**: the command wrapper
received the explicit AICC safety refusal
`Encoded PowerShell is blocked because its destructive target cannot be inspected safely.`
Do not reformat/redirect the rejected operation to bypass that refusal.

The existing `prepare-app-server-contract.mjs` now recognizes the
`account/rateLimits/read` read method **only if present in the selected
installed executable's generated ClientRequest.ts**. It pins that generated
request schema SHA in `manifest.officialQuotaRead` and keeps
`thread/goal/set`, account changes and all sends outside the general allowlist.
`CodexAppServerClient.rateLimitsReadForInspection()` requires the exact
read-only manifest, and `inspectExistingGoalQuotaWindow()` first verifies
the same thread/root, an unchanged goal snapshot and ACTIVE goal. It reads
the 300-minute quota bucket and returns an observation/HOLD, never a
claim, callback, worker activation, retry, ACK or model request. Missing,
multiple, limited, invalid or unknown quota results are HOLD. Account rate
limits on a newly attached App Server are **not proof** of the original
`codex -> 17841 -> nonweb OCX10101` issuer/account or previous failed turn.

Actual read-only original CLI inspection (no `-QuotaDeadlineUtc`) of
`00000000-0000-4000-8000-000000000000` returned:

- `registered=true`, `selectionEnabled=true`, `exactSavedSessionReadback=true`
- `originalPending=false`, `historicalOtherPending=1` (historical ce9a preserved)
- `maintenanceStopPresent=true`, `strictAccount` override absent
- `upstreamIssuerReceiptVerified=false`, `fiveHourFailureVerified=false`,
  `quotaResetAtVerified=false`, `ownerRevisionVerified=false`,
  `stopEpochVerified=false`, `ownerExitVerified=false`
- `queueAck=false`, `newTurnObserved=false`, `dispatchable=false`,
  `modelRequests=0`; state `ORIGINAL_ISSUER_CALLBACK_UNAVAILABLE_WORKER_STOPPED`

Do not infer a changed current goal from this old-style CLI session read.
Historical `ce9a` QUEUE_ACCEPTED is not terminal. Existing Queue-Progress
requires the exact original rollout UserMessage SHA/marker and a matching
turn terminal; the original issuer must settle the original ID first.
No blind replay, invented settlement, forced stop-fence clearance, Native
substitute, additional writer or alternate model/account.

To reach real automatic one-shot continuation the **original sender**
(not this observer) must provide an authentic typed five-hour failed-turn
receipt and fresh same-issuer OCX quota admission, same goal/route/thread,
monotonic `ownerRevision` + `stopEpoch`, terminal pending reconciliation,
normal writer return and its exact one-time ACK/new-turn protocol.
Existing stopped-worker immutable upgrade still requires owner backups,
independent READY, consumed active+UNKNOWN-zero drain, CAS and rollback.
Until those exact inputs are independently verified, installation/activation
and actual resumption remain HOLD; source-only test success is not production.

Scoped checks: `node --test test/codex-app-server-contract.test.mjs
test/codex-app-server.test.mjs test/codex-goal-resume.test.mjs`.
Existing unchanged strict worker regression and earlier source proofs are
reused, not reinterpreted as current installation acceptance.

## 2026-11-14 G1 원 App Server 발신자 quota 영수증 연쇄 (새 소스, 미설치)

중앙의 TUI `/goal resume` 1회와 `get_goal ACTIVE`는 별도 인수다. 이
source writer는 goal/set·thread/resume·turn/start·원 요청 재발신을 하지 않는다.
`RESUME-20261114-0006`은 계속 기한이 없으며 11/10 deadline 재적용 금지.

공식 문서 <https://developers.openai.com/codex/app-server/>의
`turn/started`, `turn/completed`, `account/rateLimits/read`,
`account/rateLimits/updated`, `thread/goal/get`을 토대로 한다.
기존에 이미 생성되어 보관된 설치 0.167.0 App Server 스키마
(owner store `g1-goal-resume-contract-20261110/0.167.0`)에서 다음을
실제 읽기 전용으로 확인했다: `CodexErrorInfo`의 `usageLimitExceeded`,
`GetAccountRateLimitsResponse.ordinaryUsageAllowed: boolean | null`,
`accountId: string | null`, `RateLimitWindow.windowDurationMins`,
`resetsAt`, `RateLimitSnapshot.rateLimitReachedType`.
특히 `ordinaryUsageAllowed=null`은 승인되지 않은 회복 증거다.
이 저장된 0.167.0 manifest에는 당시 `officialQuotaRead`가 null이었다.
새 소스 메서드는 **갱신된 설치 manifest에서 read-only method가
실제 allowlist에 있고 pinned client schema SHA가 확인될 때만** 동작한다.
이 작업은 CLI schema 생성 명령을 다시 실행하지 않았고, 이전 인코딩
PowerShell 보안 거절을 다른 wrapper로 재시도하지 않았다. 0.166 실제
스키마 대응과 원 OCX issuer 통합은 중앙에서 별도 검증해야 한다.

`CodexAppServerClient.captureOwnedFiveHourFailure()`는 같은 실제
연결에서 **turn/started와 turn/completed가 동일 thread·turn**인지를
대조한다. `turn.status=failed`, 타입 `codexErrorInfo=usageLimitExceeded`
그리고 같은 연결의 정확 `account/rateLimits/read`가 300분 창의
`usedPercent=100`, `rateLimitReachedType=rate_limit_reached`,
`ordinaryUsageAllowed=false`, 미래 6시간 이내 `resetsAt`, 실제
`accountId`를 함께 확인해야 한다. 오류 문장만으로 실패를 인정하지 않는다.
응답은 terminal 원문 SHA, 원연결 process identity SHA, 계정 ID의 SHA,
실패 turn ID와 300분 resetAt만 담는다. 원 upstream 메시지·계정 ID·
비밀번호·lease token 등 원문은 저장하지 않는다.

`captureOwnedFreshQuotaAdmission()`은 **같은 연결의 원 실패 영수증**과
resetAt 이후의 별도 공식 quota read를 비교한다. 계정 ID SHA 일치,
`ordinaryUsageAllowed=true`, usedPercent<100, rate-limit/reached/spend
해제가 모두 필요하다. sparse `rateLimits/updated` 통지만으로는
회복을 주장하지 않고 fresh `read`를 요구한다.

`inspectOriginalOwnerQuotaReceiptPair()`는 두 영수증의 exact SHA 연쇄,
goal snapshot, thread/root, 원 route 주장, 같은 process/계정 SHA,
원 ownerRevision/stopEpoch, resetAt/시각·120초 freshness와 역사 pending을
대조한다. 기존 `ce9a` pending이 1건이면 반드시 HOLD다. 이 함수는
외부 owner receipt를 스스로 인증할 수 없으므로 긍정 사례도
`RECEIPT_CHAIN_MATCHED_EXTERNAL_OWNER_GATE_REQUIRED`까지만 반환한다.
별도 App Server 관측을 원 TUI/OCX issuer 권한으로 전용하지 않는다.

기존 owner가 원 발신자 연결 안에서 위 두 관측을 얻었다면, 본문이 아닌
정확한 JSON 영수증을 owner-private 폴더에 불변 저장한 다음 각 실제
file SHA를 사용해 `tools/platform/codex/prepare-original-owner-quota-evidence.mjs`
에 `--failure`, `--failure-sha256`, `--admission`,
`--admission-sha256`, `--owner-revision`, `--stop-epoch`,
`--goal-sha256`, `--issuer-receipt-sha256`, `--thread-id`,
`--project-root`, `--output`을 전달한다. 출력 부모 폴더는 이미
존재해야 하며 candidate 파일은 create-once다. 새 output은
`aicc-original-cli-quota-source-owner-handoff/v1`,
`SOURCE_RECEIPTS_PINNED_OWNER_AUTHORITY_NOT_GRANTED` 상태다.
중앙 installer가 이 파일/영수증 SHA를 소비·검증할 수 있지만 이 파일
생성만으로 별도 모델 발신이나 owner claim을 허용할 수 없다.

**남은 실제 원 권위:** 같은 TUI→17841→nonweb OCX10101 프로세스에서
상기 owned client로 진짜 event/usage를 생산했다는 original issuer
receipt와 해시, 동일 account/route, 원 5시간 실패 turn·resetAt,
fresh 원 OCX admission, source writer 정상 종료 및 등록된 ownerRevision·
monotonic stopEpoch, 기존 ce9a 원 issuer 결과 조정이 아직 필요하다.
기존 STOPPED_FOR_MAINTENANCE·Disabled Task·workerStopRequestedAt 및
history pending은 수정하지 않았다. 중앙은 백업/독립 READY/drain/CAS
검증 후 기존 정식 updater에서만 별도 설치·발신 gate를 심사한다.
새 daemon·timer·반복 모델 예약·Native 대체·stop fence 완화 금지.

소스 근접 격리 검사: `node --test test/codex-app-server.test.mjs
test/codex-goal-resume.test.mjs test/codex-app-server-contract.test.mjs
test/codex-quota-owner-evidence.test.mjs`. 보안 거절·미확인 issuer
증거는 실제 검증값으로 승격하지 않는다.
## 2026-11-14 G1 원 issuer source 봉인·등록 소비 경계 (운영 미설치)

최신 RESUME-20261114-0006은 기한 없는 사용자 재개다. 원 goal은 이미 ACTIVE이므로
goal/set, 신규 goal, turn/start 또는 원 요청 재송을 수행하지 않는다.
기존 TUI→17841→nonweb OCX10101 일반 CLI 경로에는 정확한 quota callback과
단회 sender API가 아직 없다. 현재 확인된 tools/platform/codex/codex-aicc는
route launcher, src/adapters/codex-routes.mjs는 상태 reader이고
src/adapters/codex-app-server.mjs는 별도 App Server client다.
이 파일들을 조합해 원 OCX issuer authority를 만들 수 없다.
Windows Invoke-AiccCodexContinuity.ps1의 QuotaPreflight와
Get-StrictFiveHourQuotaTerminal은 다른 strict command-route-r2 전용이다.

### 실제 소스 연쇄: owner connected producer → 봉인 → read-only consumer

1. CodexAppServerClient.sealOwnedFiveHourFailure 는 기존 연결 안에서
   동일 thread/turn typed usageLimitExceeded와 공식 300분 rateLimits/read를
   확인하여 owner-private create-once JSON과 SHA를 기록한다.
   sealOwnedFreshQuotaAdmission 은 같은 프로세스에서 원 failure 파일 SHA,
   resetAt 이후 fresh read, 동일 backend-account SHA를 확인하고 새 영수증을
   봉인한다. 별도 App Server에서 성공해도 originalOcxIssuerVerified=false,
   dispatchable=false, modelRequests=0, newTurns=0 그대로다.
2. 기존 prepare-original-owner-quota-evidence.mjs 는 두 원 파일 SHA,
   ownerRevision/stopEpoch/goal/thread/route, primary/secondary 300분 동일창,
   실패 사용률 정확히 100%, 회복 사용률 100% 미만, 유한한 사용률과 reset,
   spend-control 명시 false를 재검사한 뒤
   aicc-original-cli-quota-source-owner-handoff/v1 을 create-once 생성한다.
   이 파일은 authority가 없는 source receipt다.
3. inspectSealedOriginalOwnerQuotaHandoff 는 현재 registrations.json SHA,
   source handoff 및 두 파일 SHA, 실제 읽힌 ACTIVE goal/thread/root,
   정확한 실패 turn/owner/route/계정 그리고 현재 pending 총계를 검사한다.
   원래의 ce9a 등 pending이 있거나 STOPPED_FOR_MAINTENANCE가 남으면 HOLD다.
   cfg.threads[threadId].originalIssuerQuotaCallback 이 없으면
   ORIGINAL_GENERAL_CLI_ISSUER_CALLBACK_NOT_REGISTERED_HOLD 상태로 보존한다.
   가짜 callback 내용을 맞춰도 반환은
   REGISTERED_CALLBACK_SOURCE_CHAIN_MATCHED_SENDER_AUTHORITY_REQUIRED 이며
   sender/ACK/new turn 권한이 아니다.
4. CodexContinuityMaintenance.psm1의
   Get-AiccGeneralCliQuotaEvidenceReadiness 는 현재 일반 CLI 등록/원
   saved session, exact source handoff SHA, historical pending과 stop fence를
   읽는 별도 함수다. import한 source 모듈에서만 사용할 수 있다.
   기존 설치된 서비스/원장/Task를 수정하지 않는다.

읽기 전용 진단 예시 (현재 운영에 설치됐다는 뜻이 아님):

    Import-Module .\tools\platform\windows\CodexContinuityMaintenance.psm1 -Force
    Get-AiccGeneralCliQuotaEvidenceReadiness -StateRoot $currentStateRoot -ThreadId $originalThreadId -SourceHandoffFile $privateHandoffFile -ExpectedSourceHandoffSha256 $handoffSha -ExpectedGoalSha256 $goalSnapshotSha

### 중앙 인수에 필요한, 현재 미지원인 원 발신자 producer

실제 발생 근거를 발행해야 할 범위는 기존 TUI/17841 HTTP sender와
nonweb OCX10101 원 발신자 구현(이번 승인된 open-AICC source 범위 밖)이다.
기존 private owner 구현의 정확한 파일/API 위치는 이 범위에서 확인되지
않았다. 기존 strict worker나 신규 App Server를 원 issuer로 대신할 수 없다.

원 producer가 원 실패 turn ID, 정확한 usage limit/300분 reset,
OCX 원계정 식별 SHA, 원 thread/root/route/goal, ownerRevision과
이전 값에 대해 단조적인 stopEpoch, 원 writer process identity와 실제
정상 반환/close를 자기 원장과 결속하여 callback을 봉인해야 한다.
중앙은 독립적인 원 issuer 검증과 현재 원장 CAS 뒤에만
aicc-original-cli-issuer-callback/v1 파일의 SHA를
aicc-original-cli-issuer-callback-pin/v1 (receiptFile/receiptSha256)에
등록할 수 있다. 사용자가 임의 JSON 또는 returned=true를 입력해도
인증 근거가 아니다. 원 producer의 실제 서명 발행/키 provisioning과 원 sender
단회 claim·ACK는 미구현이다. 아래 소스 등록 계획은 독립 등록된 producer가
없으면 거절하며, 아직 운영 설치하지 않았다.

설치 소비자는 원 callback 파일/SHA, 실패 및 admission/핸드오프 SHA,
현재 ownerRevision·단조 stopEpoch·원 writer 실제 반환,
exact route/thread/goal, fresh 원 issuer quota, 기존 ce9a의 원
terminal 정산, 원 task/stop fence와 현재 registry CAS를 다시 확인해야
한다. 이후 기존 정식 backup/독립 READY/consumed active0 UNKNOWN0 drain,
rollback·Apply를 중앙이 수행하고 원 sender 1회 ACK, 새 turn ID,
원 goal 실제 착수를 다시 확인해야 자동복귀 달성이다.
ce9a pending, Disabled Task, workerStopRequestedAt를 임의 삭제하거나
UNKNOWN 재송, Native 대체, 새 daemon/모델 예약 또는 exec resume으로
우회하지 않는다.

근접 회귀: node --test test/codex-app-server.test.mjs
test/codex-goal-resume.test.mjs test/codex-quota-owner-evidence.test.mjs
test/codex-app-server-contract.test.mjs. 소스 PASS는 운영 복구 증거가 아니다.

## 명시 사용자 요청에 따른 기존 goal 재개 · 2026-11-10

공식 App Server의 `thread/goal/set`은 `objective`와 `tokenBudget`을 생략하면
기존 목표와 사용 이력을 유지하고 상태만 바꾼다. 사용자 재개 요청은
`origin=user`로 전달한다. `/goal resume`은 TUI 명령이며 `codex goal resume`이라는
셸 하위 명령은 없다. 공식 계약: <https://developers.openai.com/codex/app-server>.

기존 `prepare-app-server-contract.mjs`가 설치 바이너리의 실제
`ThreadGoalSetParams`에 사용자 provenance와 active 상태가 있는지 확인하고
`manifest.userGoalResume`에 schema SHA를 기록한다. 일반 mutation allowlist는
넓히지 않는다. `tools/platform/codex/resume-user-goal.mjs`는 manifest SHA와
동일 daemon 바이너리·기존 socket·exact thread/root·현재 목표 snapshot을 검증한다.

읽기 미리보기:
`node tools/platform/codex/resume-user-goal.mjs --thread <원 UUID> --root <원 root>
--manifest <exact manifest> --manifest-sha256 <SHA>`.
같은 사용자 요청의 실제 적용에는 `--apply --expected-goal-sha256 <preview SHA>
--user-request-ref <사용자의 재개 지시 ref>`를 더한다. 작성권을 가진 같은 서버에
대화가 loaded 상태일 때만 허용한다. `thread/resume`, 새 turn, 새 목표 생성,
내부 goal 파일 직접 편집과 재시도는 하지 않는다. 응답 불명은 readback으로만 조정한다.

이 연결은 blocked/paused의 명시 재개용 소스다. usageLimited 자동복귀는
원 issuer의 fresh quota/owner/stop 계약이 별도로 필요하다. parent 결과 소비 권위와도
다르다. 현재 운영 socket 부모의 기존 owner-only ACL 계약이 충족되지 않아
읽기 preview가 `full_control_missing`으로 HOLD됐다. ACL 변경·daemon 재시작·
실제 goal mutation은 0이며 소스 검증을 운영 재개로 보고하지 않는다.

Windows AF_UNIX endpoint의 reparse tag는 `0x80000023`이다. Node `lstat`의 EACCES만으로
실제 계정 권한 부재를 단정하지 않는다. 기존 proxy는 PowerShell 읽기로 정확한
type/owner/ACL을 확인하되 parent 보안 계약은 유지한다. 격리 실제 AF_UNIX endpoint와
regular-file/parent-ACL 거절을 검증했다. 운영 socket 권한을 자동으로 바꾸지 않는다.

## 현재 일반 CLI의 읽기 전용 상태 조회

현재 공식 원 대화를 조회할 때는 기존 설치기 진입점에서
`-InspectGeneralCliContinuity -ThreadId <exact UUID>`를 사용한다.
기한 없는 사용자 재개에서는 `-QuotaDeadlineUtc`를 생략한다.
기한을 지정하면 미래·만료된 기한 모두 조회할 수 있고 `deadlineExpired`로
만료 여부를 반환한다. 잘못된 날짜·등록되지 않은 대화·원본 범위 오류는
계속 거절한다. 이 조회는 기한 연장·원 issuer 증명·발신 권한이 아니다.
`dispatchable=false`, `modelRequests=0`은 그대로 유지된다.

기존 strict launcher의 검증된 갱신과 정확한 원장 바이트 롤백은
`PrepareMaintenanceUpgrade`/`ApplyMaintenanceUpgrade`와
`InspectMaintenanceUpgrade`/`RollbackMaintenanceUpgrade`가 담당한다.
Prepare는 원 immutable closure·실제 CLI pin·Task XML·worker 정지를 검증한다.
후보 closure가 이미 설치된 것과 같으면 재설치하지 않는다.
일반 CLI 원 issuer의 quota callback·안전한 owner handoff와 공식 sender 지원은
별도 확인 대상이며, 설치 또는 읽기 성공만으로 자동복귀를 선언하지 않는다.
아래 날짜 있는 절은 각 당시 source-only 관측 이력이다.

## G1 중앙 CLI 5시간 quota 원 발신자 단회재개 후보 (2026-11-10 · source-only)

이번 변경은 실제 운영 재개가 아니라 정식 sender에 넣을 **진단·원인 분류**다.
현재 정확 중앙 thread의 등록·enabled 상태는 확인됐지만 strictAccount=null,
`lastStrictRouteReceipt.quotaTerminal` 없음, STOPPED_FOR_MAINTENANCE·Task
Disabled·`workerStopRequestedAt` 존속, 역사적 ce9a QUEUE_ACCEPTED 1건은
원 issuer 조정 전이다. 일반 `exec resume`으로 원 CLI 작성권을 가져오지 않는다.

소스 `Invoke-AiccCodexContinuity.ps1`의 새 `QuotaPreflight`는 PowerShell 7.5+
정식 source helper로 **읽기 전용** 판정을 제공한다. 호출 인자는
`-Action QuotaPreflight -ThreadId <실원UUID> -StrictAccountNumber 2`
`-QuotaDeadlineUtc 2026-11-10T06:00:00Z`이며 현재 pinned 설치본은
이 action이 없으므로 운영 상태에서 호출하지 않는다. 등록 helper SHA가
일치해야 하며, 결과의 `dispatchable=false`, `modelRequests=0`,
`queueAck=false`, `newTurnObserved=false`는 발신 성공 증거가 아니다.

신규 strict worker만 직접 관측한 typed `turn.failed`의 OCX provider,
`usage_limit_reached`, `five_hour`, resetAt (최대 6시간),
원 `thread.started`/`turn.started` ID, 원 claim/route/원전송
terminal ACK를 대조한다. 오류 **문구**만으로 5시간 거절이라고
판정하지 않는다. 새 원 quota terminal은 원 `lastContinuityAttempt`에
결속해 보존하며, `EXACT_QUOTA_OWNER_REAUTHORISATION_HOLD`는
자동 재발신이 아니라 독립 owner의 정식 1회 재인가가 필요함을 뜻한다.
원래 CLI가 이전에 실행됐을 때 stdout/원 issuer/quota resetAt을 관측하는
계약은 이 정지 worker의 책임이 아니다. 그 원 발신자 API 없으면 HOLD다.

현재 소스의 공식 `Maintenance-Closure`는 helper·정식 strict bridge
·route module 등 8개 파일을 SHA로 묶는다. 기존 설치기는 stopped
worker 원장·pin·pending 파일·`worker.lock` CAS를 보호하나
이미 `strictRouteLauncher`가 등록됐을 때 `existing_strict_launcher_preserved`
로 기존 maintenance upgrade 적용을 거절한다. 이 경우 구 installed
configuration을 덮어쓸 수 없으며 별도의 exact installed release
업그레이드 지원/rollback을 중앙이 먼저 완성해야 한다. 준비만으로
`workerStopRequestedAt`를 지우거나 old ce9a를 전역 해제하지 않는다.

중앙 적용 전 조건은 실제 원 발신자 quota/ownerRevision/stopEpoch
원영수증, 동일 current goal/route/정확한 대화, 사용자 중지·기타 오류
없음, deadline 이전, 원 작성권 반환, fresh 동일 OCX quota admission
및 1회 claim의 owner-only 설치/원 registry CAS·백업/rollback이다.
중앙의 별도 independent READY·3 provider consumed drain 확인 뒤에만
maintenance immutable Apply를 수행하고, 마지막에 정확 원큐 ACK,
새 turn ID, 기존 goal 착수까지 확인해야 실제 자동재개 완료다.

근접 검사: `Test-AiccCodexContinuityExactQuota.ps1`의 fake 17PASS,
기존 `Test-AiccCodexContinuityStrictRoute.ps1` fake 22PASS. 구 worker
설치·재시작/실 quota terminal/모델 발신은 수행하지 않았다.
결과 정본: `backups/g1-central-quota-resume-20261110/result.json`.


## G1 원 발신자 pending 근거 표시 · source-only (2026-11-10)

`CodexContinuityGroupActivation.ps1`의 기존 `GroupActivation-Readiness`는
전역 pending 원장을 먼저 검사하고 1건 이상이면 **계속 BLOCKED** 처리한다.
이 분기에서만 읽기 전용 `pendingResolution`을 추가했다.
`historicalQueueAccepted`, `otherPending`, `status=ISSUER_SETTLEMENT_NOT_RECORDED`,
`nextActor=ORIGINAL_ISSUER`, `officialOriginalResultRequired=true`,
`ownerHandoffChecked=false`, `automaticReplay=false`를 보고한다.
기존 `HISTORICAL_QUEUE_ACCEPTED_UNSETTLED`/`GLOBAL_PENDING_DELIVERY_UNSETTLED`
이유와 stop fence·quota·owner 전달·모델 발신 차단은 그대로다.

원 `ce9a`의 QUEUE_ACCEPTED는 terminal/종료 증거가 아니다. 원 issuer의
공식 원결과·terminal 및 정확한 thread/root·원본문 결속을 확인한 뒤
기존 조정기만 사용한다. 원 owner가 살아 있는 동안 정상 writer 반환
또한 별도 필요하다. 증거가 없으면 pending과 stopped Task를 보존하고
새 ID 재전송, 강제종료, `exec resume` 채택, 가짜 완료/예외를 만들지 않는다.
이 출력은 활성 설치판의 기능이나 original issuer 조회 결과를 뜻하지 않는다.
근접 가짜 검사: `tools/platform/test/Test-AiccGroupActivationPendingProofFake.ps1`.
운영 적용은 중앙이 기존 정식 source pin·설치·fresh owner/preflight/READY
순서로 별도 인수한다. Host 반환 증거는 [Host 계약](../../components/host-control/README.md#g1-original-owner-host-return-evidence-diagnosis--source-only-2026-11-10)을 참조한다.


## 정확한 큐 결과 회수 (2026-11-08, 소스)

`Queue-Progress`는 UI용 마지막 1MiB 대신 원 rollout을 줄 단위로 읽는다.
원 thread/operation, 발신 본문 SHA-256과 마지막 exact marker가 일치하는
UserMessage의 turn에만 terminal을 연결한다. 이웃 turn·진단 인용·중복 marker·
부분 JSON·원본 부재는 미결 유지다. `turn_aborted`는 요청 결과를 보존하고
명시적 `INTERRUPTED_TURN_HOLD`로 남겨 무인 재시작하지 않는다.
receipt 저장 뒤 registry가 갱신되기 전에 끊겨도 같은 원기록으로 재조정하며
요청을 다시 보내지 않는다. 근접 검사는 `Test-AiccCodexContinuityQueueRecovery.ps1`이다.
이는 소스 보강이며 이미 실행 중인 immutable helper 변경이나 과거 미결 해제를
뜻하지 않는다. 압축 원본만 남고 정확한 발신/terminal 근거가 없으면 기존
issuer의 원결과 조정이 필요하며 global pending gate는 유지한다.

원본 session metadata의 exact thread/root도 대조한다. 저장된 turn ID만으로
본문 증명을 생략하지 않으며 상충하는 완료/중단 terminal은 미결로 보존한다.
pending 진단 이유 변경도 저장한다. receipt 저장 직후 registry 반영 전에
중단된 경우, 원문과 terminal을 재검증해 같은 결과를 회수하고 재발신하지 않는다.

## G1 stopped 설치 이후 activation (2026-11-07, source-only)

정식 `INSTALLED_STOPPED`는 immutable 설치와 Task 비활성만 확인한 상태다.
같은 설치 명령을 반복하지 않는다. 기존
`Install-AiccCodexContinuity.ps1`은 별도
`-InspectGroupActivation`, `-PreviewGroupActivation`,
`-ApplyGroupActivation`, `-RollbackGroupActivation`을 지원한다.
이는 source 계약이며 현재 운영 Task/worker를 활성화한 증거가 아니다.

관리형 PowerShell 7.5+ 소유자 환경에서만 아래 순서로 진행한다.
`<installed-plan>`은 이미 성공한 **기존** GroupOwner 설치 계획 파일,
`<activation-plan>`은 같은 owner-local `StateRoot/plans`의 새 고유 파일이다.
실제 결과의 hash를 복사해 넣고, 예시를 그대로 실행하지 않는다.

```powershell
$installer = 'C:\demo\open-AICC\tools\platform\windows\Install-AiccCodexContinuity.ps1'
& $installer -InspectGroupActivation -GroupInstallPlanFile '<installed-plan>'
& $installer -PreviewGroupActivation -GroupInstallPlanFile '<installed-plan>' -PlanFile '<activation-plan>'
# PREPARED 결과 및 planSha256을 받은 경우에만:
& $installer -ApplyGroupActivation -PlanFile '<activation-plan>' -ExpectedPlanSha256 '<exact-plan-SHA256>' -Confirm 'ACTIVATE GROUP OWNER <exact-plan-SHA256>'
& $installer -InspectGroupActivation -GroupInstallPlanFile '<installed-plan>'
# 실제 worker 시작 전이고 같은 pre/post-image, stopEpoch, worker.lock이 증명될 때만:
& $installer -RollbackGroupActivation -PlanFile '<activation-plan>' -Confirm 'ROLLBACK GROUP ACTIVATION <receipt.afterRegistrySha256>'
```

`BLOCKED/HISTORICAL_QUEUE_ACCEPTED_UNSETTLED`는 원 Desktop 요청의 수락만
확인됐고 최종 결과가 미확정이라는 뜻이다. 당시 원 요청의 후속 진위는
기존 issuer가 조정해야 한다. pending 하나라도 있으면 Preview는 계획을
만들지 않으며 Apply는 어떤 Task·원장·모델 변경도 하지 않는다. 별도 pending
예외, 가짜 settlement, 원 요청 재전송은 없다.
`ORIGINAL_OWNER_ALIVE_NO_OFFICIAL_HANDOFF`는 원 CLI owner가 아직 살아
있고 현재 공식 소유권 전달 기능이 없다는 뜻이다. `exec resume`으로
owner를 가로채지 않는다. 원 PID의 정상 종료·writer 반환, fresh
GroupAuthorise issuer·registration·event, 원 thread/root/stop epoch,
계정2 선택·fresh quota, 단일 worker와 기존 Task의 hash/소유권이 모두
확인된 후에만 계획을 허용한다. 새 StopWorker는 과거 stop epoch를
영구 무효화하므로 재활용하지 않는다.

`ACTIVATION_START_SUBMITTED`는 기존 Task 시작 요청일 뿐 worker 실행/새
turn을 입증하지 않는다. `ACTIVATION_STARTED_UNVERIFIED`와
`WORKER_RUNNING_UNVERIFIED`는 별도 readback 필요 상태다. 불변 Task·실제
worker/PID, 정확 등록과 최신 사건을 독립 확인한 뒤에만
`GroupEnqueue`를 고려한다. 작업 실패·CAS drift·원 실행 중에는
create-once partial/start-hold를 조정하고 원 Apply를 다시 실행하지 않는다.
Rollback은 worker가 아직 시작하지 않았다는 엄격한 증거가 있을 때만
가능하며 실행 중 worker를 강제로 중지하지 않는다.

`STOPPED_FOR_MAINTENANCE`에서는 모델 재개와 설치를 분리한다. 정지 표시는
실제 프로세스 퇴장 증거가 아니다. 현재 worker PID의 조회 성공·부재와
`worker.lock` 독점 확보를 함께 요구한다. 조회 오류·재사용 PID·잠금 충돌은
보류하고 기존 정지 요청을 지우지 않는다.

기존 설치기의 `-UpdateCodexPin`은 위 정지 증거 아래에서도 구·신 공식
CLI 서명, 관리 release/current 연결, 원장 CAS와 원 영수증을 검사한다.
정확히 선택한 top-level CLI SHA와 현재 등록된 strictRouteLauncher의 CLI SHA만 갱신한다. 과거 thread·queue 안의 같은 이름 SHA는 보존한다. 중복 키·불일치·이스케이프된 검증값은 claim 전에 거절하며, UTF-8 원문에서 두 값 외의 모든 바이트를 보존한다.

기존 설치기의 별도 `-PrepareMaintenanceUpgrade -NodePath <등록 Node>
-PlanFile <새 파일>`은 helper와 strict bridge의 상대 import 전체를 계획에
봉인한다. `-ApplyMaintenanceUpgrade -PlanFile <같은 파일>
-ExpectedPlanSha256 <반환 hash> -Confirm 'INSTALL STOPPED CONTINUITY <hash>'`는
5분 이내 계획을 한 번 소비한다. 기존 helper, thread와 정지 요청·원 큐·영수증을
검사·백업하고 불변 release에 파일을 복사한 뒤 helper/strict launcher만 등록한다.
task·worker·선택계정·thread enable은 변경하지 않는다.

보존 가능한 과거 큐는 기존 검토된 exact helper의 disabled·QUEUE_ACCEPTED·별도
Desktop binary·automaticReplay=false·원 영수증 일치 계약에 한한다. 설치 후에도
그 원 요청은 미결이다. 새 helper가 과거 큐를 완료 처리했다는 뜻이 아니다.
정식 정비본으로 helper가 교체된 뒤에도 검토된 exact helper SHA와 설치된
strict closure의 모든 파일 SHA, `STOPPED_FOR_MAINTENANCE`와 정지 요청이
일치할 때만 같은 보존 분류를 허용한다. `Test-AiccCodexContinuityMaintenanceQueue.ps1`은
교체본·의존파일 변조·재전송·활성 요청 반례를 검사한다. 이 분류는 설치에만
적용되며 worker의 전체 pending 발신 차단을 해제하지 않는다.
모델 재개는 같은 thread/root의 실행 위험·작성권·현재 계정 quota·등록 opt-in을
별도로 확인해야 하며, 모든 pending을 일괄 무시하는 옵션은 제공하지 않는다.

claim 뒤 APPLIED 영수증이 없으면 원시도를 재실행하지 않는다. 복구는 실제
설치 before/after hash와 현재 registry를 같은 lock 아래 대조한 뒤 자기
변경만 되돌린다. task나 다른 등록 변경을 포함한 blind-copy는 하지 않는다.
정비 후 task가 구 helper를 가리키는 동안에는 정지 fence를 해제하지 않는다.

근접 합성 검사는 `Test-AiccCodexContinuityMaintenancePin.ps1`과
`Test-AiccCodexContinuityMaintenanceInstall.ps1`이다. 검사 성공과 실제 설치,
worker 기동, strict 선택계정 모델 요청·ACK는 별도 수용 단계다.

## 결과 회수 후의 다음 배정

`src/group-followup-service.mjs`는 기존 DurableJobStore에서 결과 hash별 단회
관제 사건을 추적한다. 원 중앙 thread/root·계정2·command-route-r2·fresh quota·
원 pending 없음·작성권 반환·사용자 중지 없음·fresh authority를 함께 증명한
adapter가 없으면 발신하지 않는다. 접수와 turn 시작/완료는 별개이며 claim 이후
결과 불명은 재전송하지 않는다. 새 결과마다 중앙이 다음 배정/사건 대기/전체
완료를 선택해야 한다.

이 모듈은 현재 source-only다. 기존 upstream 전용 scheduler의 고정 hash와
등록을 변경하거나 그 주기를 그룹 메시지 heartbeat로 전용하지 않는다. 실제
Windows 동일 대화 callback·strict route 인수가 완료되기 전 무인 그룹 운영이
설치됐다고 표시하지 않는다.
## G1 recovered-cli transport와 historical queue 롤백 (source-only)

원본 session_meta.source가 vscode/Desktop인 일반 대화는 기존 앱 transport다.
원본을 official CLI의 `--no-daemon resume <원 UUID>`로 실제 복구한
**단일 정확한 대화만** 명시 opt-in 파일로 연결한다. 원 세션 메타를
cli로 변경하거나 desktop 전체 허용목록에 넣지 않는다.

owner-local `StateRoot/plans/<새고유명>.json`에 독립 증거를 준비한다.
증거는 `schemaVersion=1`, `kind=aicc-recovered-cli-transport`,
`threadId`, `projectRoot`, `rollout`, `metaSha256`(원 jsonl 첫 줄의
UTF-8 SHA-256), `codexExecutable`, `codexSha256`,
`signerThumbprint`(서명자 인증서 40자리 대문자 지문),
`ownerPid`, `ownerCreatedAt`(원 PID 생성시각 UTC ISO),
`resumeArgs=["--no-daemon","resume",원 UUID]`, `commandLineSha256`
(실제 전체 명령행 UTF-8 SHA-256)을 모두 요구한다. 파일은 비밀을 담지
않으며 원 세션 본문·대체 대화·subagent 정보는 사용하지 않는다. 증거
파일 그 자체는 권한이 아니다. 계획·적용 때 현재 공식 managed standalone
release/current 연결, OpenAI Authenticode 서명/지문, binary SHA,
원 파일 활성 sessions 경로·첫 줄과 실제 PID/생성시각/정확 명령 전체를
각각 대조한다. 서명불명·과거 메타 변경·일부 인수 일치만으로 승인하지 않는다.

정식 미리보기 전용 opt-in:
`Install-AiccCodexContinuity.ps1 -PreviewGroupOwner -RecoveredCliEvidenceFile
<owner-local-plans-evidence.json> -ThreadId <exact-original-UUID>
-TargetRoot <exact-original-root> -OwnerRevision <exact-owner-SHA>
-StopEpoch <exact-number> -WorkerOperationId <exact-UUID>
-NodePath <pinned-node> -PlanFile <new-owner-plans-group.json>`.
적용은 기존 `-ApplyGroupOwner -PlanFile <plan> -ExpectedPlanSha256
<preview-SHA> -Confirm "INSTALL GROUP OWNER <preview-SHA>"`,
취소는 기존 `-RollbackGroupOwner -PlanFile <plan>
-Confirm "ROLLBACK GROUP OWNER <after-registry-SHA>"`만 사용한다.
별도 rollback 우회 옵션은 없다. 미리보기·적용은 **worker stop fence**
와 정확한 소유자·실행파일 증명을 요구하고 Task 등록은 항상 비활성,
worker/model 실행은 하지 않는다. 원 PID가 살아 있으면 소유자 종료로
오인하지 않으며, worker claim은 원 PID 종료·미분류 CLI 없음·현재 terminal·
선택계정2 fresh quota·전체 pending=0·exact group event가 모두 증명된
이후에만 가능하다. source 검사는 운영 승인이나 실제 worker 발신 증거가 아니다.

롤백은 설치 plan SHA·성공 영수증·beforeRegistry의 원 historical
disabled QUEUE_ACCEPTED 및 receipt SHA가 모두 같으면 그 1건을 보존하고
정지 상태에서 허용한다. queue 추가·변조, 새 attempt/claim/groupEvent
또는 원 외 group-claims/group-events 마커, registry/Task CAS 불일치에는
거절한다. 새 이벤트를 삭제하거나 historical UNKNOWN을 정산하지 않는다.
Task 변경 뒤 registry commit 이전 실패는 자기 Task postimage와 원 Task XML,
원 registry SHA가 정확할 때만 자기 변경 복구를 시도한다. 불명/부분 실패는
같은 계획의 create-once `.partial.json` 영수증으로 보존하고 수동 조정한다.

현재 원 historical queue가 **global pending gate를 막는 동안 자동 발신 HOLD**다.
중앙 관제가 새 preview→서명된 정식 apply→readback→writer 반환→원 owner 종료,
pending 정산 및 단회 group-event 권한을 별도로 검증하기 전, 새 task·서비스·
registry 적용이나 실제 모델 요청을 실행하지 않는다. 전용 비점유 fake 검사는
`tools/platform/test/Test-AiccGroupRecoveredOwnerFake.ps1`이고 기존 완료
46PASS/41PASS와 full build를 재실행하는 계약이 아니다.

### Windows 관리형 standalone 릴리스 경로 (source-only)

Task Scheduler may return its principal as a local account name, a qualified
name, or a SID. GroupOwner installation translates that identity to a SID and
compares it with the current owner SID. Unresolvable or foreign identities are
refused; the task must still use Limited/LeastPrivilege. Installer elevation
does not elevate the installed worker. Focused identity check:
`tools/platform/test/Test-AiccGroupTaskOwnerSid.ps1`.

stopped GroupOwner preview/apply와 설치 후 owner 판정은
`current` Junction의 `ResolveLinkTarget(true)`를 호출하지 않는다.
Windows의 `untrusted mount point` 오류가 발생하면 OS 신뢰/ACL/마운트
정책을 완화하거나 다른 실행기로 우회하지 않는다. 대신 현재 Junction의
단일 `Target` 메타데이터가 정확히
`releases/<버전>-<아키텍처>-pc-windows-msvc` 형태의 상대 경로이거나,
Windows가 반환하는 동일한 관리형 자식의 정확한 절대 경로인 경우에만
`standalone/releases`의 바로 아래 자식 하나를 직접 확인한다.
외부 절대 경로·상위/중간 경로, 복수 대상, 연쇄 링크, 불명한 metadata는 거절한다.
직접 릴리스의 파일부터 디스크 루트까지 모든 항목은 nonreparse이며,
`current`만 검증된 Junction으로 남는다.

이 경로 선택은 권한이나 신원 증명이 아니다. 공식 OpenAI Authenticode
유효 서명/정확한 인증서 지문, 실제 `current/bin/codex.exe` anchor와 직접
`release/bin/codex.exe`의 SHA-256 일치, 원 PID/생성시각·실제 실행 경로·
전체 명령행 SHA·정확한 `--no-daemon resume <원 UUID>`·원 세션 메타 SHA
확인은 기존대로 모두 필요하다. Windows가 anchor를 읽는 것까지 거절하면
**HOLD**하고, 직접 릴리스만 읽어 통과시키지 않는다.

fresh stopped preview와 apply의 5분/단회 확인, registry·Task·과거 큐 CAS,
stop fence와 전체 pending gate는 변경하지 않는다. 이 작업은 source-only:
실제 설치, worker, registry/task 변경, 모델 전송이 아니다. 새 반례는
`tools/platform/test/Test-AiccGroupManagedReleaseFake.ps1`에 한정한다.
중앙에서 소스 hash 인수 후 fresh official preview/apply/readback을
별도로 수행하며 기존 23/46/41 전체 검사는 되풀이하지 않는다.

## 원 issuer 서명 검증과 owner-local 등록 계획 · 2026-11-14 (소스)

`src/codex-goal-resume.mjs`의 `verifyRegisteredOriginalIssuerCallback`은 기존
registry의 `originalGeneralCliIssuerProducer`에 독립 등록된 Ed25519 공개키와
producer 실행 파일 SHA를 검증한다. callback 안의 키나 returned=true를 신뢰하지
않는다. `signedSource.payloadBase64` 원 bytes의 서명을 확인하고 thread/root/goal,
ownerRevision, 현재·이전 stopEpoch, 원 account/terminal/process/두 quota 영수증
SHA 및 120초 freshness를 대조한다. 공개키 pin schema는
`aicc-original-cli-issuer-producer-pin/v1`이며 keyId, route, executableFile,
executableSha256, publicKeyPem, publicKeySha256(SPKI DER)을 갖는다.
서명 payload는 callback 필드와 producerExecutableSha256, observedAt을 담는다.

서명 producer와 source 소비자는 초기화 시각을 양의 안전한 정수로 검사하고,
`backendLimitProven`을 명시적 boolean으로 요구한다. 최근에 봉인한 증거라도
그 안의 quota 조회가 원 초기화 이전이면 거절한다. 서명 유효성과 봉인 시각만으로
한도 회복을 추정하지 않는다. 이 검사는 등록·worker 시작·원 sender 권위를 부여하지 않는다.

`prepareOriginalIssuerCallbackRegistration`은 기존 source/goal/pending/stop 검사와
독립 producer 서명을 통과한 후보만 preview로 반환한다. 등록 중복과 awaited
조회 도중 registry 변경을 거절한다. `New-AiccOriginalIssuerCallbackPlan` →
`Invoke-AiccOriginalIssuerCallbackPlan`은 기존 owner-local plans 및 registry lock을
재사용한다. 정확 SHA 확인·60초 preview·실제 source 재검사·CAS·create-once claim·
정확 이전 registry backup·commit readback·receipt를 유지한다. Task/worker/stop/
pending/route를 바꾸거나 모델 요청을 보내지 않는다. `Callback-Inspect`는 원
pending, 정비 stop, producer 미등록을 daemon 접속 전에 거절한다.

실제 현재 경로에는 producer 키 등록/서명 발행이 없으며 과거 원 queue 요청도
정산되지 않았다. source preview/등록은 sender 권위나 자동 재개가 아니다.
운영 설치와 원 sender 단회 claim/ACK·새 turn은 별도 미완료다. 현재 daemon socket
연결 거절은 이 권위를 다른 App Server나 Native로 대신할 근거가 아니다.

원 callback 검사 CLI는 manifest pin, 읽기 전용 계약, 실행 파일 pin,
원 daemon 연결/신원, 검사 도중 설치 변경을 서로 다른 HOLD로 반환한다.
인수 누락·중복·알 수 없는 옵션은 접속 전에 거절하며, manifest에
`turn/start` 등 발신 권한이 섞이면 접속하지 않는다. 원 source 검사 결과는
그대로 보존하고 모든 실패에 자동 재시도·새 daemon 기동·모델 요청은 없다.
`canApply=false`의 exit 4는 JSON의 구체 상태와 함께 읽는다.

검사 CLI는 daemon version 조회 전 기존 producer의 pinned registry 사전검사를
재사용한다. 과거 pending, 정비 stop, 원 producer/reader 미등록 및 registry pin
불일치는 `ORIGINAL_PRODUCER_PREFLIGHT_HOLD`로 즉시 종료하며 daemon에 접속하지
않는다. 실패 원문과 개인 registry 내용은 출력하지 않는다. 이 사전검사를
통과해도 이후 원 daemon 신원·callback 서명·owner CAS 검사는 모두 필요하다.
근접 검사는 `test/codex-original-issuer-inspection.test.mjs`이며 진단 성공은
producer 등록·원 pending 정산·운영 설치·자동 재개 완료와 별개다.

원 큐 읽기 검사도 daemon version 조회 후와 전체 읽기 완료 후에 발신 실행파일과
daemon 실행파일 SHA를 다시 확인한다. 중간 교체는
`ORIGINAL_QUEUE_ISSUER_INSTALLATION_DRIFT_HOLD`이며 읽은 완료 turn을 채택하지 않는다.
registry/manifest가 그대로여도 binary 교체를 허용하지 않는다. pending/stop은 보존하며
이 검사는 발신·정산·새 daemon 시작을 하지 않는다.

원 callback 검사에도 같은 설치 경계를 적용한다. version 조회가 끝난 직후와
source 검사가 끝난 직후 manifest·발신 실행파일·daemon 실행파일을 모두 재확인한다.
daemon이 별도 복사본이면 두 파일을 각각 확인한다. 중간 교체는
`ORIGINAL_CALLBACK_INSTALLATION_DRIFT_HOLD`로 원 source 결과를 폐기한다.
근접 검사 `test/codex-original-issuer-inspection.test.mjs`는 연결 전 교체와
조회 후 별도 daemon 교체를 fake transport로 검증하며 실제 callback 등록이나 발신은 없다.

## helper와 provider의 상호 의존 교체 · 2026-11-15 소스

구형 provider가 신규 helper의 필수 `QueueOwnerRequestFile`을 전달하지 못하면
helper-only와 provider-only를 순서대로 적용하는 방식은 서로 막힐 수 있다.
기존 `Prepare-AiccGptQueueRuntime.ps1 -UpdateInstalledProvider`로 provider와
두 manifest만 바뀌는 불변 stage를 준비한 뒤, 기존 owner 교체 준비기에
`-UpgradeIssuerAndProviderTogether -UpgradeCurrentIssuerHelper
-ReplaceExistingOwnerBinding -RebindUnregisteredSameOperation -StageReceipt
<검토된 stage.json>`을 함께 지정한다. 원 owner/prepared/Native/CAS 인수는
기존 helper 교체와 동일하게 모두 필요하다. 기본 경로는 바뀌지 않는다.

combined 후보는 stage owner·source pin·전체 전후 inventory·정확한 세 파일
delta를 검사한다. 같은 거래에서 새 backend와 owner config 및 gateway를 묶고,
실제 후보 backend로 도구 목록과 원 issuer를 검증한다. Apply도 같은 검증과
백업·독립 READY·소비된 drain·rollback 계약을 사용한다. 설치된 구형 파일을
덮거나 무핀 source만으로 운영 후보를 승인하지 않는다. stage와 양쪽 변경
파일도 기존 이중 복구 백업에 포함해야 한다.

후보의 `queueCombinedIssuerProviderUpdate=true`는 검토 모드 표시일 뿐 설치나
발신 근거가 아니다. 실제 설치·paused 등록·ACK·새 turn·quota 회복 후 자동
재착수는 각각 확인한다. 소유 target이 없거나 원 임대가 증명되지 않으면
과거 후보를 재실행하지 않고 원 요청과 미결을 보존한다.

## 공유 issuer listener 인수 보류 · 2026-11-18

공유 Bun listener의 보호 폴더/ready hello는 native OS peer 인증이 아니다. 원 caller는 expected runtime=undefined로 consumer를 호출했고, 격리된 무인증 연결의 올바른 형태 hello만으로 bind가 실제 1회 발생했다. 반례 1 FAIL 후 이 미지원 acceptor를 시작 전 `original_issuer_os_peer_authority_required`로 차단했다. 신규 거절/소켓 미생성/공유 host 보존 2 PASS. private consumer/native retained-handle API는 보존했으며 권한을 자가 주장하는 callback/boolean을 추가하지 않았다.

실제 등록 운영 release에는 이 listener가 없음을 읽기 확인했다. 이번은 소스 containment이고 운영 교체·자동재개 성공이 아니다. 기존 R27 real-source integration harness는 같은 명시적 미지원 경계에서 막히므로 과거 긍정 인수로 재사용하지 않는다. 다음은 기존 native OS 소켓/retained process handle 계층을 사용하는 인증 acceptor와 정확한 등록 shared process 수명 결속이며, 실제 양방향 신원/foreign 거절/held 정산/공유서비스 생존을 먼저 입증한다. 원 UNKNOWN·정비stop·역사pending는 별도 정식 조정한다.

2026-11-19 R37 소스 후속: 기존 codex-uds 계층의 전용 inherited pipe는 kernel pipe server=실제 OS부모/시작수명·동일사용자 비관리자·stdio별칭을 확인한다. Node-API addon과 shared Bun outbound 소비분기 소스가 추가됐고, native6/Bun7·기존차단2 격리검사 PASS. runtime은 addon nativeAdapterFiles SHA/realpath 봉인 없이는 로드하지 않는다. 정식 release producer의 addon봉인·등록 launcher retained Bun/pipe생성·원TUI capability 전달/caller 연결 및 운영설치/자연5h ACK·새turn·결과는 미완료다. 상세는 기존 native docs/original-goal-recovery.md와 중앙 resume-20261117/r37-source-result.json. 기존 미지원 inbound listener/stop/UNKNOWN은 유지한다.

2026-11-19 R38/R39: retained shared Child/전용pipe·실Bun/Core/private 기존2PASS 인수. 새 original-issuer-shared-launcher는 exact registry/manifest/self/addon/Core/Bun SHA를 확인하고 단일 child 수명을 보유한다. preflight3PASS·exe build/lib+bin check PASS. 기존 accepted-release builder에 두 native artifact pin/identity/복사검사를 추가했으며 원TUI caller 미완료는 accepted=false다. closure5PASS·기존34PASS. 정식 wrapper/TUI capability caller·완전closure intake·설치·실계정admission·자연quota는 미완료. 현재 운영은 교체하지 않았다. 중앙 execution.sharedLauncherR39 참조.

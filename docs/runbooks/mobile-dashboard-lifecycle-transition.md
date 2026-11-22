# 대시보드 후보의 현 세대 전환

`Prepare-AiccMobilePublicRuntime.ps1 -RuntimeConfig ...`가 만든 후보를 기존
`Install-AiccMobilePublicRuntime.ps1`의 `-ActivateNormallyStoppedLifecycle` 분기로
연결한다. legacy `-ActivateStoppedService`와 계약을 구별하며, 활성 서비스를
이 적용기에서 종료하지 않는다. 복구 실행 연결은 아래 bounded mobile 지원 분기를 사용한다. 기존 계획의
`activationSupported=false`는 수동 변경하지 않는다. probe 성공은 운영 전환이 아니다.

## 기존 종료와 복구 근거

서비스를 중단할 승인이 있고 실제 독립 복구가 준비된 때에만 기존
`Request-AiccMobilePublicStop.ps1`의 generation/PID/startedAt/manifest 결속 요청을
사용한다. 현재 제어 경로를 잃을 수 있는데 복구가 없다면 요청도 보내지 않는다.
이 문서는 기존 승인을 확대하거나 새 worker·계정·경로를 만들지 않는다.

전환은 기존 stop-requests의 request/claim과 status의 `NORMAL_STOPPED` /
`NORMAL_STOP_ACK`, 동일 operation·세대·PID·시작시각, 최근 120초 관측,
idle drain의 활성 요청0·미결0·쓰기 없음·기기 신뢰 보존, 실제 OS 프로세스
퇴장을 함께 요구한다. listener/task/process 조회 오류는 UNKNOWN이며 빈 목록을
대신 넣지 않는다. 같은 PID의 다른 프로세스가 있어도 보수적으로 HOLD한다.
범위는 mobile drain 및 durable mobile journal이며 전역 UNKNOWN=0을 주장하지 않는다.

독립 복구 영수증은 기존 owner backups 아래의 실제 도구 readback과 일치해야 한다.
READY JSON을 수동 생성하거나 이 작업자가 자기 자신에게 발급해서는 안 된다.
기존 Workspace 일회성 복구 진입점의 `-MobilePublicRecovery` 분기가 실제 별도 프로세스 응답을 아래 계약에 결속한다. 실행 권한은 해당 작업 승인 범위에 한정된다.

| 필드 | 결속 대상 |
|---|---|
| schemaVersion/status/independent | 1 / READY / true |
| operationId/planSha256 | 현재 후보 계획 UUID와 SHA-256 |
| target/taskXmlSha256 | 기존 public-control task와 정확한 사전 XML |
| previousConfigSha256/stopOperationId | 원 config와 정상 종료 operation |
| recoveryAction | restore-exact-task-after-normal-stop |
| executorId | 실제 독립 복구 실행 주체 |
| observedAt/expiresAt | 관측 120초 이내, 만료 전이며 5분 이내 |
| toolReceiptFile/toolReceiptSha256 | 실제 도구 응답 파일과 SHA-256; 위 필드 전부 readback 일치 |

적용기는 plan과 준비 config·manifest 전체 파일, 자기 실행기·순수 계약 모듈 해시,
기존 config/manifest, 정확한 기존 VBS 런처, task XML을 검증한다. 기존 HTTPS
origin·Node와 port4383을 보존한다. 원 task가 Ready·인스턴스0이며 listener와
기존 runner/parent가 없는지도 확인한다. mobile journal의 미결은 먼저 조정해야 한다.

## 단회 적용과 결과 불명

실제 근거가 준비된 담당자는 다음 기존 적용기 입력을 채운다. 이 문서 작성이나
합성 fixture의 READY는 실행 승인이 아니다.

```powershell
& tools/platform/windows/Install-AiccMobilePublicRuntime.ps1 `
  -PlanFile $planFile -ExpectedPlanSha256 $planSha256 `
  -ExpectedTaskXmlSha256 $taskXmlSha256 `
  -ActivateNormallyStoppedLifecycle -StopOperationId $stopOperationId `
  -RecoveryReadyFile $actualReadyFile -ExpectedRecoveryReadySha256 $readySha256
```

기존 activation.lock 아래에서 activation-attempt를 독점 생성한다. task XML 원문을
보존하고 새 config·hidden launcher만 설치한다. 두 번째 fresh CAS 뒤 기존 task를
갱신하며 XML readback과 설치된 config/manifest/launcher 해시가 같아야 한 번 시작한다.
시작 접수는 기능 확인이 아니며 `functionalVerification=NOT_RUN`으로 남긴다.

실패하면 `HOLD_NO_AUTOMATIC_REPLAY`와 실패 단계를 보존한다. attempt가 있으면
명령 재실행을 거부한다. task 변경 성공 뒤 readback 실패는 taskUpdated=true,
등록 결과 불명은 해당 시도 단계, 시작 결과 불명은 startAttempted=true로 구별한다.
원 task XML/config/release와 기기 신뢰 원장은 보존하며 자동 rollback하지 않는다.
후보 실행 여부를 조정한 다음 `Restore-AiccMobilePublicRuntime.ps1`로 명시적으로
복구한다. 소스와 합성 검사를 구현했으며 실제 독립 복구 발급 연결·운영 인수는 잔여다.

## 명시적 CAS rollback

복구 입력은 같은 plan SHA, activation-attempt SHA, 현재 task XML SHA,
새 rollbackOperationId, 실제 독립 복구 READY SHA와 `-RestoreStoppedService`다.
실제 시작을 시도한 경우 `-CandidateStopOperationId`도 필요하다. 이 실행기는
정상 종료를 요청하지 않는다. 원본 삭제·config 덮기·기기 신뢰 복원도 하지 않는다.

적용 영수증에 계획·원 task·desired task·원 런처의 SHA가 남아 있어야 한다.
구형 영수증의 누락 필드를 추정해서 채우지 않는다. 현재 task는 원본 또는
desired task와 정확히 같아야 하며 다른 변경은 보존하고 HOLD한다. 원 config,
후보 config, 양쪽 manifest와 선언된 모든 파일, Node와 원 VBS 해시도 확인한다.

startAttempted=false가 명시되고 후보 status가 없을 때만 미시작 복구를 허용한다.
status가 있거나 시작을 시도했다면 listener 부재만으로 미실행이라 판단하지 않는다.
시작 시도가 있으면 후보의 정확한 request/claim/정상 종료 ACK·fresh idle·프로세스
퇴장이 필요하다. UNKNOWN 시작 후 후보 ACK를 얻지 못했으면 별도 조정이 필요하다.

READY/readback은 기존 전환 필드 외 rollbackOperationId와 activationReceiptSha256도
같아야 한다. 미시작은 stopOperationId=NOT_STARTED·previousConfigSha256=원 config,
시작 시도 후에는 후보 종료 operation·후보 config SHA에 결속한다. READY의 task SHA는
복구 직전 task에 결속한다. 수동 JSON이나 합성 READY는 실제 독립 복구 근거가 아니다.

같은 activation.lock 안에서 rollback-attempt.json을 독점 생성하고 두 번 fresh 대조한
뒤 원 task를 복원한다. 이미 원 task면 재등록을 생략한다. readback 후 모든 gate를
다시 검사하고 start 한 번을 기록한다. 등록·시작 불명은 단계별
HOLD_ROLLBACK_NO_AUTOMATIC_REPLAY로 보존한다. 기존 rollback attempt는 재발신하거나
덮지 않는다. start 접수 뒤에도 functionalVerification=NOT_RUN이다.

## 검사 근거와 한계

`Test-AiccMobileLifecycleTransition.ps1`은 순수 계약의 정상·거부 조건을 검사한다.
`Test-AiccMobileLifecycleInstaller.ps1`은 owner 경로·COM/task/process/listener·ACL
경계만 isolated fixture로 대체해 적용기 본문을 실행한다. 실제 Windows scheduler,
ACL 설치와 운영 서비스 전환·실화면 인수는 별도다. fixture는 보존하며 실제 종료 요청,
task 변경, 서비스 기동, 외부 발신을 하지 않는다.
`Test-AiccMobileLifecycleRollback.ps1`은 이 isolated installer의 실제 합성 영수증을
이어 받아 미시작 복구·시작/등록 불명·후보 정상 종료·stale task/config/READY·재호출을
검사한다. fixture의 plan/receipt 재결속은 합성 전용이며 운영 영수증을 수정하지 않는다.

## 4383 전용 일회성 local recovery 연결

기존 `tools/platform/workspace-mcp/Watch-AiccHostRuntimeRecovery.ps1`의
`-MobilePublicRecovery`는 OCX local recovery와 같은 숨김 별도 PowerShell
실행 수단을 사용한다. Workspace 본래의 RDC ancestry 계약은 변경하지 않는다.
새 분기는 정확한 mobile task/PID/부모/config/plan SHA·task XML 원본·nonce·만료를
검증하며 대상 runtime이 worker ancestry에 있으면 거부한다. 공유 HOME·모델·계정·
서비스·예약을 바꾸지 않는다. daemon이나 새 모델 worker를 등록하지 않는다.

`Install-AiccMobilePublicRecovery.ps1` preview의 SHA를 `-Apply
-ExpectedPreviewSha256`에 한 번 전달한다. recovery tool 파일을 owner-local 불변
해시 release로 설치하고 기존 current registry는 사전 원본·lock·CAS로 교체한다.
이 설치는 dashboard 후보나 task를 바꾸지 않는다. 실행은 등록 release 안의
`Request-AiccMobilePublicRecovery.ps1 -Action StartProbe -PlanFile ...
-ExpectedPlanSha256 ...`를 사용한다. 출력 requestFile/requestSha256로 이후
`-Action Signal -Signal close -Sequence 2`를 보내 정상 해제할 수 있다.

실제 worker-started PID/생성시각·ancestry와 nonce/requestSHA에 묶인 response를
회수한다. probe는 task/config 읽기만 수행하고 `PROBE_RESPONSE`/mutationCount=0을
반환한다. probe를 READY로 이름만 바꾸지 않는다. 만료나 close는 자동 rollback,
강제 종료, 원 요청 재생을 하지 않는다. 각 command 번호는 CreateNew claim으로
한 번 소비하며 원 불명 command를 다시 만들지 않는다.

arm은 기존 설치기의 **실제 살아 있는** `installer-preflight.json`과 같은
plan/PID를 요구한다. 전체 파일을 잠근 설치기가 fresh commit을 기다린 다음,
별도 worker의 `-Signal arm -ExpectedTaskXmlSha256 ...` 응답에서 readyFile/hash를
받는다. 그 후에만 승인된 정상 stop을 요청한다. 기존 installer는 READY와
실제 toolReceipt SHA, 120초 stop ACK/owner/generation/CAS를 계속 검증한다.
지원 branch의 응답이 없으면 중단하지 않는다.

명시 `restore`는 activation receipt SHA·현재 task SHA·rollbackOperationId와
(시작 시도 뒤라면) candidateStopOperationId를 받는다. 전체 검증을 마치고 잠금을
유지한 정확한 Restore PID/생성시각/실행파일/명령 해시를 다시 확인하고, 새
READY/toolReceipt에 결속한 CreateNew commit을 그 프로세스에 한 번 전달한다.
결과는 `FRESH_RESTORE_COMMIT_SUBMITTED_OUTCOME_UNOBSERVED`이며 실제 rollback
receipt와 프로세스 퇴장을 따로 회수한다. 접수를 복구 완료로 표시하지 않는다.
기존 task/config/manifest/정상종료/한번 start 계약과 UNKNOWN 보존은 유지한다.
자동 타이머 rollback은 없다.

운영 설치기의 파일 전체 잠금·해시 검증은 후보 조립 때의 과거 검사를 캐시로
대체할 수 없다. 전체 재검사 금지 단위에서는 arm/preflight를 조작해 만들지 말고,
복구 연결 설치·실제 무변경 응답까지만 인수한다. 운영 전환은 그 필수 검증을
포함하도록 배정된 단위에서 이어간다. 이 계약을 완화해 PASS로 만들지 않는다.
### 실제 검증에서 발견한 복구 freshness 결함과 수리

정식 installer의 필수 검증 6892개가 845초 걸린 운영 전 검증에서 실제
preflight와 독립 arm/READY까지 확인했다. 이는 stop/commit/운영 적용이 아니다.
기존 Restore의 `CheckStopped`는 `CheckRelease previous/candidate` 전체 검증을
먼저 실행한 뒤 READY 관측 120초·만료를 검사하며 동일 검증을 세 번 호출한다.
큰 release에서는 READY가 실제 복구 전에 만료될 수 있었다. 이 과거 arm 응답은
실서비스 stop이나 복구 가능성의 근거로 재사용하지 않는다.

해결은 유효시간을 늘리거나 파일 검증을 생략하는 것이 아니다. 원본/후보 검증과
TOCTOU 잠금을 먼저 유지하고, 그 뒤 실제 독립 실행 응답·fresh stop/owner/generation/
receipt/task CAS를 받아 mutation 직전에 확인하는 구조가 필요하다. 변경 관련
장시간 합성 시간·검증 뒤 변조·stale ACK/READY 거부 회귀를 인수한 후 적용한다.
이미 생성된 installer-preflight와 닫힌 recovery 요청/claim은 원근거로 보존한다.
같은 파일을 덮거나 성공으로 고쳐 다음 실행을 통과시키지 않는다.

2026-11-04 수리된 Restore는 `-AwaitRecoveryCommit -RecoveryCommitFile ...`로
정식 설치본을 먼저 실행한다. 이 프로세스는 원본과 준비된 후보의 전체 manifest,
파일 크기·SHA·실제 파일 집합·Node pin을 검증하고 Windows deny-write/delete 파일
핸들과 부모 디렉터리 핸들을 유지한다. 서비스는 계속 실행한다. 실제
`recovery-preflight.json`이 생긴 뒤에만 별도 Request worker를 시작한다. arm은
설치기 preflight뿐 아니라 이 복구 preflight의 살아 있는 정확한 신원/hash도
요구한다. 요청·응답은 원문 시각 문자열을 보존하며 완전 기록 후 atomic rename으로
공개한다. 부분 JSON을 READY로 소비하지 않는다.

복구 commit 후에는 전체 파일 해시를 재반복하지 않고 잠금이 유지된 검증 결과와
실제 파일 집합, 새 activation receipt/task/config/launcher/정상stop/실제exit 및
기존 120초 READY/ACK를 mutation 직전에 확인한다. 파일 추가는 집합 검사로
거부하고 검증한 기존 파일의 쓰기·삭제·부모 교체는 열린 OS 핸들이 막는다.
유효시간은 늘리지 않는다. 검증 대기 시간은 READY 유효시간이 아니다.

이미 봉인된 후보의 복구 실행기 pin만 바뀌면 설치된
`Update-AiccMobileRecoveryPlan.ps1`의 preview SHA→Apply 계약을 사용한다.
원본 plan/hash·후보·준비 config·기존 모듈 의미·설치 registry·기존 attempt 부재와
이전 verifier 퇴장을 확인하고, 새 operation 폴더에 plan 원본과 config를 보관한
개정 계획을 만든다. 후보/manifest/operationId/미래 generation은 바꾸지 않는다.
기존 preflight와 실패/UNKNOWN attempt는 덮거나 옮기지 않는다. 실행 중인 이전
verifier 또는 기존 activation/rollback attempt가 있으면 개정하지 않는다.

`Test-AiccMobileRecoveryValidity.ps1`은 실제 Restore 함수로 가짜 clock 845초,
fresh/expired READY, 다른 plan/task/rollback, 실제 Windows 파일 잠금과 변조·추가
거부를 검사한다. 실제 운영 전환과 물리폰 검증은 별도 기록이다.

이 단위의 실제 전환 시도에서는 원본 supervisor가 정상 stop을 claim했지만
runner ACK는 나오지 않았다. 기존 `Request-AiccMobilePublicStop`의 JSON 날짜
자동 변환이 `startedAt`의 `.410Z`를 `.41Z`로 바꾸고 supervisor도 이를 다시
직렬화한다. runner의 정확 문자열 비교가 이를 거부했다. 운영 원 request/claim은
보존하고 같은 stop을 재발신하지 않는다. source뿐 아니라 현재 실행 중인 기존
supervisor의 지원되는 갱신/정상 종료 경계를 해결해야 하며, immutable release
편집이나 강제 종료로 우회하지 않는다. 따라서 복구 도구 설치/READY 수리 완료와
운영 전환 HOLD를 분리한다. 실제 관측 파일은 owner-local G3 recovery-validity
result 및 `.git/g3-dashboard-20261104/recovery-validity/stop-reconciliation.json`이다.

### 2026-11-06 G3 JSON 날짜 문자열 소스 수리 (운영 미적용)

`Request-AiccMobilePublicStop.ps1`의 config/status 및
`Start-AiccMobilePublicRuntime.ps1`의 config/manifest/request JSON 읽기 5곳에
PowerShell 7.5 `ConvertFrom-Json -AsHashtable -DateKind String`을 적용했다.
`.410Z`와 `.41Z`, UTC offset의 원문 `startedAt`/`expectedStartedAt`을 보존하고
TTL 판정은 별도 `DateTimeOffset.Parse`로 유지한다. generation/PID/manifest/nonce,
CreateNew claim, 단회 요청·ACK·process-exit 확인과 runner의 정확 문자열 거부는 그대로다.

실제 좁은 합성 회귀검사 `Test-AiccMobileStopJsonDates.ps1`은 71개 PASS(exit 0),
기존 `Test-AiccMobileLifecycleTransition.ps1`은 22개 PASS(exit 0)다.
임시 fixture는 제거했고 운영 stop request·claim·서비스 시작은 실행하지 않았다.

이 변경은 **소스만 수리**한 것이다. 실행 중인 **기존 운영 supervisor에는 미채택**이며
설치·재시작·운영 전환·실제 ACK/프로세스 퇴장을 확인하지 않았다. 원 operation
`00000000-0000-4000-8000-000000000000`의 결과는 UNKNOWN, 기존 request/claim
보존, 재발신 0이다. 지원되는 기존 supervisor 정상 교체/종료와 독립 복구·fresh gate
근거가 마련되기 전에는 운영 전환 HOLD를 유지한다.

### 요청별 정상 종료 결과 보존 · 2026-11-16 (운영 미적용)

`mobile-public-runner.mjs`는 각 기존 `stop-requests/<operation>/`에
create-once `result.json`을 쓴다. 실제 전달 입력과 원 request 원바이트 SHA,
claim, runtime/PID/시작 시각/manifest를 대조하고 controlNonce는 저장하지 않는다.
후속 요청이 status의 마지막 결과를 덮어도 앞선 WORK_PRESERVED와 정상 ACK가
사라지지 않는다. 원 claim이나 결과 파일을 덮거나 UNKNOWN을 완료로 바꾸지 않는다.

`Request-AiccMobilePublicStop.ps1`의 기존 pending gate는 정확한 원 request와
claim·현재 세대에 결속된 결과만 읽는다. 잘못된 PID/시각/manifest/요청 SHA/claim,
UNKNOWN은 계속 HOLD한다. result 저장 실패는 UNKNOWN이며 새 요청으로 재전송하지
않는다. 과거 결과는 pending 조회용이고 운영 교체의 fresh 정상 ACK·실제 process
exit·독립 복구 조건을 대신하지 않는다. 기존 운영본에는 이 기능이 없어 원 미결을
새 코드로 소급 정산하지 않는다.

격리 실제 runner에서 두 거절 뒤 정상 종료·세 결과 보존·같은 입력 중복 미실행을
검증했다. pending 22, 날짜 75, 전환 22, 후보 및 runner 7, 설치 호환 11 검사 PASS다.
최초 날짜 검사 실패는 새 result/claim JSON 읽기 두 곳이 추가되어 발생했고,
읽기 개수와 모든 `-DateKind String`을 검토해 검사 기준을 갱신했다.
이는 source와 격리 실행 근거이며 운영 설치/기존 정상 종료/폰 설치는 별도다.

후속 조회 수리: 같은 helper의 단회 조회도 공통 `Read-ExactStopResult`로
원 request·claim과 결과를 대조한다. status의 lastOperationId가 바뀌어도 정확한
과거 거절은 `EXACT_OPERATION_RECEIPT`로 반환한다. 과거 ACK가 현재 status와 다르면
`HISTORICAL_ACK_CURRENT_STATUS_UNCONFIRMED`로 구분하며 `transitionReady=false`다.
변조·다른 claim은 `RESULT_BINDING_UNKNOWN`, 결과 없는 기존 요청은 UNCONFIRMED로
보존한다. 현재 status의 정상 ACK와 실제 process exit를 함께 증명해야 교체가 가능하다.
운영 조회는 기존 요청을 재전송하지 않으며 새 결과 파일을 소급 생성하지 않는다.

현재 status를 사용하는 구세대 조회도 원 request의 PID·시작 시각 원문·manifest와
create-once claim의 request SHA·operation·runtime·PID를 함께 대조한다.
`lastOperationId`와 `NORMAL_STOP_ACK`라는 상태 표지만으로 정산하거나 교체를
허용하지 않는다. result.json이 없는 정상 구세대 응답은 이 결속을 통과해야
`CURRENT_STATUS`가 되며, 불일치/claim 누락은 UNKNOWN으로 보존한다.
이 조회 수리는 구세대 프로세스를 갱신하거나 과거 UNKNOWN을 해제하지 않는다.

### 새 stop 요청 전 설치본 호환성 확인

`Request-AiccMobilePublicStop.ps1`은 현재 config가 고정한 설치 manifest와
supervisor SHA를 대조한 뒤, 실제 설치 supervisor의 모든 JSON 읽기가
`-DateKind String`을 사용하는지 AST로 검사한다. 소스 트리의 수정 여부로
실행 중 구세대가 고쳐졌다고 판단하지 않는다. 미지원 또는 설치 신원 불명일 때
새 `-Submit`은 요청 파일 생성 전에 거절한다. 기존 operation의 조회와 원
request/claim 보존은 계속 가능하며, 결과에 `stopSubmissionSupported`와
`stopHoldReason`을 표시한다. 정상 ACK·실제 프로세스 퇴장 조건은 그대로다.

근접 검사는 `Test-AiccMobileStopReadiness.ps1`과 기존
`Test-AiccMobileStopJsonDates.ps1`이다. 이 사전 검사는 실행 중인 구세대를
중지하거나 새 버전으로 교체하지 않는다. 구세대가 지원하는 정상 종료 수단을
확보하거나 종료 이후의 정식 복구 절차를 구현해야 운영 교체를 진행할 수 있다.

### 2026-11-07 G3 정상 종료 지원 상태의 읽기 전용 화면 연결

기존 인증된 `GET /api/mobile/management`와 `GET /api/mobile/dashboard`에 `mobilePublic`의 제한된 상태만 추가한다. `src/management-overview.mjs`는 현재 운영 config/status에서 실행 중으로 **기록된** 세대를 정확히 하나 선택한 다음, manifest와 설치된 supervisor SHA를 확인하고 기존 `Request-AiccMobilePublicStop.ps1`을 **`-Submit` 없이** 읽기 전용으로 호출한다. 날짜 처리 지원이 확인된 설치본에만 `stopSubmissionSupported=true`를 반환하며, 해시 변경·세대 모호함·조회 실패는 UNKNOWN이다. PID·파일 경로·nonce/token·원 stop 요청 및 원 응답 본문을 웹으로 보내지 않는다. 상태의 `LISTENING`은 기록이며 실제 OS 생존 확인으로 확대하지 않는다.

`public/ai-cowork.js`의 한국어 안내를 관리기와 `public/dashboard-workspace.js` 에이전트 보고 화면이 함께 재사용한다. 실행 중 기록, 새 소스 준비/설치본 차이, 운영 적용·정상 종료/복구 가능 여부를 구분한다. 설치/종료 버튼은 읽기 전용으로 비활성화하고, 사유는 항상 보이고 키보드·화면 읽기에서 접근 가능하다. 기존 로그인·기기 신뢰·미리보기·일회 확인·재전송 방지 기능은 변경하지 않았다.

2026-11-07 기존 로컬의 `-Submit` 없는 실제 조회에서는 `LISTENING` / `INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED` / `stopSubmissionSupported=false` / `submittedThisCall=false`를 관측했다. 원 `00000000-0000-4000-8000-000000000000`의 UNKNOWN은 보존한다. source-only 결과는 `backups/g3-stop-support-ui-20261107/result.json`에 기록한다. 운영 4383, supervisor, task, registry, 서비스는 교체하지 않았다. 실제 구세대 종료/독립 복구·전환은 여전히 HOLD다.

### 2026-11-07 구세대 owner lifecycle exit / cold replacement 검토

**판정: `G3_LEGACY_COLD_REPLACEMENT_UNSUPPORTED_HOLD`.** 현재 운영 종료나 교체를 승인·실행하는 절차가 아니다. `NORMAL_STOP_ACK` 없이 `ActivateNormallyStoppedLifecycle`/`AwaitLifecycleCommit`을 호출하지 않으며 `ActivateStoppedService`를 lifecycle 우회로 쓰지 않는다.

### 2026-11-17 현재 세대 한정 legacy 정상종료 compatibility

`Request-AiccMobilePublicStop.ps1`의 일반 AST 판정은 그대로 유지한다. 추가된
`MobilePublicStopCompatibility.psm1`은 검토한 manifest·supervisor·runner SHA 조합
하나에만 적용한다. 다른 소스, 임의 스니펫 또는 caller의 지원 선언은 인정하지 않는다.
현재 runner/부모 supervisor의 OS PID·부모 관계·실행 파일·정확한 명령 인수·생성시각,
config/manifest/Node 핀을 확인하고 실제 부모의 PowerShell 실행 파일로 고정된
읽기 전용 serializer probe를 실행한다. 서비스 스크립트 실행이나 stdin 제어는 하지 않는다.

현재 설치 supervisor의 기본 `ConvertFrom-Json -AsHashtable` 뒤 `ConvertTo-Json`에서
`.975Z`와 `.156Z`는 정확하게 왕복하지만 `.410Z`는 `.41Z`, `.000Z`는 정수초로 바뀐다.
runner의 `expectedStartedAt === status.startedAt` 검사는 바꾸지 않는다. 정확히 왕복한
현재 `LISTENING` 세대만 `EXACT_LEGACY_GENERATION_LOSSLESS`로 지원하며, 끝자리 0,
generation/source/config 변동, 프로세스 조회 오류는 HOLD한다. 조회 뒤와 새 요청의
submission lock 안에서도 실제 세대·파일 핀을 다시 확인한다.

과거 request/claim은 수정·재송·정산하지 않는다. 원 request SHA에 결속된 정확한
claim이 존재하고 이전 PID가 현재 OS에 없으며, request 만료가 현재 runner의 실제
생성보다 이전인 경우에만 `historicalUnknownStopRequests`로 구분한다. 과거 결과는
계속 UNKNOWN이며 ACK/완료/READY로 승격하지 않는다. claim 누락·변조·잘못된 시각,
이전 PID 생존/조회 불명, 현재 세대 미결은 계속 차단한다. result가 있는 다른 세대는
별도 원요청 조정 대상으로 HOLD한다. 기존 operation 조회는 계속 UNCONFIRMED다.

이는 정상종료 요청의 지원 여부에 관한 소스 수리다. 실제 stop, Task 변경, start,
설치·전환·복구 READY는 실행하지 않았다. 실제 전환에는 원 세대의 정상 drain ACK,
exact request/claim, 실제 퇴장 및 기존 fresh 독립 복구·CAS 검증이 여전히 필요하다.
전용 `Test-AiccMobileLegacyStopCompatibility.ps1`은 날짜 손실·잘못된 세대·변조·현재
UNKNOWN 차단을 모의 검증한다. 후보 준비기는 새 compatibility 모듈을 함께 포함한다.

#### 기존 계약에서 확인한 불가능한 경계

- `Start-AiccMobilePublicRuntime.ps1`은 Node child의 `WaitForExit`와 stdin의 `drain-and-stop`만 처리한다. 정확한 Windows logoff/shutdown, boot/logon identity, 종료 직전 idle 증거를 봉인하는 경로가 없다. `mobile-public-runner.mjs`의 `NORMAL_STOP_ACK`는 허용된 drain 뒤 `server.close`가 성공해야만 생성된다. OS 프로세스 퇴장은 이 ACK가 아니다.
- `Request-AiccMobilePublicStop.ps1`은 설치 supervisor의 날짜 문자열 지원을 확인하지 못하면 새 `-Submit`을 거절한다. 원 operation `00000000-0000-4000-8000-000000000000`은 request/claim 후 ACK 없는 **역사적 UNKNOWN**이다. 원 request/claim 수정·재생·완료 승격·ACK 합성을 금지한다.
- `MobilePublicTransition.psm1`/`Install-AiccMobilePublicRuntime.ps1`은 같은 세대 request/claim, 최근 `NORMAL_STOP_ACK`, idle drain, 실제 exit, 신선한 독립 READY, Task/config/manifest CAS를 함께 요구한다. `Restore-AiccMobilePublicRuntime.ps1`은 실제 activation receipt가 있는 경우의 명시적 rollback 전용이다.
- `Request-AiccMobilePublicRecovery.ps1 -Action StartProbe` 역시 현재 `LISTENING` 런타임 PID와 정확한 task 소유자를 요구한다. 구세대의 OS 종료 이후 exit 증거 발급기로 재사용할 수 없다.
- 재부팅/로그오프, 이전 PID가 조회되지 않음, listener 4383 부재, task `Ready`는 종료 **직전** 활성 요청·미결 결과·쓰기 0을 증명하지 않는다. 구세대의 상태 `LISTENING`은 idle snapshot이 아니며 현재 구현에는 원자적인 외부 quiesce(새 접수 차단 + drain 완료) 증명 채널이 없다. Task의 로그인 자동 시작으로 이전 세대가 재기동할 수도 있다.

#### 새 owner lifecycle cold 교체 계약에 반드시 필요한 증거 (전부 충족 전 HOLD)

1. 기존 Task XML/launcher/config/manifest 정확 SHA 및 runner PID + OS 실제 프로세스 생성시각 + status의 `startedAt` 원문, 사용자/session과 boot 또는 logon identity를 같은 세대로 묶고 위조·PID 재사용·시각 불일치를 거부한다.
2. task·runtime과 독립적인 신뢰할 수 있는 관찰자가 실제 사용자 OS 로그오프/종료와 **이전 세대** worker·supervisor exit 시점을 확인하고, 출처·시각·신원을 변경 불가능한 증거로 남긴다. 현재 제품에는 그 발급/검증 계약이 없다. 새 boot 표식만으로 충족하지 않는다.
3. 종료 직전부터 실제 exit까지 신규 접수와 쓰기를 차단한 상태에서 active=0, pending=0, mutationBusy=false, durable mobile journal 미결 0, 기기 신뢰 보존을 경쟁 조건 없이 증명한다. 현재 구세대는 이 gate를 만들 수 없으며 읽기 전용 조회 또는 종료 후 빈 큐로 대체할 수 없다.
4. 이전 runner/parent/task instance의 실제 퇴장, listener 4383=0, 성공한 OS 조회, 변경되지 않은 Task/config/manifest/런처 SHA 및 CAS를 모두 검사한다. 대상 조회 실패·unknown 프로세스·새 세대 재시작은 거절한다.
5. 기존/후보 release 잠금과 전체 pin, 정확 Task/config CAS, 실제 독립 복구 도구 원응답 SHA와 fresh READY(기존 120초/만료 규칙), 1회 activation receipt·복구 경계를 검증한다. 손으로 만든 READY나 오래된 READY는 거절한다.
6. 원 stop UNKNOWN과 다른 mobile 미결은 각자 정본에 별도로 보존한다. owner lifecycle exit 근거를 원 ACK/COMPLETED로 승격하지 않으며, G1 continuation 원 큐 같은 무관한 미결을 OS 변경 하나로 조정하지 않는다.

현재는 항목 2와 3의 **원본 증거를 제공하는 기존 OS/lifecycle 계약이 없다**. 따라서 부팅 시각만 확인하는 신규 분기를 만들면 안전 조건이 약해진다. 새 installer/rollback 분기, 출처 증명, 종료 전 quiescence 확보가 없는 상태에서는 구현 억지 0이며 운영 적용 `HOLD`다. 합성 fixture PASS도 실제 종료나 정상 ACK의 증거가 아니다.

#### 최소 사용자 종료·복구 경계 (이번 작업에서 실행 0)

1. 현재 4383 supervisor/runner, Task, 설치 registry, config, manifest, 복구 상태와 원 request/claim을 변경하지 않는다. 구세대에 새 정상 stop을 발신하거나 stdin 직접 조작, Task 중지/disable, 프로세스 강제 종료, 재시작·로그오프를 실행하지 않는다.
2. 소유자가 **별도 사유로** Windows 로그오프/종료를 자연스럽게 선택한다면 그 전에 미완료 작업 보호 상태와 Task/config/manifest/PID·시작시각/OS session·boot 관측을 별도 보존한다. 이 snapshot만으로 신규 교체를 승인하지 않으며, 이 절을 이유로 운영체제 종료를 요청하지 않는다.
3. 다음 로그인에서 승인된 owner 읽기 전용 경로로 Task XML, 현재 config·manifest·런처, 옛 PID와 실제 생성시각, 자동 시작한 새 세대의 유무, Task instance, listener, durable journal과 활성·미결·쓰기, 복구 READY를 각각 확인한다. 하나라도 살아 있거나 UNKNOWN/불일치이면 HOLD, 원 전송 재발신 0이다.
4. 모두 종료로 보이더라도 독립 lifecycle exit와 종료 직전 quiescence 증명이 없으면 정식 installer를 호출하지 않는다. activation attempt 자체가 없으면 rollback할 것도 없다. 향후 정식 시도가 생긴 때에만 해당 receipt·Task/config CAS·후보 정상종료·독립 fresh READY를 확인하고 `Restore-AiccMobilePublicRuntime.ps1`의 명시적 rollback을 사용한다. 자동 rollback·강제 종료는 하지 않는다.

### 2026-11-17 실제 운영 전환

첫 전환은 정상 ACK와 원 runner/부모 퇴장 뒤 수동 단계 사이 READY 만료로 적용 전 거절됐다. 실패 commit/stop/claim을 보존하고, 별도 복구 worker의 StoppedOriginal probe, arm-original, restore-original로 변경되지 않은 원 Task를 단회 시작해 실제 LISTENING과 HTTP 200을 확인했다. 이 복구 분기는 exact request/claim/SHA/ACK, config/task/launcher, process/listener/instance 부재, candidate config/activation attempt 부재와 mobile journal을 검증한다.

설치기는 열린 deny-write/delete 파일 핸들과 검증된 상위 디렉터리 핸들이 유지된 exact 경로만 재사용한다. 새 경로/파일 집합/SHA 검증과 기존 READY/ACK 120초 조건은 유지한다. Invoke-AiccMobileLifecycleTransition.ps1은 실제 probe/preview/arm/새 stop 단회/runner와 부모 퇴장/fresh commit을 연속 처리하며 기존 commit/attempt가 있으면 재실행하지 않는다. installer 6개와 handoff 6개 검사가 통과했다.

새 불변 후보에서 원본/후보 13763개 및 후보 6897개 파일의 실제 잠금 preflight를 소비했고, 정상 ACK/퇴장 뒤 CAS Task 갱신과 단회 활성화를 확인했다. 수리된 installer 전체 검증은 약70초였다. 새 운영 manifest/config, HTTP200, 인증 전409/인증 후200, 등록 Codex 관측과 실제 Chrome 320/768/1280 화면을 확인했다. 외부 HTTPS PWA 자원과 범위밖403, 원 UNKNOWN 바이트/기기신뢰/비대상 OCX 및17841 프로세스를 보존했다. 폰 실기기 설치는 미확인이다. WebGPT 이름/exact conversation URL 구분은 현재 source API에 없고 별도 source owner 구현이 필요하다. 개인 해시와 영수증은 owner-local g3-operational-transition-result.json에 둔다.

### 2026-11-18 조회 복구 수리본 운영 인수

같은 Task를 이름/객체 export로 읽으면 기본값·SID 직렬화가 달라 동일 정의의 SHA가 달라질 수 있다. 준비 caller·installer·transition은 모두 InputObject export를 사용한다. installer는 READY 전 핀을 검증해 preflight에 보존하고 transition도 stop 전에 같은 핀을 확인한다. 조기거절·정상후보 격리2검사는 재사용했다.

새 후보는 원본/후보 13,798개·후보 6,899개 실제 잠금, 독립 PROBE/READY, 원세대 정상 ACK와 runner/부모 퇴장, fresh Task/config CAS 뒤 단회 시작·새세대 LISTENING까지 확인했다. 설치 자원 및 외부 HTTPS SHA 일치, 인증 API200/기존revision, 운영 Chrome에서 요청실패·20초 시간초과·목록보존·대기해제·수동복구 PASS. 이전 실패 operation·UNKNOWN은 보존하며 재송하지 않았다. 복구 worker는 원 계약대로 만료했고 미사용 복구 대기 verifier는 exact executable/생성시각/명령 SHA와 commit 부재를 확인해 종료했다. 운영 runner를 종료한 것이 아니다. 폰 최종화면은 당시 기기0으로 미실행이다.

### 2026-11-19 실행기 경로 불일치의 종료 전 차단

기존 Task의 VBS가 Codex 번들 PowerShell을 가리키는데 설치기·복구기를 별도 관리형 PowerShell로 실행하면 정확 런처 검사에서 거절된다. 런처 검사가 stop 뒤에만 있던 실제 전환에서 정상 ACK 이후 설치가 중단됐다. 해당 실패 operation과 commit은 보존하며 재실행하지 않는다.

설치기의 deferred preflight는 Task XML뿐 아니라 기존 VBS의 정확한 명령 전문과 현재 실행기의 경로를 stop 전에 대조하고, 확인한 VBS 파일을 잠근 채 유지한다. 경로가 다르면 READY를 만들지 않으므로 coordinator는 stop을 요청할 수 없다. 최종 stop/ACK/CAS에서도 기존 검사를 유지한다. 실행기는 원 Task VBS가 지정한 정확한 PowerShell을 사용하며 검사를 완화하지 않는다.

이번 실제 복구는 설치된 bounded recovery의 StoppedOriginal probe → arm-original → restore-original 계약으로 변경되지 않은 원 Task를 단회 시작했다. 기존 runtime의 LISTENING과 실제 인증 session/dashboard HTTP200을 확인했으며 기기 신뢰·원UNKNOWN·원요청을 변경하지 않았다. 불일치 반례는 READY 도달로 1 FAIL, 조기검사 수정 후 관련10 PASS. 새 후보의 정식 적용·폰 화면 확인은 이 소스 수리와 별도로 인수한다.

### 2026-11-22 전환 전 프로세스 조회 확인

일반 사용자 토큰의 설치기가 정상 종료 뒤 `relevant_process_ownership_unknown`을 반환했다. Windows 서비스 세션의 `node.exe`·`pwsh.exe` 일부에서 명령줄이 비어 있었고, 기존 복구도 `original_process_inventory_unknown`을 반환했다. 이 전환은 예약 작업·설정·후보 시작 전에 멈췄다. 같은 Windows 사용자로 UAC 승격해 기존 독립 복구의 StoppedOriginal probe → arm-original → restore-original을 실행하니 원 예약 작업이 단회 시작됐고 HTTP `/healthz`가 다시 응답했다.

새 전환은 정확한 기존 PowerShell과 동일 Windows 사용자를 확인한 다음 진행한다. 정상 종료 전에 공식 설치기와 같은 `Win32_Process` 조회에서 `node.exe`, `pwsh.exe`, `powershell.exe`, `wscript.exe`, `cscript.exe`의 명령줄을 읽을 수 있는지 확인한다. 일반 토큰에서 비어 있으면 필요한 관리자 승인을 먼저 받아 동일 실행 파일로 확인한다. 미확인 프로세스가 남으면 종료를 요청하지 않는다. 실패한 전환의 기록과 원 ACK는 보존한다. 다시 적용할 때는 살아 있는 원 세대에 별도의 새 후보 계획·복구·정상 종료를 결속한다.

모바일 화면과 설치 안내를 함께 바꿀 때는 격리 후보에서 원격 Host로 `/install.js`가
정적 서버에 전달되는지 검사한다. 로컬 Chrome에서 링크가 열려도 원격 경로 허용 목록이
빠져 있으면 기존 HTTPS에서는 `403 mobile_scope_only`가 발생한다. 공개 경로는 필요한
파일 하나로 한정하고 `/install.js/private`와 미인증 `/api/mobile/apps`의 거절을 확인한다.
운영 교체 뒤 기존 HTTPS에서 모듈·APK·버전 파일의 해시와 HTML 표시를 다시 대조한다.

# AICC 연결점

PC와 폰은 같은 화면을 사용한다. PC는 owner loopback 세션으로 열고 폰만 PC 발급 링크로 인증한다. 기본 localUrl과 실제 공개 제어 서버 주소가 일치해야 하며, 별도 private 주소는 보존한다. 큐 변경 완료 영수증을 받은 뒤 목록을 갱신해 등록·켜짐을 표시하고 사용자 선택은 유지한다. 시각이 없는 한도 회복을 1970년으로 표시하지 않는다.

AICC에서 이 방식을 확장할 때만 사용한다. 현재 경로·후보·HOLD는 정본 context/PROJECT.md에서 읽는다. 아래는 구현 탐색 위치이며 현재 배포·작동 증거를 대신하지 않는다.

- src/mobile-control.mjs: 폰과 PC의 제어 API, 로컬 소유자 발급, 세션, 미리보기와 확인 처리.
- src/mobile-device-trust.mjs: 기기 토큰 해시, 기기 이름과 지속 철회 기록. 원본 인증 비밀은 공유하지 않는다.
- public/mobile.html, public/mobile.js: 반응형 제어 화면과 기기 관리.
- src/server.mjs: 기존 서버의 모바일 경로 연결. 웹 화면을 추가한다고 별도 background scheduler를 중복 가동하지 않는다.
- tools/platform/aicc: 기존 트레이·Desktop helper·기동 경로. 현재 등록 helper의 protocolVersion과 SHA를 기준으로 재사용한다.
- guidance/skills/use-cloudflare/SKILL.md: 기존 인증을 사용하는 고정 HTTPS·Tunnel 작업. 새 공개 hostname은 현재 승인 범위가 필요하다.
- guidance/skills/present-agent-terminal-status/SKILL.md: 창 없는 백그라운드 실행과 사용자 터미널 보존.

트레이의 정확한 선택 대화와 기존 claim/ACK/Observe 기록을 폰에서 같은 API로 다룬다. Windows Desktop 전달 수단이 HOLD인 경우 한도 회복이나 폰 연결 성공을 전달 수단 복구로 확대하지 않는다. OCX 실행 경로와 Native 경로는 별도로 판단한다.

현재 사용자에게 폰 제어 화면이 보인다는 응답은 화면 표시의 사용자 관측이다. 기기 영구 유지, 재부팅 복구, 모든 제어 동작이나 선택 대화 자동 재개를 모두 확인했다는 증거로 넓히지 않는다.

## Desktop 전달 수단과 실행 주체

- 로컬 터미널·트레이의 승인된 단회 메시지는 공식 `codex queue`로 기존 Desktop 대화에 접수할 수 있다. Desktop 종료나 writer lease 해제는 이 경로의 선행 조건이 아니다. [queue 사용법과 영수증 계약](codex-queue.md)을 따른다. 이 기능의 지원 여부는 설치 helper의 `queueMessageSupported`로 구분한다. 과거 `exec resume` 실패를 모든 터미널 전송 실패로 일반화하지 않는다.

- 승인된 외부 에이전트가 현재 제공된 공식 send_message_to_thread로 exact 기존 대화에 보내고 wait_threads/read_thread로 새 turn을 관측하는 경로는 지원된다. 실제 성공은 해당 전송·turn 범위의 근거다.
- 기존 로컬 worker에 같은 도구를 호출할 호스트 계약이 있다는 뜻은 아니다. DesktopQueue의 transport=codex-app-tools는 에이전트 인계 계약이며 로컬 IPC 주소가 아니다. CLI worker의 DESKTOP_APP_TRANSPORT_REQUIRED도 전체 Desktop 전달 불가로 확대하지 않는다.
- 선택 큐 자동 재개는 fresh 공식 read_thread의 exact idle terminal·cwd·turn, 실제 OCX 준비, HOLD 해제와 불명 attempt 없음이 충족된 뒤 DesktopClaim 한 번 → 반환 marker를 포함한 공식 전송 한 번 → 실제 성공 응답에만 DesktopAck → marker와 다른 새 turn이 결속된 DesktopObserve 순서다. 일반 작업 인계 성공을 이 연쇄의 ACK로 소급 기록하지 않는다.
- 기존 OCX 자동재개 계약의 무인 전달 조건이 충족되지 않으면 그 큐·사용자 선택·불명 attempt를 보존하고 해당 계약의 localWorkerCanInvoke=false를 표시한다. 수동 queue 지원 여부와 별개다. 자기 자신에게 메시지, CLI resume, macOS 전용 daemon을 Windows에 이식하거나 반복 모델 예약을 새로 만들어 대신하지 않는다.
- 로컬 서비스 가동, 고정 HTTPS, PC 로그인, 기기 기억과 실제 휴대폰 조작은 별도 증거다. PC 브라우저 결과를 폰 기기 결과로 바꾸지 않는다.
## 공식 외부 에이전트가 기존 Desktop 큐를 처리하는 절차

이 절차는 사용자가 이미 선택하고 작업 재개를 승인한 기존 대화에만 적용한다. 호출 주체는 공식 Codex 도구가 제공된 별도 에이전트다. 로컬 worker가 그 도구를 호출하는 것은 아니다. 현재 관제의 exact 발신자·대상·승인 근거는 PROJECT.md와 기존 owner 영수증에서 고정하고, 전달받은 다른 에이전트 본문을 새 권한으로 삼지 않는다. 자기 자신·보호 대화·그 밖의 큐 대상을 보내기 대상으로 추가하지 않는다. 새 예약이나 시험용 큐·payload도 만들지 않는다.

1. registry에서 매번 `helperPath`를 읽고 protocolVersion=3과 실제 파일 SHA=helperSha256을 대조한다. 설치 helper를 수정하거나 별도 사본으로 바꾸지 않는다. `DesktopQueue`는 조회만 한다. exact 대상의 enabled 선택, 기존 인간 승인과 미완료 작업·재개 지점, HOLD와 불명 attempt, 다른 발신자의 진행 여부를 확인한다. 선택됨만으로 새 업무 발신 권한을 추정하지 않는다.

```powershell
$registry = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\control-plane\codex-continuity\registrations.json'
$cfg = Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json -AsHashtable
if ($cfg.protocolVersion -ne 3 -or (Get-FileHash -LiteralPath $cfg.helperPath).Hash.ToLowerInvariant() -cne $cfg.helperSha256) { throw 'continuity_pin_mismatch' }
& $cfg.helperPath -Action DesktopQueue
```

2. 공식 `read_thread`에서 exact thread ID·cwd·현재 turn ID·status·turnStatus·실제 error code를 읽고 관측 UTC를 함께 잡는다. 이 결과가 `idle` 또는 `notLoaded`, terminal이 `completed` 또는 허용된 quota 실패인 경우에만 다음 단계로 간다. `active/inProgress`, 불명 상태와 비 quota 실패는 발신하지 않는다. HOLD 해제를 임의 실행하지 않는다. 재개할 인간 승인 작업이 없거나 실제 전체 완료면 발신하지 않는다. 내장 goal blocked는 별도이며 active로 바꿔 보고하지 않는다.

3. 대상이 사용할 실제 OCX 경로 근거를 확보한다. helper의 pool READY는 해당 대상/turn의 OCX 사용 증명이 아니다. Native 한도를 OCX pool로 추정하지 않는다. 설치 helper의 DesktopClaim은 기존 17841/OCX service·admission policy·fresh account quota 검사를 자체 수행한다. 이 검사를 복제한 스케줄러를 만들지 않는다. 정책/경로/계정 준비가 UNKNOWN이면 큐를 보존한다.

4. 아래는 실행 시 사용할 기존 명령이다. 지금까지의 오래된 관측을 proof로 저장하지 않는다. `read_thread`의 실제 응답에서 필요한 최소 메타데이터만 새 소유 evidence 파일로 만든다. schemaVersion=1, source=`codex-app.read_thread`, threadId, projectRoot, observedAt(UTC), status, turnId, turnStatus, errorCode를 갖춘다. helper가 proof를 사용할 때 30초 이내여야 한다. 대화 원문·로그·인증자료를 증거 파일에 복제하지 않는다. evidence 경로와 attempt ID는 실제 실행에서만 생성한다.

```powershell
& $cfg.helperPath -Action DesktopClaim -ThreadId $exactApprovedTarget -SenderThreadId $actualOfficialSenderThreadId -EvidenceFile $freshAppEvidence
```

5. `claimed=true`인 실제 응답의 attempt.id와 `messageMarker`를 보존한다. 반환 marker는 `AICC_CONTINUITY_ATTEMPT:<실제 attempt ID>`다. 공식 `send_message_to_thread`의 threadId는 그 exact 대상, prompt는 marker와 인간이 승인한 기존 작업을 중단 지점부터 이어가라는 최소 문장으로 한 번만 보낸다. 새 업무나 권한을 덧붙이지 않는다. model/thinking은 기존 설정을 유지하며, 도구에 임의 route 전환 인자를 만들지 않는다. 도구 호출 전 선택 취소·새 turn·타 발신자가 확인되거나 결과가 불명해지면 보내지 않고 claim을 보존한다. Claim 직후의 일반 인계 성공이나 과거 응답을 새 전달의 ACK로 쓰지 않는다.

6. 실제 공식 전송 성공 응답에만 ACK를 만든다. schemaVersion=1, source=`codex-app.send_message_to_thread`, threadId, attemptId, accepted=true, responseSha256을 실제 도구 응답에 결속한다. 응답 원문은 복제하지 않고 바이트 직렬화 규칙을 영수증에 기록한다. 도구 오류·시간초과·의미 불명은 accepted=true로 바꾸지 않는다. 이 경우 재전송/claim 해제/새 attempt 없이 기존 상태를 보존한다.

```powershell
& $cfg.helperPath -Action DesktopAck -ThreadId $exactApprovedTarget -AttemptId $actualAttemptId -EvidenceFile $actualSuccessfulAck
```

7. 후속 공식 `wait_threads` 또는 `read_thread`로 새 turn을 읽는다. 원래 previousTurnId와 다른 새 turn이며 실제 marker가 그 user turn에 결속된 경우에만 fresh read_thread 메타데이터 proof에 continuityAttemptId를 넣어 관측한다. marker가 노출되지 않으면 추정하지 않는다. 상태 조회는 ACK나 업무 완료 증거가 아니며, 불명 전송 뒤 실제 marker/새 turn이 보이면 해당 사실로 조정하되 성공 응답 ACK를 꾸미지 않는다.

```powershell
& $cfg.helperPath -Action DesktopObserve -ThreadId $exactApprovedTarget -AttemptId $actualAttemptId -EvidenceFile $freshMarkerBoundTurnEvidence
```

`active/inProgress` 관측은 attempt를 보존한다. terminal도 한 turn 종료와 전체 목표 완료를 구분한다. continuityComplete와 holdReason은 실제 exact 최종 완료/HOLD 표시가 있을 때만 쓴다. metadata 또는 marker/새 turn 근거가 부족하면 UNKNOWN을 유지한다. 실패한 Claim의 부분 실행 여부도 기존 큐로 먼저 조정하고 같은 pass에서 맹목적으로 재실행하지 않는다. `DesktopHeartbeatObserve`는 실제 해당 예약 turn의 관측 전용이며 Claim/ACK를 대체하지 않는다.
## 재개 단계와 후보 적용 경계

큐 등록·사용자 선택, OCX 풀 한도 관측, Claim, 공식 전송 ACK, marker가 결속된 새 turn, 전체 목표 완료는 서로 다른 근거다. Status/DesktopQueue의 progress는 이 단계를 제공하고 dispatchable=false를 유지한다. 외부 공식 발신자는 fresh 조건을 별도로 평가한다. 과거 풀 READY는 대상의 현재 OCX 경로나 Native 한도 근거가 아니다. progress가 없는 기존 설치 helper는 미확인 단계로 표시하며 원장에 없는 ACK를 일반 전송 성공에서 가져오지 않는다.

현재 적용한 DesktopClaim에는 자기 자신과 다른 정확한 발신자 ID인 -SenderThreadId가 필요하다. 매번 registry의 helperPath/protocolVersion/helperSha256을 읽고 설치 세대를 결속한다. 구형 helper나 과거 핀을 재사용하지 않는다. 다음 형식에서 발신자는 실제 공식 도구 호출 대화 ID다.

```powershell
& $cfg.helperPath -Action DesktopClaim -ThreadId $exactApprovedTarget -SenderThreadId $actualOfficialSenderThreadId -EvidenceFile $freshAppEvidence
```

SenderThreadId는 호출 주체의 식별값이며 권한 증명을 대체하지 않는다. 로컬 worker나 웹 클라이언트가 이 값만 넣어 공식 도구를 호출할 수 있게 되지 않는다. 자기 발신·사용자 중지·결과 불명은 계속 보존한다. active 관측은 lastDesktopObservation, 종료한 attempt는 lastContinuityAttempt, ACK는 해당 attempt.ack와 deliveryAckAt에 보존한다. 마지막 한 건의 이력이며 원문이나 비밀을 복제하지 않는다. 늦은 ACK로 이미 관측한 active를 접수 대기로 되돌리지 않는다.

모바일의 Complete는 큐 추적 종료다. AICC 추적 목표 원장과 Codex 내장 goal은 별개이며 체크 표시·큐 종료·한 turn 완료로 goal을 active/complete로 변경하지 않는다. 내장 goal을 읽지 않았으면 UNKNOWN, goal=null이면 없음, blocked이면 blocked로 보존한다.

적용은 세 경계다. (1) guidance 홈 반영은 실행기 교체가 아니다. (2) continuity helper의 기존 Upgrade는 exact 기존 worker 정상 종료, pending=0, 단일 원장 잠금, 최신 registry rollback 보존과 새 helper 핀 전환이 필요하다. 현재 소스는 installed helper로 정상 종료를 요청하고 원장을 잠근 뒤 최신 선택을 읽어 보존하도록 보완한 후보이며 검증 미실행이다. 단순 파일 복사나 registry pin 수동 변경으로 설치하지 않는다. (3) 공개 모바일 UI는 별도 서비스 후보라 public runner의 정상 종료/drain ACK가 필요하다. Prepare-AiccMobilePublicRuntime의 overlay에는 mobile.js도 포함한다. 오래된 조립 후보를 새 소스 적용으로 보고하지 않는다. helper만 갱신해도 무인 공식 발신 수단은 생기지 않는다.
## 집에서 남은 전환을 할 때

먼저 현재 public runner의 소유 프로세스·실행 세대와 미결/불명 요청을 기존 activation-plan에 결속한다. legacy runner에 지원 정상 종료/drain ACK가 없으면 자동 전환 명령은 없다. force kill·임의 task stop·레지스트리 핀 복사로 대신하지 않는다. 사용자가 PC에서 기존 실행기의 정상 종료를 제공한 뒤에만 기존 후보 plan의 preparedConfig를 futureConfigPath에 설치하고, 기존 public task의 hidden launcher를 같은 trigger/principal로 전환한다. 새 후보는 Start-AiccMobilePublicRuntime.ps1 -ConfigFile <plan.futureConfigPath> -ExpectedConfigSha256 <plan.configSha256> 경로로 한 번 시작하며, 점유/불명 listener면 시작하지 않는다. 기존 rollback과 기기 신뢰 저장소를 보존한다. 새 runner의 drain-and-stop 계약을 과거 runner가 지원한다고 소급하지 않는다.

실제 폰 조작, Gemini 로그인/MFA와 실제 응답 저장, Android 폰 USB 허용/ADB 연결은 사용자 참여 항목이다. SDK나 APK 후보 준비를 폰 연결 완료로 표시하지 않는다. 사용자가 집에 왔다고 알리면 기존 PROJECT의 남은 항목을 최신 근거와 함께 안내한다. 이를 위해 새 모델 heartbeat를 만들지 않는다.
## Android의 최소 진입점

components/android-client는 기존 모바일 HTTPS 화면 하나를 외부 브라우저로 여는 소스 초안이다. 앱의 새 서버·큐·예약·인증 저장소를 만들지 않는다. 브라우저가 로그인/일회용 연결/기기 쿠키를 소유하고 앱은 WebView/OAuth/cookie 추출·임의 URL/deep link를 제공하지 않는다. 기존 브라우저로 인증한 뒤 같은 브라우저로 열어야 한다. Gradle 진입과 집에서의 명시적 동기화·빌드·폰 설치 순서는 해당 README를 따른다. 소스 준비는 APK 제작·설치·실제 폰 제어가 아니다. 현재는 검증 미실행이며 공개 서비스 후보나 공식 로컬 발신 계약과 별도다.
## 실행 호스트와 서버 독립 요구

AICC의 PC·폰 웹 제어와 실행 호스트는 별개다. Windows tray/helper/public mobile runner를 원래 PC에서 실행하는 구성은 PC 전원 종료 중 실행되지 않는다. Tunnel 고정 주소나 Android 진입 앱이 이를 서버 서비스로 바꾸지 않는다. 서버 독립이 필요한 업무는 그 업무의 기존 서버·실행기·큐·결과·예약이 소유해야 하며 AICC는 지원 API를 통한 상태/제어만 연결한다. 현재 source/배포·미결/HOLD는 각 업무의 PROJECT를 따르고 여기서 전체 서비스를 이주시키지 않는다.

서버 앱을 확인할 때 수집 메타데이터/원문, 실제 모델 실행, 저장, 예약, 재기동을 따로 판정한다. Windows caption relay와 owner_paste는 보조 경로다. SSH/VNC는 사용자 로그인 관리 통로일 수 있지만 서버 세션 인증이 거절되면 정상 무인 실행의 준비 근거가 되지 않는다. 웹 구독만 유지·API 금지 조건에서 공식 지원 조사와 현재 코드 구조를 혼동하지 않는다. 일반 browser automation/remote hosting을 허용된 모델 서비스 경로로 추정하지 않는다. 현재 서버 독립 전체 완료조건과 담당자는 기존 source PROJECT에 보존한다.
웹 구독만으로 서버 독립이 필요한 업무에서는 공급자의 공식 클라우드 예약 기능을 별도 설계 후보로 평가할 수 있다. 예를 들어 공급자 클라우드 작업→사용자 소유 문서/드라이브 결과→기존 서버의 승인된 OAuth 수집→기존 Markdown/큐 저장 구조다. 이는 브라우저 인증 우회나 developer-model API 복구가 아니다. 실제 계정 메뉴/지원 지역·언어, 결과 문서 생성 및 읽기 권한, 중복 방지/재기동 연속성과 PC 종료 조건이 확인되기 전에는 구현·예약·작동 완료로 표시하지 않는다. 공식 문서끼리 기기 종료 설명이 다르면 보장하지 않으며 사용자 계정 확인과 기존 원장의 조사 담당을 재사용한다. Drive OAuth scope 추가나 새 MCP 공개가 필요하면 기존 승인 범위를 넘어 실행하지 않는다. 현재 후보의 제품별 근거와 미해결은 source PROJECT의 서버 독립 절만 소유한다.
## 대상 경로·marker 근거를 갖춘 후보 계약

continuity source 후보의 DesktopClaim은 proof.targetRoute를 추가로 요구한다. source=codex-app.read_thread, provider=ocx, exact threadId/projectRoot/turnId, observedAt과 실제 도구 응답의 responseSha256이며 30초 이내여야 한다. 이는 공식 도구에서 실제 반환된 route 필드가 있을 때만 작성한다. 현재 read_thread가 provider를 반환하지 않으면 actual_target_ocx_route_unproven으로 큐를 보존한다. 없는 공식 endpoint를 만들거나 local config·선택 모델명·pool READY로 채우지 않는다. 기록된 route는 Claim 당시 근거이며 현재 준비 보장이 아니다.

후속 DesktopObserve 후보는 continuityAttemptId에 더해 attemptMarker=AICC_CONTINUITY_ATTEMPT:<attempt>, markerTurnId=실제 새 turnId를 요구한다. 실제 user turn의 marker 결속을 확인한 뒤에만 쓴다. continuityComplete=true에는 completed terminal과 finalMarker=AICC_CONTINUITY_COMPLETE:<thread>가, holdReason에는 finalMarker=AICC_CONTINUITY_HOLD:<thread>:<reason>가 필요하다. 큐 종료와 내장 goal은 여전히 별개다. 원문은 증거 파일에 넣지 않는다. 이 source 계약이 installed helper에 배포되기 전에는 실제 등록 세대가 지원한다고 보고하지 않는다.

## 신규 모바일 실행기의 단회 정상 종료 요청

현재 legacy runner에는 이 계약이 없다. 신규 후보의 status.controlProtocolVersion=2인 경우에만 Request-AiccMobilePublicStop.ps1이 exact config SHA·runtime ID·release manifest·PID·startedAt을 결속하고 stop-requests/<operation UUID>/request.json을 CreateNew로 한 번 만든다. 요청은45초 만료이며 nonce는 supervisor만 private config에서 stdin에 넣는다. 공개 HTTP shutdown endpoint는 없다. supervisor는 operation별 claim을 먼저 남기며 busy/불명 결과를 재전송하지 않는다. 작업이 끝난 뒤의 다른 정상 종료는 운영자가 새 operation을 명시해야 하며 자동 재시도가 아니다.

`-ConfigFile <실제 등록 config> -ExpectedConfigSha256 <실제 핀> -OperationId <새 단회 UUID> -Submit -WaitSeconds 30`이 실제 전송이고, 같은 operation에서 -Submit을 빼면 기존 결과만 읽는다. normalStopAck=true와 processExitObserved=true가 모두 있어야 해당 세대의 transitionReady다. server drain은 active HTTP/API·mutation·미결 결과·유효 preview를 거절하며 큐 worker·Tunnel·모델은 중지하지 않는다. ACK 지연·busy·채널 종료·listener 미확인은 보존하고 강제 종료하지 않는다.

전환 순서는 기존 exact task XML/registry·release·public entry와 기기 저장소를 보존하고, 알려진 active/unknown 요청을 조정한 뒤 실제 정상 종료 및 PID 소멸→4383 미점유→새 config와 기존 task의 hidden action을 CAS로 전환→단회 시작이다. 오류 시 새 후보의 지원 정상 종료가 가능한 경우에만 종료하고, 보존한 task/config/release로 복귀한다. 불명 원요청은 재실행하지 않는다. legacy runner의 첫 전환에는 실제 기존 정상 종료 방법과 원결과 조정이 여전히 필요하다. 이 소스 추가만으로 첫 전환·rollback 실행·폰 동작을 완료했다고 쓰지 않는다.

## 이미 정지된 공개 서비스의 교체

`Prepare-AiccMobilePublicRuntime.ps1 -Assemble`은 goal service와 user-action-ledger, 전용 installer까지 핀으로 묶은 새 불변 후보를 준비한다. 기존 실행기가 실제로 남아 있으면 기존 정상 종료 계약을 계속 적용한다. 이미 정지된 경우에만 후보 안의 `Install-AiccMobilePublicRuntime.ps1 -PlanFile <plan.json> -ExpectedPlanSha256 <pin> -ExpectedTaskXmlSha256 <fresh export pin> -ActivateStoppedService`를 명시적으로 사용한다.

이 분기는 기존 공개 task의 Ready/실행 인스턴스0, exact entry와 부모 launcher 부재, 4383 미점유, 후보·설정·launcher 핀, exact 모바일 durable 요청 원장과 작업 정의 CAS를 적용 전에 요구한다. 모바일 원장의 미결0은 전체 시스템 unknown0을 의미하지 않는다. 역사적 정상 종료 ACK는 unavailable로 보존한다. 기존 task XML과 release·entry를 보존하고 action만 숨김 supervisor로 전환하며 기기 trust·Cloudflare·모델 route·다른 task를 바꾸지 않는다.

`activation-attempt.json`은 설치와 단회 시작의 원장이다. 시작 시도 전에 불명 상태를 저장하고 정상 Start 응답만 접수로 기록한다. 같은 plan의 attempt는 재실행하지 않는다. 시작/등록 응답 불명은 지원 조회로 먼저 조정하며 강제 중지나 자동 원복하지 않는다. 원복은 저장된 task XML을 사용하되 시작 결과를 먼저 조정하고, 새 후보가 실행됐으면 해당 세대의 지원 정상 drain과 실제 종료 뒤에만 수행한다. 기기 저장소의 과거 사본은 복구하지 않는다. 기동 접수와 실제 PC·폰 기능은 별개이며 코드 사후검증은 현재 모델 정책을 따른다.

## 모바일 목표 조회 데이터

GET /api/mobile/goals 후보는 기존 인증 안에서 PC의 AICC tracked-goal service를 읽고 최대200개 제목/상태/확인 시각과 전체/표시 수를 반환한다. 원장 갱신 시각과 조회 시각을 분리하고 소유자 확인 표시를 완료로 간주하지 않는다. 내장 Codex goal 조회/변경·자동 완료·새 스케줄러는 제공하지 않는다. 소스·홈 스킬·불변 후보 조립·실제 공개 적용은 각각 기록한다.

## PC와 폰에서 할 수 있어야 하는 일

- 각 서비스의 실행 호스트와 실제 연결 상태, 최근 관측 시각, 현재 작업·대기 작업, 마지막 결과와 실패 이유를 보여준다. 프로세스 존재·포트 응답·실제 작업 완료를 별개로 표시한다. 오래된 관측은 오래됨, 호스트 단절은 연결 끊김으로 표시한다.
- 서비스가 지원하고 승인된 기능을 웹에서도 제공한다. 시작·정상 중지·재시작, 대화나 작업 선택, 큐 등록·순서·취소, 자동 재개 선택, 설정 변경과 결과 보기를 해당 서비스의 기능에 맞게 연결한다. 지원하지 않는 동작은 이유와 함께 사용할 수 없게 표시한다.
- PC와 폰은 같은 대상과 상태를 공유한다. 좁은 화면에서도 핵심 제어, 확인, 실패 이유와 기기 해제를 사용할 수 있어야 한다. 데스크톱 전용 hover나 창 포커스에 의존하지 않는다.
- 별도 승인 UI가 필요한 변경은 정확한 대상과 영향의 미리보기를 제공한다. 일반적인 승인된 동작에 매번 확인을 추가하지 않는다. 결과 불명은 성공·실패와 구분하고 같은 버튼을 다시 눌러 중복 실행하지 않도록 한다.
- 자동화는 브라우저나 폰 탭을 닫아도 원래 호스트에서 계속 동작한다. PC 종료·절전·로그아웃·네트워크 단절 때의 제한과 재연결 상태를 화면에 설명한다. PC가 꺼진 동안의 실행이 필요하면 기존 서버의 실행 가능 범위를 따로 설계한다.

## 인증과 접근 경로

- 로컬 관리 API는 기본 loopback에서 제공한다. 폰에서 접근해야 하면 기존 승인된 HTTPS 경로와 인증을 재사용한다. Cloudflare가 필요할 때 use-cloudflare를 사용하며 현재 계정·대상·기존 승인 범위를 따른다.
- 인증 전에는 민감 상태와 제어 API를 제공하지 않는다. 실행 가능한 동작과 대상은 서버의 허용 목록으로 제한한다. 웹 화면에 범용 shell, 임의 파일 접근 또는 인증키를 노출하지 않는다.
- 사용자가 승인한 브라우저·폰은 직접 해제할 때까지 기억하는 방식을 기본으로 한다. PC 발급의 짧은 일회용 연결을 재사용하고 기기 이름·개별 해제·전체 해제를 제공한다. 서버 재시작 뒤에도 인증과 철회가 유지되어야 한다.
- 기기 비밀은 HttpOnly·Secure 쿠키 등 기존 안전한 저장 방식을 쓰고 서버에는 해시·철회 기록만 소유자 전용으로 저장한다. 브라우저 쿠키 보존 상한·삭제·시크릿 모드에 따른 재인증은 정확히 설명한다. 인증 토큰을 URL 기록·로그·스킬·프로젝트 문서에 복제하지 않는다.
- 외부 요청의 host·origin, CSRF와 프록시 경계를 서버에서 확인한다. 외부에서 헤더를 바꿔 로컬 소유자 권한이나 기기 발급 권한을 얻지 못하게 한다. 클라이언트 버튼 숨김만으로 권한을 구현하지 않는다.

## 창 없는 운영과 유지

- 서비스·worker·연결기·감시기는 콘솔 창 없이 실행한다. Windows 작업의 Hidden 속성만으로 자식 콘솔이 사라진다고 가정하지 않는다. 기존 WScript wrapper나 CreateNoWindow/windowsHide 등 실제 실행 경로의 창 없는 방식을 재사용한다. 관련 작업은 present-agent-terminal-status를 따른다.
- 사용자 터미널·다른 서비스·로그인과 기존 기동 설정을 보존한다. 서비스 중지는 정확한 소유 작업과 자식에 한정하고 미결 작업을 정상 정지한다. 현재 에이전트의 모델 연결을 건드리면 기존 복구 절차를 먼저 따른다.
- 기존 호스트의 자동 시작·장애 복구·복구 대상과 비밀을 제외한 운영 기록을 남긴다. 명령을 보낸 것과 재시작 후 실제 동작은 구분한다.
- 현재 모델 정책과 사용자가 명시한 검증 범위를 따른다. 작성, 홈 배포, 서비스 적용, 실제 PC·폰 동작을 별도 상태로 보고한다. 사후 검증을 하지 않았으면 검증 미실행으로 표시하며 다른 에이전트로 우회하지 않는다.


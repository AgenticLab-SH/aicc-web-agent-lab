# OCX 운영과 복구

## 현재 대화·전환·설치 계약

최신 adapter의 입장 상한은 5시간97%·장기98%이며 owner의 더 엄격한 정책을 우선한다. 자동/선호는 신선한 사용량·모델·인증 상태를 확인해 고르고, 고정은 해당 계정이 부적격이면 멈춘다. 이미 보낸 응답은 종료까지 받으며, 불명 원 요청을 다른 계정으로 재발신하지 않는다. 계정 귀속 암호문·응답/파일 handle은 기존 portability 검사 없이 옮기지 않는다. quota 알림과 실제 입장 정책은 별개다.

명시된 메모리 작업은 사용자 turn과 분리하고 서로 다른 메모리 작업도 구분한다. 같은 메모리 요청의 중복 실행과 기존/새 UNKNOWN의 동일 요청 재생은 계속 차단한다. 실제 진행 충돌은 재시도 금지 HTTP409이며 서비스 장애503으로 해석하지 않는다. terminal 성공/실패 이벤트는 EOF를 기다리지 않고 해당 요청만 정리한다. HTTP200·EOF·큐 접수·health 성공은 모델 완료 증거가 아니다.

설치는 독립 복구 READY·실제 active/inflight 0·현재 owner/CAS·롤백을 확인한 지원 경로로 한다. 과거 UNKNOWN은 보존하며 그 수를 0으로 지우거나 바꾸는 것이 유휴 조건은 아니다. 아래 날짜별 97/97·95/98·버전·UNKNOWN0 문구는 당시 기록이다. 최신 소스·설치 manifest·실행본·실제 응답을 각각 확인하고, 관리 API 거절은 데이터용 인증이나 다른 수단으로 우회하지 않는다.

설치/테스트 인수에는 변경된 릴리스, 실행본 hash, 사용자 turn/메모리 동시 처리, 자동/선호/고정 결과, UNKNOWN 보존·재생 금지 및 원 대화의 실제 응답을 필요한 범위에서 남긴다. 같은 변경이 없는 기존 성공은 재사용한다. 프로세스나 계정 상태를 추측해 원 요청을 다시 보내지 않는다.

## 2026-10-26 · 계정 선택과 503 재발 방지

일반 `gpt-6.1-sol`은 자동 선택이다. 수동으로 선택된 계정이나 이전 고정 계정의 우선순위는 자동 풀의 상한이 아니다. 다음 새 요청마다 모델 지원, 계정 상태, 신선한 사용량과 97% 보호 기준을 확인해 적격 계정을 고른다. `preferred-<selector>/<model>`은 새 대화에서 해당 계정을 우선 시도하고, 소진되었으면 다른 적격 계정을 고른다. 기존 `<selector>/<model>`과 CLI `--account N`은 해당 계정만 쓰는 엄격 고정으로 유지한다. CLI `--prefer-account N`은 우선 계정 모드이며 계정 번호는 우선순위 번호가 아니다. 일시중지된 계정의 CLI 바인딩은 거절한다.

계정 전환은 미접수로 확정된 새 요청에서만 한다. 접수 여부가 불명인 요청, 진행 중인 스트림, 기존 대화의 계정 귀속, 암호화된 추론과 기존 계정의 파일 ID를 다른 계정에 재전송하지 않는다. 10101의 자체 503은 안전한 코드·단계·발신 시작 여부만 17841 상관 원장에 전달하며, 업스트림의 같은 이름 헤더는 제거한다. `healthz`·`readyz` 성공과 모델 목록 사전 검사 성공, 실제 모델 응답 성공을 구분한다. 3초 사전 검사 실패를 추론 503으로 기록하지 않는다. 설치 전에는 현재 버전·독립 복구 READY·정확한 유휴/불명 0·rollback을 새 작업에서 확인한다.

2026-10-25 23:20~23:21 KST의 503은 사용자 보고에 따르면 1·2번이 각각 97%·98%이고 3·4번이 후보인 상태에서 발생했다. 당시 코드의 `priority(pin)` 상한이 자동 후보를 배제할 수 있었지만, 17841에 당시 10101의 내부 거절 코드가 없어 해당 503의 단일 원인으로 확정하지 않는다. 이 상한은 계정별 선택 기능보다 먼저 존재했으므로 선택 기능 도입이 결함을 새로 만들었다고 단정하지 않는다. 사용자 제공 unpin 영수증은 `00000000000000000000000000000000`이며, 이후 HTTP 200과 별도 CLI 성공은 당시 복구 관측이다. 현재 수정판의 운영 적용·실제 응답 증거와는 구별한다.

A1 설정은 요청 선택 시 최대 30초 캐시의 공식 snapshot에서 읽는다. 새 소스 후보는 A1의 새 snapshot에 pin이 없고 로컬 `config.json`에 옛 pin이 남은 경우, 다음 승인된 요청 선택에서 그 pin 필드만 제거한다. 로컬 활성 선택·대화 귀속·인증·다른 설정은 유지하고, 로컬 파일이 없거나 잘못되거나 접근 거절이면 요청은 안전한 A1 snapshot으로 계속 선택하며 관리 상태에 `pinMirrorStatus=sync_failed`를 남긴다. 나머지 설정 전체 동기화는 기존 공식 `synchronize()`가 소유한다. 현재 home 경로에서는 파일 목록을 얻지 못했고 보호된 `service-state.json` 읽기도 거절되어 **설치본의** 로컬 pin readback과 이 새 동작의 실사용은 UNKNOWN이다. 임의 파일 수정·반복 unpin으로 상태를 맞추지 않는다.

이번 소스의 후보 봉인은 현재 설치 후보의 adapter 12파일 가운데 변경된 3파일만 차이 나는지 확인한 후, 공식 `New-AiccExternalOcxRelease.ps1`의 전체 입력과 현재 설치 preimage를 고정해 수행한다. 2026-10-26 조사에서는 설치 후보 `c02e6669353df3b1` 대비 변경 adapter가 `external-account-picker.ts`, `external-http-boundary.ts`, `external-pool-state.ts`뿐이었다. 그러나 기존 snapshot의 4개 preimage 중 3개가 현재와 달랐고 나머지 `home/service-state.json`은 접근 거절이었다. 기존 search acceptance도 변경된 `external-http-boundary.ts` 해시와 달라 공식 builder의 두 필수 게이트를 충족하지 못했다. 새 immutable 후보 생성·preview·설치 0건으로 HOLD한다. CLI·트레이 변경은 adapter 후보와 별도 소유 설치 절차가 필요하다.

초기 격리 search acceptance 준비는 공식 supplier `src/index.ts` 읽기의 `EPERM`으로 종료되어 당시 새 PASS 수락 파일이 없었다. 임의 도구·계정으로 우회하지 않고 현재 설치본 registry와 이전 rollback 위치, 이번 3파일의 source SHA 및 미충족 게이트를 `backups/ocx-pool-failover-20261026/candidate-preparation-20261026.json`에 고정했다. 아래의 정식 권한경로가 가능해지면 공식 `Invoke-AiccOcxTransition.ps1 -Mode Prepare`의 fresh snapshot, 현재 소스 기반 격리 search acceptance, 공식 release builder의 순서로 잇는 계획이었다. 이는 서비스 중지나 설치의 승인 게이트를 대신하지 않는다.

**2026-10-26 후속:** 위 일반 OS 접근 오류는 정식 관리자 실행 검토를 거친 뒤 해결했다. 공식 `Prepare`가 현재 소프트웨어 4파일의 fresh snapshot `ocx-clean-20261026-014854-faa5198d`를 만들었고, 격리 search 수락 9개가 PASS했다. 공식 builder는 공급자 archive 1,947파일과 공급자 파일 5,866개, adapter 12파일을 확인해 후보 `6974e48e55809325`를 봉인했다. 결과와 해시는 `backups/ocx-pool-failover-20261026/candidate-sealed-20261026.json`에 있다. 설치본 registry는 이전 후보 `c02e6669353df3b1`을 그대로 가리키며 서비스 중지·교체·재시작·실제 모델 요청은 하지 않았다. 새 후보의 독립 복구 READY와 양쪽 서비스 active/unknown 정확 0을 확인한 뒤에만 공식 단회 설치를 판단한다.

## 2026-10-25 · 고정 계정 모델과 정상 복구 장치 등록

Desktop 모델은 `A1 k-8 · Sol 6.1`, Web은 `w A1 k-8 · 임시 · 높음`처럼 표시한다. 사람의 계정 번호는 등록 별칭에서 얻으며 자동 우선순위나 내부 ID가 아니다. `aicc codex accounts`, `aicc codex ocx --account 4 --route-model gpt-6-astra --route-effort high`를 사용한다. 같은 번호의 중복·정지·삭제·실행 직전 연결 변경은 거절한다. 표시와 CLI 설치 완료가 현재 OCX의 모든 고정 계정 요청 성공을 뜻하지는 않는다. 실제 적용 단계는 `context/PROJECT.md`를 따른다.

모델 추가와 갱신은 `manage-model-picker` 스킬과 기존 PRIVATE `scripts/apply-ocx-config-account-catalog.mjs` owner를 사용한다. 실제 native metadata의 지원 slug와 추론 단계를 읽고 최신 family의 표시와 실제 연결을 함께 갱신한다. 이전 대화의 slug는 숨겨 보존하며 인증·계정 우선순위·서비스는 바꾸지 않는다.

기존 RDC 장치가 오프라인이고 현재 등록 ID가 달라졌을 때, 코드의 장치 상수를 바꾸거나 임의 허용 목록을 추가하지 않는다. 정상 `tools/platform/aicc/Recovery-DeviceBinding.psm1`의 단일 장치 등록 절차를 사용한다.

1. 기존 공식 연결과 현재 장치를 확인하고 현재 RDC host의 PID·생성 시각·실행파일/명령 hash를 고정한다. `New-AiccRecoveryDeviceChallenge`가 소유자 작업 폴더 아래 일회 challenge와 읽기 전용 probe 명령을 만든다.
2. challenge 생성 이후의 공식 `list_devices` 원응답과, 그 정확한 명령을 공식 `start_process`로 실행한 응답 및 같은 PID의 `read_process_output` 원응답을 보존한다. 다른 PC·계정·장치·프로세스·nonce·만료·변조는 거절한다.
3. `New-AiccRecoveryDeviceRegistration`으로 원응답·같은 PC와 소유자·실제 독립 프로세스 계보를 단일 immutable 등록 파일에 묶는다. 등록 파일의 SHA256과 검증 모듈 hash를 새 작업 metadata에 고정한다. 등록 자체는 복구 대기 수락이 아니다.
4. 정확한 software snapshot/candidate와 source 계약, 정식 백업을 준비한 뒤 `Invoke-AiccRemoteRecovery.ps1 -Mode arm -Transport rdc-device`에 `-DeviceRegistrationPath`와 `-DeviceRegistrationSha256`을 전달한다. operation/복구 기한은 등록 만료 안에 있어야 한다.
5. 공식 RDC에서 같은 작업의 watch를 한 번 시작하고 실제 `READY_STANDBY`와 신선한 heartbeat를 확인한다. 전환기와 idle-wait도 동일 등록 증거를 검증한다. 기존 drain·현재 소유자/CAS·원상복구·한 번만 실행하는 조건은 그대로다. 설치 후 새 요청 수락과 원 실패 요청의 접수 불명을 구분한다.

등록과 대기는 짧은 유효기간이 있으며 이전 성공을 다음 정비의 fresh READY로 재사용하지 않는다. 시험만 끝났으면 해당 작업을 정상 close한다. 2026-10-25의 첫 실제 등록 probe와 독립 READY 확인은 HOME `ops/webgpt-remote-recovery/operations/ocx-registered-preflight-20261025-1520/preflight-acceptance.json`에 있다. 이 시험은 서비스 교체·실제 503 해소·quota 회복을 실행하거나 입증하지 않았다.

> 현재 운영 기준은 2026-10-08 KST입니다. 이전 A1 client 방식과 95% 설정은 아래의 역사 기록이며 현재 설정에 덮어쓰지 않습니다.
> 최신 설치·복구 위치는 `context/PROJECT.md`와 [홈·트레이 운영 기록](../aicc-home-and-tray-control.md)이 정본입니다.

평소에는 원본 Codex를 사용한다. 전역 provider와 로그인은 OpenAI Native로 보존했고,
2026-10-04 승인된 기본 모델 연결은 17841에서 OCX10101로 전달한다. Web 모델은 표시된
계정의 브라우저로 보낸다. 현재 Windows 로컬 OCX `2.77.0-aicc.local.3`가 일반 요청을 처리하고
5시간·주간 각각 사용량 97%에서 전환하도록 설정한다. A1은 인증 갱신과 PC와 독립된
초기화 감지·작은 주기 시작·Slack 한도 조회를 맡는다. 최신 검증·경계는 [사용 설명서](../../user-guide.md#6-ocx-사용과-계정-전환)와
[OCX 운영 정본](../../../tools/platform/opencodex/README.md)에 있다.

## 현재 완료 범위와 보호 경계

사용자는 2026-10-08 OCX 기능을 완료로 수용했다. 로컬 요청 처리, 계정 우선순위·일시중지·재개·선택,
트레이 한도 설정과 자동 조회, Slack 한도 응답, 중지 계정의 서버 초기화 감지·주기 시작을 운영 범위로 닫는다.
서버는 일반 요청 중단이나 Windows 계정 전환을 수행하지 않는다. A1이 refresh credential의 단독 작성자이며,
로컬 access lease는 휘발성이다. refresh grant를 Windows로 복사하지 않는다.

진행 중 요청은 응답 스트림이 끝날 때까지 로컬에서 감시하고 임계값 도달 시 취소한다.
부분 응답이나 도구 호출을 다른 계정으로 재전송하지 않는다. 다음 새 요청이 적격 계정을 선택한다.
공급자의 실제 취소 승인·늦은 청구 중단은 아직 증명하지 않았으므로 99% 상향은 보류한다.

2026-10-31 external release source 변경(G1-01, 미설치·검증 미실행): Windows external
경계(`external-http-boundary.ts`)에서는 97% 판정을 **새 요청 admission**에만 적용한다. 이미 한 번
물리 전송된 응답은 임계값·quota freshness 사유로 취소하지 않고 끝까지 받아(drain) 정산한다. 취소는
원 대화 전체를 막는 UNKNOWN을 만들었기 때문이다. 자격 증명 교체/철회는 계속 즉시 중단한다. 공급자의
실제 한도는 공급자가 응답을 끝내고, 그 결과는 확정 실패로 정산한다. 따라서 drain 중 사용량이 97%를
넘어 공급자 한도까지 쓰일 수 있다. 위 문단의 stock/A1 `.2` 감시 동작은 바꾸지 않았다.
사용자가 미룬 OCX 소프트웨어 원복 시험도 실행하지 않는다. 오래된 복구 hash를 현재 값으로 고쳐 우회하지 않는다.

트레이는 홈의 `bin/aicc-tray.exe` 또는 시작 메뉴 **AICC 상태**로 연다. 기존
`AgenticLab-AICC-Status-Tray` 작업 하나가 사용자 로그인 20초 뒤 실행한다. 닫은 뒤에도 같은 바로가기를 사용하며
추가 Run/Startup 등록을 만들지 않는다. 기본 재조회는 5분, 선택 시 1분이다. 현재 선택 계정과 한도 차단 표시는 별개다.
초기화권은 fresh 잔여 수와 사용자 확인 후 기존 durable operation으로 한 번만 소비한다.
모호한 결과는 잠금을 유지하고 자동 반복하지 않는다. 실제 초기화권 소비·다음 로그인 UI 관찰은 미실행이다.

Slack의 **AICC 한도 운영** DM에 `한도` 또는 `ocx 한도`를 보낸다. AICC app/bot ID는 계속 재사용한다.
**SKCT 서비스 알림**은 별도 서비스이므로 통합 삭제하지 않는다. 명령 확인 tick은 10초,
서버 초기화 관찰은 별도 120초이다. 2026-10-07 22:32 KST readback에서 미응답 질의 0건을 확인했다.
같은 관찰에서 중지 계정 전용 initializer 실행과 고정 주간 deadline을 확인했지만 실제 응답 지연을 측정한 것은 아니다.

복구는 모델 경로와 독립 AICC Workspace 경로를 한 번에 교체하지 않는다. 17841의 OCX 인증 handoff,
공식 Native 로그인·설정·대화, A1 인증 저장소, Workspace gateway와 현재 release를 보존한다.
운영 중인 계정이나 서비스에 문제 없이 추가 시험을 반복하지 않는다.

## 이전 토폴로지의 기록

아래 2026-10-01~03의 client/Hub 관측은 사건·복구 참고 기록이다. 현재 정책은 위의 로컬 97%/97% 기준이다.

## 문제가 생기면 이 명령 하나

PowerShell에서 다음 명령을 실행한다.

```powershell
aicc-ocx-recover -Open
```

기존 A1 서버와 Windows OCX를 확인하고, 완전히 꺼진 기존 서비스만 다시 켠다.
정상 동작 중이면 그대로 둔다. 새 서비스를 만들거나 계정·Codex 설정을 덮어쓰지 않는다.
마지막에는 공식 client 관리 화면 `http://localhost:10100`을 연다. 필요하면 A1에서 발급한 일회용 코드로 인증한다.
화면을 열 필요가 없으면 `aicc-ocx-recover`만 실행한다.

이전 Codex 대화에서 답변이 끊기면 새 Native 대화에서 이전 대화 링크를 주고 이어간다.
이 절차는 원래 대화 기록을 삭제하거나 provider 이름을 바꾸지 않는다.
`ocx recover-history --ocx-compaction`은 실제 OCX compaction 기록이 있는 경우의
개별 복구이고, 모든 오래된 대화의 수리 명령이 아니다.

AICC의 파일 보관·쓰기·읽기·저장된 대화 이어가기는 1번과 2번에서 통과했다.
Windows 0.160.0에서 이미 열린 시험 대화를 다시 불러오면 프로세스가 종료된 사례가 있어,
검증된 재개 방식은 이전 시험 프로세스를 종료한 뒤 새 프로세스에서 같은 저장 대화를 여는 것이다.
이는 Desktop의 모든 자동 이어가기를 고쳤다는 뜻은 아니다.
Windows 제한 환경에서는 파일 작업에 `Set-Content`, `Get-Content` 같은 기본 명령을 사용한다.
## 현재 원본 OCX 구성

2026-10-03 검증 기준으로 Windows와 A1은 원본 2.76.0이다.
Windows는 기존 `opencodex-proxy` 예약 작업, A1은 기존 `opencodex-proxy.service`를 사용한다.
A1의 Node 실행기가 없어서 반복 종료되던 문제는 공식 Node 런타임을 서비스 경로에만 넣어 해결했다.
두 곳 모두 기본 Bun global 설치를 사용한다. 예전 폴더 이름으로 현재 버전을 판단하지 않는다.

Windows 10100 대시보드의 관리 통신은 OCX가 지원하는 `relay` 방식이다.
원본 2.76.0의 direct 방식에서는 연결 코드 POST의 브라우저 사전 요청이 404를 반환했다.
relay에서는 실제 연결 코드 제출과 한국어 대시보드 표시가 통과했다.
10100의 GUI 토큰은 메모리에만 있으므로 새로 열 때 다시 연결할 수 있다.
사용자 주소는 `http://localhost:10100` 하나다. 10102는 내부 SSH 관리 연결로 유지한다.
2026-10-04 독립 QA 브라우저에서 공식 pairing, 계정/설정/9개 Native 모델 조회를 확인했다.
10100의 공식 GUI fetch로 95를 그대로 저장하고 A1 독립 조회에서 95를 재확인했다. 활성 계정과 고정 상태는 유지됐다.
새 탭/새로고침은 재인증이 필요하다. 일회용 코드는 5분, pairing 관리 세션은 마지막 사용 후 12시간이다.
10100 업데이트 버튼의 management relay 대상은 A1이다. PC 실행본을 별도로 확인해야 한다.

Windows는 client이고 계정 4개의 인증·갱신 소유자는 A1이다.
A1의 `main`은 원본 Native Codex 로그인과 별개이며 의도적으로 계정 풀에서 제외한다.
같은 Team 계정이 이미 풀에 있으므로 Native 인증을 서버에 복사하거나 다시 로그인하지 않는다.
계정별 현재 상태는 `aicc-ocx-hub -Action identity`와 `-Action refresh`로 확인한다.

복구 명령이 소유자 불명, 다른 프로세스, 실행 중인 작업을 발견하면 종료하거나 중복 시작하지 않는다.
표시된 원인을 확인한 뒤 정확한 기존 소유자만 처리한다. 실패한 모델 요청을 자동 재전송하지 않는다.

## liveness와 readiness

- `/healthz` 200: 프로세스가 포트를 열고 HTTP를 처리한다.
- `/readyz` 200 + `status=ready`: 시작 동기화까지 끝나 새 요청을 받을 수 있다.
- `/healthz` 200, `/readyz` 503: 포트는 살아 있지만 운영상 `attention`이다.

AICC wrapper와 설치 검증은 두 endpoint의 service, port, PID를 같은 runtime state의 service
PID와 대조한다. health 성공을 readiness로 기록해서는 안 된다.

## upstream-only 선행조건

OpenCodex 설정은 native Codex integration을 명시적으로 꺼야 한다.

```json
{
  "clientIntegrations": {
    "codex": false
  }
}
```

이 설정은 OCX를 끄는 것이 아니다. OCX가 사용자 `config.toml`과 model catalog를 소유하려는
시작 동기화만 끄며, 10100 Responses endpoint와 account pool은 계속 사용한다. 선행조건이
없으면 AICC upstream-only wrapper는 시작·설치를 fail closed한다.

## 사용량 기반 선제 계정 전환

`autoSwitchThreshold`가 0이면 선제 전환이 꺼진다. 1~100이면 현재 계정 사용량이 임계값에
도달했을 때 quota가 더 남은 적격 계정을 선택할 수 있다. 프로세스가 정상이어도 이 값이 0이고
활성 계정이 소진되면 새 대화가 연속 5xx/limit 오류로 실패할 수 있다.

현재 A1 Hub가 계정 풀과 전환 설정의 소유자이고 Windows OCX는 client다. 2026-10-01
적용한 95% 정책은 Hub의 `autoSwitchThreshold=95`, `pool.cacheAffinity=false`다.
후자를 빼면 기본 대화 유지 정책 때문에 기존 대화는 95%를 넘어도 실제 소진까지
같은 계정을 사용할 수 있다. 업로드한 파일 ID가 연결된 대화는 계정 변경 시 파일이
깨지므로 별도 보호 규칙이 우선한다. 업데이트 뒤에는 Hub의 두 설정과 계정 조회,
Windows client 연결을 다시 읽는다. `ocx update check --json`은 읽기 전용 확인이
아니라 실제 업데이트를 실행한 사례가 있으므로 버전 조회에 사용하지 않는다.

AICC 자체는 OCX 계정을 바꾸지 않는다. 상태 화면은 다음을 분리해 표시해야 한다.

일반 `account list --json`은 성능을 위해 quota를 생략한다. hub helper는 `--quota`를 추가했으며
숫자 미조회와 실제 0을 구분한다. 캐시 조회의 관측 시각은 upstream CLI가 노출하지 않으므로 최신으로 단정하지 않는다.
실제 stock 2.76.0의 격리 시험은 94% 유지/95% 여유 계정 선택/계정별 override/unknown 유지를 통과했다.
unknown 점수는 101이며 0으로 처리되지 않지만 upstream은 unknown 계정 사용을 허용한다. 조회 실패 시 95% 선제 보호를 보장할 수 없다.
운영 계정의 실제 임계값 도달 전환은 미관측이다. Native OpenAI 직접 요청은 OCX 규칙의 대상이 아니다.

- AICC account auto-switch: false
- account switch owner: OCX
- OCX proactive switch enabled와 threshold

## 서버 주기 초기화와 계정 번호 확인

2026-10-03 실제 계정 이메일 해시를 등록된 Chrome 계정과 대조했다.
`pa22c95`는 9222/1번, `p1d05e5`는 9223/2번이다. 현재 사용량이나
selector 정렬 순서만 보고 번호를 붙이지 않는다. 관측 당시 1번은 주간 0%,
2번은 100%였다. 두 Team 계정의 `paused=true`가 서버 초기화를 막고 있었다.
사용자의 정상화 승인으로 두 계정만 일시정지를 해제했고 95%와
`pool.cacheAffinity=false`, 우선순위와 활성 Plus 계정은 유지했다.

1번은 두 개의 새 관측 후 초기화 요청 1회가 성공했다. 이어 고정된
weekly deadline `1791616366`과 `cycle_started`, 미해결 attempt 없음이 확인됐다.
2번은 기존 deadline `1791290965`까지 소진 상태로 기다리며 강제 초기화하지 않는다.
새 reset credit를 구매하거나 소비한 작업이 아니다. A1 타이머는 active이고,
구 direct-credential 타이머는 disabled 상태를 유지한다.

Windows client에서 `ocx account`가 `not_found`를 반환하면 연결 장애로
단정하지 않는다. 기존 relay를 사용하는 다음 관리 CLI를 사용한다.

```powershell
pwsh -NoProfile -File C:\demo\open-AICC\tools\platform\opencodex\Invoke-AiccOcxHubAccounts.ps1 -Action refresh
# 설치된 짧은 명령도 같은 source를 사용한다.
aicc-ocx-hub -Action refresh
```

정확한 selector·identityHash를 사용하는 pause/resume은 기본 미리보기이며
`-Commit`이 있어야 적용된다. 인증정보는 A1 밖으로 내보내지 않는다.
자세한 계약은 `tools/platform/opencodex/README.md`에 있다. 없어진 계정의
오래된 watcher 기록은 `presentInPool=false`로 표시하고 이력을 삭제하지 않는다.
이 관측은 실제 95% 경계 통과나 소진 계정의 다음 리셋을 미리 성공시킨 증거는 아니다.

## 복구 순서

1. active turn과 draining 상태가 exact zero/false인지 확인한다.
2. 10100 listener의 PID·command·Windows 예약 작업 또는 A1 systemd 등록을 대조한다.
3. `/healthz`, `/readyz`, `ocx health --json`, `ocx ready --json`을 각각 확인한다.
4. `clientIntegrations.codex=false`, `autoSwitchThreshold>0`을 비밀 없이 확인한다.
5. stale process를 이름으로 일괄 종료하지 않는다. 소유 서비스의 exact PID와 rollback을
   고정한 one-shot cutover만 사용한다.
6. 재기동 뒤 route config hash가 바뀌지 않았고 10100의 실제 Responses canary가 한 번
   성공했는지 확인한다.

실패한 canary는 자동 반복하지 않는다. HTTP 전송 여부가 모호하면 ledger에 uncertain으로
남기고 새 요청을 만들지 않는다.

## 2026-10-11 Windows 재부팅 장애: 로컬 OCX와 A1 허브 구별

### 결론과 접근 경로
Windows의 OCX 2.81.0은 A1 허브에 연결된 클라이언트이며 계정/자격증명의 소유자가 아니다. 네트워크 포트는 다음처럼 구분한다.

| 주소 | 실제 역할 | 화면과 연결 기준 |
| --- | --- | --- |
| `192.0.2.1:10100` | Windows OCX 로컬 추론 및 클라이언트 GUI | `/readyz` 200이 실행 확인. `/`의 허브 페어링 화면은 클라이언트 역할에서 정상일 수 있음 |
| `192.0.2.1:10101` | 동일한 로컬 OCX 프로세스의 두 번째 추론 포트 | Web GPT 17841의 일반 모델 OCX upstream |
| `localhost:10102` | SSH 터널로 연결된 A1 OCX 계정·관리 허브 | **계정 관리 대시보드는 여기로 연다.** 터널 실행 주체는 검증된 `ssh.exe` |
| `192.0.2.1:17841` | AICC Web GPT 통합 모델 경로 | `chatgpt-web/*`은 Web GPT, 기타 통합 모델은 OCX로 전달 |

원본 클라이언트 설정은 `runtimeRole=client`, `managementTransport=relay`, `managementUrl=http://localhost:10102`. 원본 OCX의 `machine-listener.ts`는 클라이언트 화면도 제공하며, `external-stock-management.ts`는 A1 계정 관리 화면을 프록시한다. `10100`에 보이는 **"이 대시보드를 허브에 연결"**은 포트 변경 증거가 아니다. 브라우저 출처가 달라 `10102`의 세션을 `10100`에서 자동 사용할 수 없기 때문이다. 로컬 화면 자체의 허브 정보가 필요하면 OCX가 제공하는 단회용 `ocx gui pair --origin "http://192.0.2.1:10100"` 절차로 별도 승인해야 한다. 단회용 코드는 노션·Git·로그에 보관하지 않으며 인증을 자동 우회하지 않는다.

### 변경과 검증
- 시작 장애: Task Scheduler `opencodex-proxy`는 실행 중이었지만 등록된 `@oven/bun-windows-x64/bin/bun.exe`가 없어 10100/10101 listener가 없었다.
- 기존 공급자 파일 5,866개의 해시 점검에서 별도로 하드링크 공유 중인 `node_modules/bun/bin/bun.exe`·`bunx.exe`가 무결성 불일치로 확인됐다. 단순히 실행 경로를 바꾸거나 검사 자체를 끄지 않았다.
- 독립 복사된 공급자 폴더 `~/.ai-control-center/opencodex-native/candidates/2.81.0-isolated-20261011-15277c59/package`의 5,866개 파일·Adapter 11개·호환성 승인 자료를 새 manifest와 대조해 PASS. Hardlink 0개.
- 등록된 로컬 OCX `10100`·`10101`이 동일 PID에서 ready 200, 계정 4개를 트레이 상태 수집기로 조회, 기존 A1 `10102` SSH 터널 및 Web GPT `17841` PID 유지. 활성 요청·계정 변경·초기화권 소비 0건. **이후 재부팅 검증은 별도 필요**.
- AICC의 `Open-AiccOcxDashboard.ps1`가 잘못된 계정관리 목적지 `10100`을 열던 것을 고쳤다. 등록된 A1 SSH 소유자, loopback 10102 매핑, HTTP 200 및 GUI hub role을 검증한 후 **사용자의 클릭 시에만** `http://localhost:10102`를 Chrome 새 탭으로 연다. `-CheckOnly`는 브라우저 없이 검증만 한다. local OCX recover/페어링 코드 생성/계정 변환은 포함하지 않는다.
- 트레이는 별도 WinForms + Node 상태 조회기로 유지한다. 기능 확인에는 등록된 tray release와 상태 수집기의 스냅샷 및 UI 새로고침을 구분한다.

### Bun 사용 판단
- **OCX 2.81.0: Bun 유지.** 현재 소스가 `Bun.serve`와 Bun 기반 TS 진입점을 실제 사용한다. 호환성 검증 없이 Node.js로 바꾸는 것은 운영 변경이다.
- **AICC Web GPT**: 이미 설치된 서비스가 Bun을 사용하면 그 서비스의 고정·검증된 런타임을 유지한다. OCX와 버전·설치 경로·권한을 공유할 이유는 없다.
- **상태 트레이**: WinForms C# UI와 별도 Node.js 상태 수집기 구조를 유지하는 편이 낮은 자원과 유지보수에 적합하다. Bun으로 전체를 바꾼다고 리소스가 반드시 줄지는 않는다.
- **Windows 관리·부팅 스크립트**: PowerShell 및 작업 스케줄러를 유지한다. Bun은 일반 Windows 서비스 관리 프레임워크의 대체가 아니다.
- 사용 주체별 런타임, 실행 경로, 소유자, 공급자 manifest/hash, 자동 시작과 실패 로그를 각각 고정한다. 다른 프로젝트와 하드링크로 공유되는 변경 가능한 실행파일은 운영 릴리스에 직접 사용하지 않는다.

### 점검 명령과 주의
```powershell
Invoke-RestMethod http://192.0.2.1:10100/readyz
Invoke-RestMethod http://192.0.2.1:10101/readyz
aicc task run routes.status --json
pwsh -NoProfile -NonInteractive -File C:\demo\open-AICC\tools\platform\opencodex\Open-AiccOcxDashboard.ps1 -CheckOnly
```
`CheckOnly`가 PASS여야 계정 관리 화면을 여는 대상과 허브 소유자가 일치한다. 10102 터널이 끊겼을 때 10100으로 자동 대체하지 않는다. 관리 기능이 보이지 않으면 A1의 GUI 로그인/해당 브라우저 출처별 페어링 상태를 확인하고, 운영 중인 서비스를 강제 재시작하거나 새 credentials를 복제하지 않는다.


### 2026-10-11 후속 점검: 업스트림 2.83 후보와 CLI 분리

- readback: Windows OCX CLI는 **2.77.0**, 로컬 서비스 10100·10101은 **2.81.0**, Web GPT 17841은 **2.0.0-aicc.37**. 10102의 GUI는 hub 역할을 나타내며 계정 관리에 사용한다. CLI, 허브 GUI, 실제 서비스의 버전을 하나로 추정하지 않는다.
- 공식 npm @bitkyc08/opencodex의 latest는 점검 당시 **2.83.0**. 승인된 Prepare-AiccOcxUpstream.ps1 Check는 UPDATE_AVAILABLE_COMPATIBILITY_REQUIRED와 canActivate=false를 반환했다. Prepare로 원본 2.83.0 아카이브(14,012,892 bytes)를 내려받아 SHA-512 검증했으나 **서버/CLI/허브 전환은 수행하지 않았다**.
- AICC 정본 guidance/skills/manage-upstream-assets/에 등록 프로젝트·Git 출처·직접 의존성·공식 크롤러·실행 버전 **읽기 전용 조회 스킬**을 추가했다. Owner-local inventory/upstream-assets.json은 재생성 가능한 파생 스냅샷으로, 설치 버전이나 PC 전체 현황의 유일한 정본이 아니다.
- 이번 스냅샷은 포트폴리오 등록 35항목 중 고유 ready source **6개**, 선언된 직접 의존성 **212개**, 외부 출처 원장 **37건**, 공식 문서 크롤러 **10개**를 관찰했다. 미등록 프로젝트·전체 PC 설치 프로그램·모든 비공식 크롤러까지 자동 발견했다는 뜻은 아니다.
- Bun은 OCX 공급자 전용 고정본만 계속 사용한다. WinForms 트레이/Node 수집기, PowerShell 작업 스케줄러 및 다른 프로젝트 런타임을 강제로 통일하거나 전역 Bun을 변경하지 않았다.
- 실제 최신 버전 적용의 남은 조건: 2.83.0에 대한 adapter/CLI/A1 정책 계약의 compatibility canary, exact idle/rollback, 실제 Responses 검증. AICC 전체 guidance 검사에서 기존 문서·설치본 drift가 있으면 새 스킬 단독 배포와 전역 PASS를 구분한다.

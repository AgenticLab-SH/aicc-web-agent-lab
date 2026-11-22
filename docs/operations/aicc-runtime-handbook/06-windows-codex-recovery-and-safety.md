# Windows Codex 복구와 Web GPT 안전 지침

이 문서는 원인을 구분하고 기존 작업을 보존하며 복구하는 절차다. 현재 상태는
`context/PROJECT.md`와 해당 구성요소의 현재 probe를 따른다. 대화 원문·계정·토큰·개인 경로는
owner-local archive에만 보관한다. 작업의 구체적인 승인과 도구 경계를 먼저 따른다.

## 2026-10-09 복구 사례

사용자는 Codex가 끊기고 응답하지 않는다고 보고했고, 외부 Web GPT에 RDC 우선 조사를 요청했다.
장애 조사·앱의 정상 종료는 사용자 요청 범위였다. 이 문서 작성자는 저장 대화를 읽고 설치
영수증, 보존된 잠금, 현재 프로세스·권한·서비스를 별도로 대조했다.

| 사실 | 근거와 한계 |
| --- | --- |
| 기존 Codex의 연결 대상은 로컬 17841이었다. | 현재 설정의 `openai_base_url`과 실제 실행 경로를 읽었다. |
| 유지보수에서 설치 후 서비스 시작이 실패했다. | owner-local `cdp-offline-recovery-20261009-111757/install.stdout.log`에 `installed: true`, `started: false`, `routeChanged: false`가 남아 있다. 이 영수증은 이전 `.37` 성공 기록보다 이 사건에 가깝다. |
| 시작 잠금이 남아 재기동을 막았다. | 복구 대화가 `Windows bootstrap owner is busy`를 보고한다. `windows-bootstrap.lock.stale-20261009-134255.bak`가 실제 보존돼 있다. 파일 나이만으로 stale을 판정하지 않는다. |
| Web GPT가 앱 종료 뒤 브리지를 다시 시작했다. | 대화는 프로세스 부재를 확인한 뒤 잠금을 백업하고 정식 시작 기능을 사용했다고 기록한다. 현재 같은 복구 브리지 프로세스와 `.37` 서비스 응답을 확인했다. |
| 기본 모델 요청이 다시 성공했다. | 대화는 읽기 전용 `ROUTE_OK` 응답과 exit 0을 보고한다. 현재 Codex 대화도 기본 Sol 경로로 진행된다. 가져온 API JSON의 원격 도구 결과 본문은 비어 있어 모든 원격 행동을 재현·감사한 증거로 쓰지 않는다. |
| 관리자 권한은 유지되지 않았다. | 복구 대화는 `STANDARD`로 재실행했다고 기록한다. 후속 현재 프로세스 토큰 검사에서도 Desktop, agent, 명령 터미널 모두 일반 권한이다. 관리자 이름의 바로가기 자체는 권한 증거가 아니다. |
| 브라우저 모델·OCX 자동 전환까지 완료됐다는 근거는 없다. | 대화의 최종 답변도 이를 남긴다. 현재 readiness의 browser ready와 대화 가져오기 성공은 특정 계정의 browser 모델 추론 시험을 대신하지 않는다. |

따라서 직접 확인된 장애는 **17841 서비스 부재와 재기동 잠금**이다. OCX 선택 계정의 한도와
계정 자동 전환은 별개 조사 항목이다. 세 바로가기의 존재를 직접 원인으로 단정하지 않는다.
이 사건에서 유지보수가 왜 `started: false`로 끝났는지의 더 깊은 원인은 미확정이다.

## 먼저 나누어 볼 증상

| 증상 | 확인할 것 | 해결 방향 |
| --- | --- | --- |
| `10061 / Connection refused` | 요청 URL, 해당 포트 listener와 실제 소유 프로세스 | 그 구성요소만 복구한다. 계정 전환으로 없는 listener를 고치려 하지 않는다. |
| `bootstrap owner busy` | 잠금의 소유자, 시작/유지보수 프로세스, 실제 파일 잠금, active/UNKNOWN 작업 | 소유자가 살아 있으면 유지한다. 부재가 증명된 exact 잠금만 백업 후 기존 시작 절차로 처리한다. |
| 포트는 열렸지만 `502` | 응답의 upstream 실패, 실제 data plane·인증, 요청 전달 여부 | 포트 성공과 추론 성공을 나눈다. 전달 여부가 불명확한 요청을 자동 재전송하지 않는다. |
| WebSocket `426` 후 응답 성공 | 최종 exit/응답, 지원하는 transport | 경고 한 줄만으로 전체 실패라고 판정하지 않는다. 최종 결과를 기록한다. |
| Native/OCX 모델은 되지만 Web 모델이 안 됨 | 등록 CDP·실제 ChatGPT 로그인/workspace·browser worker | 브라우저 영역만 조사한다. 프로필·로그인·다른 탭을 초기화하지 않는다. |
| 앱은 보이지만 안전 검사가 `UNKNOWN` | 실제 토큰, 조회 권한, 프로세스 image/command line | 보이지 않는 프로세스를 없는 것으로 취급하지 않는다. 필요한 권한의 읽기 검사를 사용한다. |
| 관리자 아이콘인데 명령은 일반 권한 | 앱 root → agent → shell의 실제 토큰 | 앱을 완전히 정상 종료한 뒤 관리자 실행을 선택하고 새 shell에서 다시 확인한다. |
| OCX 화면의 선택 계정이 한도에 도달함 | 서버 실제 계정·selector·현재 quota, 요청 upstream | 선택 표시·과거 캐시만으로 자동 전환 실패를 확정하지 않는다. Desktop 로그인은 별개다. |
| 공식 최신 OCX가 설치본보다 새로움 | local custom build 변경·관리형 설치/rollback 계약 | AICC fork를 stock updater로 덮어쓰지 않는다. 검토된 기존 유지보수 경로로 통합한다. |
| HTTP 200이지만 상태를 알 수 없음 | Content-Type·JSON service 식별·정식 endpoint | SPA fallback HTML은 health 증거가 아니다. dashboard HTML 전체에는 세션 값이 있을 수 있어 출력·복제하지 않는다. |

## 17841이 응답하지 않을 때

1. 사용자 증상과 최초 실패 URL을 기록한다. Native, 17841, OCX, Workspace, Chrome을 별개
   장애 영역으로 나눈다. RDC가 되면 그 경로로 읽고, 안 되면 등록 AICC 도구를 사용한다.
2. 현재 listener, process identity, `/healthz`, `/readyz`, active turn과 유지보수 소유자를
   읽는다. 설치 표시나 지난 성공 영수증만으로 현재 상태를 판단하지 않는다.
3. owner-local 설치 영수증에서 `installed`, `started`, runtime 경로, inventory hash와
   `routeChanged`를 나눠 읽는다. `installed: true`만으로 서비스 정상화를 선언하지 않는다.
4. 정식 시작에서 잠금 HOLD가 나오면 멈춘다. Desktop 종료가 필요하면 사용자 승인을
   따르고 정상 Quit을 사용한다. `X` 뒤에도 프로세스가 남을 수 있다. 강제 종료하지 않는다.
5. 잠금 소유 프로세스와 유지보수/활성 요청 부재, listener 부재, 설치 무결성과 소유권이
   증명된 경우에만 해당 잠금을 timestamp 백업으로 보존한다. exclusive-open 성공 하나만으로
   소유권이 증명되지는 않는다. PID 재사용과 다른 generation을 구분한다.
6. 현재 설치 설정에 기록된 **정식 native 실행 파일**로 한 번 시작한다. 새로운 wrapper,
   전역 runtime, 임의 포트나 fallback provider를 만들지 않는다. 실제 시작 명령은 installed
   command manifest와 기존 [Web GPT 유지보수 절차](../../../guidance/skills/manage-codex-model-routes/references/web-gpt-maintenance.md)를 따른다.
7. 사용자에게 검증까지 요청받은 범위에서는 현재 service 상태와 최소 읽기 전용 모델
   요청을 나눠 확인한다. browser 모델·도구 작업은 별도 완료 기준이다. 모델별 검사 금지
   정책이 있으면 그대로 따르고 실행하지 않은 항목을 완료라고 쓰지 않는다.
8. 정본에 변경 사항, 완료 범위, 남은 원인, 재개 조건과 다음 담당을 갱신한다. 정상 영역과
   백업, dirty checkout, 인증, 기존 대화를 보존한다. 재시도 loop·새 heartbeat를 만들지 않는다.

읽기 전용 예시:

```powershell
Get-NetTCPConnection -LocalPort 17841 -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess
Invoke-RestMethod -Uri 'http://192.0.2.1:17841/healthz' -TimeoutSec 5 |
    Select-Object status, service, version, pid, accepting_turns, active_http_turns
Invoke-RestMethod -Uri 'http://192.0.2.1:17841/readyz' -TimeoutSec 5 |
    Select-Object ready, status, active_http_turns, active_browser_turns
```

조회 권한이 부족해 결과가 비어 있으면 `UNKNOWN`으로 기록한다. 자동 설치·잠금 삭제·프로세스
종료를 수행하는 명령은 읽기 전용 예시에 섞지 않는다.

## 관리자 Codex와 세 바로가기

이 사건에서 세 아이콘은 같은 설치된 Codex의 진입점이었다. 일반 아이콘이 `ChatGPT`로
표시돼 있어도 `AppUserModelID`와 실제 target을 읽어 정체를 판정한다.

- 일반 실행: 설치된 package activation 또는 기본 앱 진입점.
- 관리자 실행: 같은 앱의 관리자 실행 요청. 기존 일반 인스턴스를 재사용하면 권한은 바뀌지
  않는다. 앱을 정상 Quit한 뒤 관리자 실행과 UAC 승인, 새 agent/shell의 토큰을 확인한다.
- OCX 실행: data-plane credential을 전달하는 legacy 진입점. 같은 앱을 쓰며 전역 모델 경로를
  자동으로 별도 격리하지 않는다. 바로가기 필요성과 OCX 서비스 필요성을 분리한다.

현재 경로가 OCX를 upstream으로 사용한다면 불필요한 OCX 아이콘을 숨길 수 있어도 서비스까지
제거하면 안 된다. 확인만 요청받았다면 제거하지 않는다. legacy launcher의 `-Restart`에
강제 종료가 있으면 사용하지 않는다.

권한은 새 명령 터미널에서 다음과 같이 읽는다:

```powershell
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
$taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

관리자 별도 PowerShell의 `true`는 그 터미널의 성공이다. 이미 실행 중인 Codex와 내장
터미널까지 관리자로 바뀌었다는 증거가 아니다.
[공식 Windows 안내](https://learn.chatgpt.com/docs/windows/windows-app)는 관리자 명령이
필요하면 앱 자체를 관리자로 시작하고 agent가 그 권한을 상속한다고 설명한다.

## Web GPT에 AGENTS.md처럼 지침을 주는 방법

일반 Web GPT에 로컬 `AGENTS.md`가 자동으로 읽힌다고 가정하지 않는다. 세 계층을 함께 쓴다.

1. **개인 맞춤 지침:** 모든 관련 일반 채팅에 적용할 짧은 Windows 안전 규칙을 기존 지침
   끝에 추가한다. 다른 계정에는 같은 문장을 별도로 저장해야 한다. 전체 개인 지침을
   정본 저장소에 복제하지 않는다.
2. **AICC Project instructions:** 프로젝트 내부와 shared/project-only 경계를 위해 안전
   문장을 이 프로젝트에도 명시한다. 기존 목적·도구·sources 지침을 보존한다. 매뉴얼 파일은
   Project Sources 또는 등록된 AICC Workspace 파일 읽기로 제공한다. 파일 첨부만으로 매번
   반드시 읽힌다고 가정하지 않는다.
3. **실행 측 차단:** Codex hook, AICC command guard, RDC blockedCommands를 각 실제 경로에
   적용한다. 지침은 명령 차단기를 대신하지 않는다. 한 경로에서 차단되면 다른 도구나
   인코딩·스크립트·stdin으로 우회하지 않는다.

[공식 Projects 안내](https://learn.chatgpt.com/docs/projects?surface=app)는 프로젝트 지침을
프로젝트 채팅 사이에서 사용하고, 로컬 폴더 접근은 별도로 연결해야 한다고 설명한다.
프로젝트 지침이 개인 맞춤 지침을 덮을 수 있으므로 중요한 안전 문장을 두 곳에 둔다.

### 개인·프로젝트 지침에 덧붙일 안전 문장

> Windows 로컬 파일 작업은 PowerShell 한 셸에서 끝내고 절대 경로와 -LiteralPath를 사용해.
> C:와 C:\를 구분해. 재귀 삭제 전에는 실제 대상이 허용된 정확한 하위 폴더인지 확인하고
> 링크·junction으로 경계를 넘지 마. 드라이브·공유 루트, 사용자 홈·작업공간 전체,
> Windows 시스템 영역 삭제와 디스크 포맷·초기화·파티션 제거·원시 디스크 덮어쓰기는
> 실행하지 마. rm -rf, CMD rd /s·del /s, 다른 셸로 넘기는 삭제는 사용하지 마.
> 차단된 명령을 인코딩·스크립트·다른 도구·대화형 입력으로 우회하지 마. 대신 안전한 명시적
> 하위 경로/수단으로 계속 처리해. 정상 읽기·편집·Git·빌드·배포·범위가 명확한 정리는
> 추가 승인 없이 진행해. 복구는 정본 매뉴얼과 실제 상태부터 읽고 잠금 소유자·작업 부재가
> 증명될 때만 잠금을 백업해. 설치, 서비스, 실제 모델/도구 성공을 나눠 보고해.

### 2026-10-09 적용·미적용 경계

현재 복구 대화를 사용한 로그인 계정의 개인 맞춤 지침에 안전 문장을 추가했고, 새로 열린
편집 화면에서도 내용을 확인했다. 기존 지침과 개인 설정은 보존했다. 기존 AICC 운영·복구 센터 프로젝트에도 같은 안전 규칙과 정본 매뉴얼/현재 기록을 먼저 읽으라는 지침을 추가했다. 프로젝트의 기존 1,433자 지침을 보존한 2,146자를 저장하고 편집창을 다시 열어 exact match를 확인했다. 다른 계정의 개인 맞춤 지침까지 적용된 것으로 확대하지 않는다. RDC는 기존 차단 목록을
보존하고 `clear-disk`, `initialize-disk`, `remove-partition`, `remove-volume`, `format-volume`,
`wipefs`, `blkdiscard`를 추가했다. 설정 readback으로 저장을 확인했다. 위험 명령을 실제
실행하는 시험은 하지 않았다.

AICC source에는 `destructive-command-guard.mjs`와 command dispatch 호출이 있지만, 이 시점의
installed Workspace server에는 없다. 따라서 **AICC 모든 명령의 강제 차단이 이미 배포됐다고
말할 수 없다.** native tool/파일 API, 중첩 스크립트, 다른 원격 도구까지 RDC의 command-name
목록이 감싼다고 주장하지 않는다. 현재 요청이 있는 서비스는 재시작하지 않는다. 안전한
component-only 설치와 기존 규칙의 적용 범위를 확인하는 일은 정본 HOLD에 남긴다.

AICC 도구의 local-machine 별칭에서 src/open-AICC/docs/operations/aicc-runtime-handbook/06-windows-codex-recovery-and-safety.md를 실제 읽어 조회 가능함을 확인했다. open-aicc 별칭은 다른 체크아웃을 가리키므로 이 문서와 현재 기록을 읽을 때 위 exact 경로를 사용한다. 등록 루트와 서비스는 변경하지 않았다.


## OCX 업데이트와 공식 원본의 독립성: 2026-10-09

관리자 바로가기로 다시 연 뒤 Desktop, app-server, agent PowerShell 토큰은 모두 ELEVATED였다.
이것으로 앞선 관리자 재실행의 확인 대기를 닫는다. 별도 관리자 터미널 성공과 구분해 기록했다.

이 시점의 실제 로컬 OCX는 `2.77.0-aicc.local.3`였고 npm latest는 `2.81.0`였다.
실제 `/api/update/check`가 두 버전을 함께 반환하면서 `updateAvailable: false`,
`reason: already_latest`를 반환했다. 이는 최신 상태 증명이 아니다. 기본 stable/preview
비교가 `-aicc.*`를 해석하지 못하는 경우다. 사용자 화면의 `aicc.windows.2` 표기도
현재 실행 registry/ready 응답의 `aicc.local.3`와 구분한다.

커스텀에는 A1 단독 credential writer, Windows-local 요청, 계정 선택, 창별 한도와
in-flight 중단 정책, loopback 데이터 인증이 들어 있다. 따라서 순정 npm 전역 업데이트가
이 코드를 대체하도록 하면 기능 소유권이 섞인다. 커스텀이라는 사실만으로 현재 동작이
잘못됐다고 단정하지 않지만, 현재 구조의 일반 원클릭 업그레이드는 사용할 수 없다.

### 외부 업데이트 경로

정본의 `Prepare-AiccOcxUpstream.ps1`는 커스텀 suffix와 실제 upstream base version을
나눠 판단하고 공식 npm registry의 정확한 stable artifact만 별도 저장하도록 구현했다.
`Invoke-AiccOcxUpdate.ps1`의 managed-local 분기는 이 준비 경로로 연결했다.

```powershell
# 현재 upstream base와 공식 최신 버전 비교. 서비스/계정 변경 없음.
aicc-ocx-update.ps1 -Check

# 정확한 공식 패키지를 별도 저장. 현재 서비스 교체/재시작 없음.
aicc-ocx-update.ps1 -TargetVersion 2.81.0
```

보관 위치는 기존 OCX software namespace의
`opencodex-native/registry-artifacts/<version>/<sha512-prefix>`다.
공식 archive와 integrity 영수증만 보관하며 package source, 기존 전역 설치, live fork,
OCX account home, Native, Web GPT, A1 service를 덮거나 stock install script를 실행하지 않는다.
기존 artifact가 다르거나 경로가 junction이면 덮지 않고 진단 대상으로 보존한다.

구현 전에 공식 2.81.0 archive를 받아 npm SHA512 integrity와 일치함을 확인했다.
이는 순정 파일 확보의 증거이며 dependency 설치, runtime activation, migration 성공의 증거가
아니다. 업데이트 코드 변경 후 실행/테스트/빌드는 **검증 미실행**이다. 기존 GUI의 잘못된
버전 표시는 이 source 변경만으로 바뀌지 않는다.

### 순정 런타임 전환의 남은 조건

공식 OCX 본체/GUI/버전 파일은 그대로 두고 AICC 동작은 외부 adapter/service에서 소유해야 한다.
A1 credential writer와 Native 격리, Windows-local inference, 계정·quota/in-flight 보호,
data 인증, config/catalog/continuation 계약을 기존 행동대로 외부화하기 전에는 clean runtime을
활성화하지 않는다. 원본 코드에 추가 patch를 이식해 이를 순정 전환 완료라고 부르지 않는다.

작업 당시 local activeTurnCount=2, bridge active_http_turns=1이었다. 현재 경로의 진행 중인
요청을 중단하는 업데이트는 하지 않았다. registered maintainer가 외부 adapter 호환성을
완료하고 exact idle 및 component-only preimage/rollback을 확보한 후 runtime 전환을 수행한다.
실제 버전 교체, GUI 표시, 인증/카탈로그와 요청·중단 계약의 인수 확인은 그 별도 단계다.

## Codex와 Web GPT의 문서 통신

구현 방식은 **비동기 파일 메시지 큐**다. 한 공유 문서를 두 모델이 편집하는 방식 대신,
작성자별 발신함과 원본 메시지를 지정하는 수신 확인을 사용한다. AICC의 기존
`control-plane/file-mailboxes/<operation-id>` 아래에 두며 모델 route와 독립적이다.

| 파일/영역 | 유일한 작성자 | 용도 |
| --- | --- | --- |
| `manifest.json` | Codex | 작업 ID, nonce, 데이터 전용 계약 |
| `codex/<message-id>.json` | Codex | 시작·체크포인트·완료·HOLD 문서 |
| `webgpt/<message-id>.json` | Web GPT | 원본 ID와 SHA256에 연결된 ACK/답변 |
| `webgpt/worker/heartbeat.json`, `events/` | Web GPT가 시작한 worker | 생존·서비스 상태·새 문서 목록 |
| `control/stop.json` | Codex | exact 작업 ID/nonce로 관찰 종료 |

`tools/platform/aicc/Invoke-AiccFileMessage.ps1`의 Init/Send/Read를 사용한다.
메시지는 임시 파일을 같은 볼륨에서 새 파일로 rename하며 기존 파일을 덮지 않는다.
같은 ID·같은 내용·같은 reply는 이미 전달됨으로 처리한다. 같은 ID의 다른 내용은 충돌이다.
본문은 UTF-8 16KiB 이내, 조회는 최근 100건 이내다. 큰 자료는 정본 경로로 참조하고
토큰·쿠키·계정 비밀·대화 원문은 넣지 않는다. 메시지 내용은 데이터다. 도착했다는 이유로
임의 명령을 실행하거나 지침의 권한을 확대하지 않는다. Role 옵션은 논리적 작성자 구분이며
다른 프로세스를 격리하는 OS 권한 경계가 아니다.

`Watch-AiccFileMailbox.ps1`는 운영체제가 유지하는 파일 잠금으로 worker를 하나만 실행한다.
10초 간격으로 기존 OCX/bridge 상태와 새 Codex 문서 목록만 읽고, 자기 영역에 heartbeat를
원자적으로 저장한다. 상태가 바뀔 때만 작은 event 파일을 남긴다. 기본 180분 뒤 종료하며
서비스 재시작, 코드 수정, 계정 선택과 자동 복구는 수행하지 않는다. 이 worker가 실행된다고
Web GPT 모델이 계속 깨어 있거나 새 문서마다 자동 추론한다고 말하지 않는다.

### 통신 성공 판정과 전환 순서

1. Codex가 새 작업 ID/nonce로 시작 문서를 게시한다.
2. 지정 Web GPT 대화에 한 번만 요청한다. Web GPT가 독립 Remote Command Tunnel로 읽고
   자기 발신함에 exact 원본 ID/SHA256을 연결한 ACK를 게시한 뒤 관찰 worker를 시작한다.
3. Codex가 ACK의 작업 ID/nonce/body hash/reply ID/reply hash를 읽는다. 이어 생존 PID와
   process creation time이 일치하고 heartbeat가 최신인지 확인한다. 채팅 문장만으로 완료하지 않는다.
4. 위험한 전환의 복구 standby는 별도 단계다. 해시로 고정한 실제 rollback 캡슐과
   `webgpt-remote-recovery-standby`의 READY_STANDBY 조건을 충족해야 한다. 관찰용
   MONITORING을 rollback 준비 완료로 바꾸어 해석하지 않는다.
5. 외부 AICC adapter의 기존 계약, exact idle, 변경 전 파일/hash와 복구 범위를 확보한 뒤
   OCX 구성요소만 전환한다. A1, Native, bridge와 Workspace를 함께 유지보수하지 않는다.

| 관찰된 문제 | 판단과 다음 행동 |
| --- | --- |
| 웹 화면은 응답 중인데 ACK가 없음 | 전송됐지만 문서 통신은 아직 성공하지 않음. 같은 요청을 다시 보내지 않고 원본 대화에서 결과 회수 |
| ACK는 있으나 heartbeat가 없거나 오래됨 | 수신 확인과 감시 실행을 구분. standby 미준비로 runtime 전환 보류 |
| 같은 메시지 ID의 내용이 다름 | 덮지 않고 충돌 기록. 새 ID로 원본을 참조하여 정정 |
| worker 시작 요청의 결과가 불명확함 | heartbeat/잠금 소유자를 읽기 전 재시작 금지 |
| 공식 패키지와 의존성만 준비됨 | 설치 후보이며 실제 서비스 업데이트 완료가 아님 |
| 순정 package version만 바꾸거나 로딩 중 patch를 이식함 | 원본 독립성 증명이 아님. AICC 기능은 외부 adapter 계약으로 소유 |
| 원격 CLI가 `UnauthorizedAccess`로 시작되지 않음 | 원격 도구가 실제로 쓰는 PowerShell의 `Get-ExecutionPolicy -List`를 읽는다. 관리자 여부와 실행 정책은 별개다. 정책 변경이 필요한 경우 범위·기존 값·복원 방법을 제시하고 승인받는다. Bypass·인코딩·다른 셸로 차단을 우회하지 않는다 |
| 본문 ACK 파일만 있고 envelope JSON이 없음 | 웹 모델의 파일 접근은 확인됐지만 큐 게시·reply hash·감시 생존은 확인되지 않았다. Codex가 Web GPT 작성자로 대신 게시하거나 ACK를 꾸미지 않는다 |
| 기존 복구 대화에 최대 길이 안내가 나타남 | 새 메시지를 더 받을 수 있는 대화로 간주하지 않는다. 수신 결과를 회수하고 기존 기록을 보존한다. 일반 문서 소통 대화의 교체와 위험 변경용 exact 복구 캡슐의 재등록을 구분한다. 옛 READY/nonce를 새 대화에 재사용하지 않는다 |

### 순정 패키지와 외부 어댑터의 인수 경계

`external-broker-transport.ts`는 기존 A1 broker 경로만 사용한다. 인증 갱신 권한을
Windows에 복제하지 않는다. `external-stock-dispatch.ts`는 공식 package identity를 고정하고
공식 parser·passthrough를 읽기 전용으로 호출한다. native compaction은 별도 endpoint로
전송하며 물리 요청을 자동 재전송하지 않는다. 공개 API가 아닌 read-only import도
명시적인 버전 호환 의존성이다. 다음 upstream 버전에 자동으로 승인됐다고 해석하지 않는다.

`external-pool-state.ts`와 `external-runtime.ts`는 연결 구현 후보다. 계정별 fresh quota,
entitlement, pause/pin/priority와 선택 상태를 다루되, issuer를 모르는 계정 종속 입력은
전송하지 않는다. GUI 관리 API, WebSocket, 기존 대화의 이전 issuer와 전체 catalog 의미를
기존 동작과 대조하여 인수해야 한다. 구현 후보에 일부 보호 장치가 있다는 이유로
호환성이 완료된 것은 아니다. 이 항목 중 하나라도 미완료이면 실행 중인 fork를 교체하지 않는다.

release manifest는 공식 supplier version과 AICC adapter version을 따로 기록한다.
`compatibility-acceptance.json`의 모든 필수 항목에 실제 PASS 근거가 있어야 composition root가
시작할 수 있다. 근거 없는 PASS 파일을 생성하거나 기존 release hash를 고쳐 우회하지 않는다.

이 경로는 실험 구현이며 자동 명령 실행 또는 범용 에이전트 버스로 배포된 것이 아니다.
실제 ACK·worker·OCX 전환의 현재 결과는 기존 `context/PROJECT.md`에서만 관리한다.


## 압축 요청 장애와 외부 어댑터 교체: 2026-10-10

공식 OCX 2.81.0과 AICC 외부 어댑터 0.1.0 전환은 실제 적용됐지만, 어댑터가 Codex의
`Content-Encoding: zstd`를 일반 UTF-8 JSON으로 읽어 503을 반환했다. 공급자 본체를
수정하지 않고 `external-request-body.ts`에서 압축·해제 후 각각 32 MiB 제한을 적용한다.
해제는 작은 스트리밍 청크로 처리하며 zstd window도 제한한다. 잘못된 압축·JSON은
계정 선택/추론 전 거절하고 재전송하지 않는다. 계정 선택 뒤 재직렬화한 JSON에는
기존 `content-encoding`과 길이 헤더를 남기지 않는다.

기존 관리 호출자의 `x-opencodex-api-key`는 관리 토큰 검사에서만 허용한다. 데이터 요청은
Bearer를 계속 요구하고, 명시적으로 잘못된 Bearer가 있으면 다른 헤더로 우회하지 않는다.
공급자와 AICC 버전은 계속 분리한다. 새 어댑터 0.1.1은 두 호환성 검사까지 포함한 새
immutable release다. 과거 0.1.0 파일/manifest와 기존 계정·Native 설정을 덮지 않는다.

OCX로 추론 중인 현재 Codex 턴에서 OCX를 직접 전환하면 같은 대화의 다음 요청이 실패할 수
있다. `Wait-AiccOcxTransition.ps1`의 대기만으로 이 실행 경계가 분리되지는 않는다. 앞으로
OCX 전환은 기존 공식 Native 복구 실행기를 사용하고, 실행 계보와 소켓에서 17841/10100을
사용하지 않는지 확인한다. 새 software-only snapshot의 Native config fingerprint와 기존
명시 승인을 정확히 묶어 서비스 중지 전에 검사한다. 오래된 snapshot으로 재시도하지 않는다.
현재 살아 있는 0.1.1 서비스와 네 계획 파일이 이미 일치하면 Activate·restart·rollback을
재실행하지 않고 남은 설치 경로 요청 검증만 완료한다. 실패 영수증을 PASS로 고치지 않는다.
`features.enable_request_compression=false` 복구 설정은 현재 Desktop에서 보존한다.
어댑터 압축 검사 통과와 재시작된 Desktop의 실제 압축 turn 성공은 별도 증거다.
운영 연결이 복구됐다는 이유로 사용자 작업 중 앱을 종료하거나 설정을 몰래 바꾸지 않는다.

기존 문서 observer 재시작은 확인됐지만 새 ACK 파일 쓰기는 OpenAI 안전 검사에서
차단됐다. 차단된 쓰기를 다른 셸/도구로 재시도하거나 Codex가 Web GPT ACK를 대신
작성하지 않는다. 실제 수신 메모·observer 생존·envelope ACK·자동복구 standby를 구분한다.

## 설치본에 명령 차단기를 반영하는 좁은 경로

`Prepare-AiccWorkspaceCommandGuard.ps1`는 현재 설치본을 바탕으로 Workspace 서버의
`startCommand` 앞에 기존 `assertSafeWorkspaceCommand`만 연결한다. 전체 dirty source를
배포하지 않는다. 별도 고정 backend/gateway와 파일 해시를 준비하고, 기존
`Move-AiccWorkspaceHome.ps1`의 exact owner/idle/rollback 계약으로 한 Workspace 경로만
교체한다. 기존 native provider와 helper 코드는 보존한다. 실행 여부와 실제 installed
검사는 정본의 현재 영수증으로 판정한다. 이 검사는 명령 입력의 치명적 작업을 제한하며
다른 원격 도구·파일 API·임의 중첩 프로그램 전체를 감싸는 OS 경계가 아니다.
Workspace overlay에는 새 import 파일을 `WORKSPACE_MCP_RUNTIME_SOURCES`에도 등록하고,
release inventory와 provider pin을 함께 갱신한다. gateway의 `entrypoint`, `args[0]`,
pinned files가 같은 경로를 가리켜야 한다. 한 항목이라도 어긋나면 중지 전에 거절한다.
설치는 기존 공식 Native 실행기에 한 번의 명령만 맡기고 담당자는 바꾸지 않는다. 새 모델
경로·담당 채팅을 만들지 않는다. 명확한 실패 뒤 원복을 확인한 경우에만 원인을 수정한 새
후보를 준비하며, 불명확한 설치 결과를 자동 재실행하지 않는다.

## Chrome 제어 시간초과 뒤 같은 작업 재개

공식 Chrome 확장은 일반 CDP 명령이 제한 시간 안에 끝나지 않으면 탭의 debugger 연결을
해제할 수 있다. `Emulation.setFocusEmulationEnabled` 또는 `DOM.getContentQuads`의 시간초과는
실패한 명령의 증거이며, 사용자 동시 사용·탭 개수·시스템 자원이 최초 원인이라는 증거는 아니다.
다른 작업의 IAB pipe를 탐색하며 발생한 경로 오류도 실제 Chrome 연결 실패와 구분한다.
같은 요청의 경로 조회 성공과 실패가 함께 있다면 실패 건수만으로 대화 경로 유실을 단정하지 않는다.

현재 복구 절차는 공급자 코드 수정이나 서비스 재시작을 필요로 하지 않는다.

1. 지원되는 Browser/Chrome API로 현재 inventory를 한 번 읽는다. 같은 browser가 보이면 기존
   browser binding을 유지한다. 탭 ID는 대화 ID와 다르므로 과거 ID를 반복 호출하지 않는다.
2. 사용자가 지정한 같은 저장 대화 URL이 현재 inventory의 새 탭 ID에 있으면 그 탭에 연결한다.
   실제 로그인·workspace·모델과 기존 user/assistant turn을 읽는다. 다른 사용자 탭이나 새 대화를
   만들어 복구했다고 판단하지 않는다. 연결 실패 시 문서화된 제한된 복구만 수행한다.
3. composer 입력 API가 성공을 반환해도 실제 내용이 비어 있으면 보내지 않는다. 현재 화면을
   읽고, 문서화된 붙여넣기 등 지원되는 입력 방법을 사용한다. 실제 입력과 보내기 활성 상태가
   확인된 경우에만 한 번 전송한다. 제출 결과가 불명확하면 재전송하지 않는다.
4. 새 user turn 뒤의 정확한 assistant 응답, 완료 표시와 필요한 결과를 회수한다. 원래 요청이
   읽기 전용 수신 확인이면 Observer 설치나 추론 서비스 idle을 선행 조건으로 추가하지 않는다.
   파일-envelope ACK와 위험 전환의 READY_STANDBY는 일반 채팅 수신 확인으로 대체하지 않는다.
5. 시간초과 뒤 fresh binding에서 실제 작업이 끝났다는 결과는 운영 복구다. 최초 지연의 원인
   수정이나 영구 안정성은 별도 근거가 필요하다. 공식 업데이트가 없으면 공급자 확장·native host를
   임의 패치하거나 제어·승인 보호를 완화하지 않는다. 기존 작업과 정상 서비스를 보존한다.

현재 장애와 실제 수신 영수증은 기존 `context/PROJECT.md` 한 곳에 갱신한다. 거절된 파일 ACK나
숨은 자동복구 실행을 다른 도구로 재시도하지 않는다. 실제 서비스 전환이 필요할 때만 기존 독립
공식 Native/수동 복구 경로와 새 소유권·idle·승인 snapshot·rollback 조건을 사용한다.

# Web GPT·압축·Tunnel

> 2026-10-09 후속 사고: 유지보수 설치 영수증의 started=false와 남은 bootstrap 잠금이 확인됐다.
> 외부 Web GPT가 정상 Quit 이후 exact 잠금을 보존하고 브리지를 시작해 기본 모델 경로를 복구했다.
> [복구 사례·안전 절차](06-windows-codex-recovery-and-safety.md)를 먼저 읽고 아래 날짜별 성공 기록과 구분한다.


> 2026-10-04 23:20 KST 현재 실행본은 `.36`/Bun1.4.0, Web 모델은 두 계정 16개다.
> 두 계정의 새 대화 응답을 확인했다. 정상 진행의 화면·페이지 저장을 없앴고 관련 검사211개가 통과했다.
> 일부 준비 시간이 줄었지만 전체 속도 개선은 입증되지 않았다. 새 대화의 하위 에이전트 호출은 미완료다.
> 승인된 기본 모델은 OCX10101을 거치며 기존 Native 기록의 실제 이어쓰기 시험을 통과했다.
> 아래의 19개 후보·Bun1.3.14 장애 기록은 이전 진단이다. 최신 검증과 남은 제한은
> [사용 설명서](../../user-guide.md#7-웹-모델-선택과-양방향-작업)와 `context/PROJECT.md`를 따른다.

## 17841의 책임

### 제어 비밀의 소비자와 교체 경계

공개 core에서 확인한 소비자는 다음과 같다. 값·원문 config·개인 경로는 기록하지 않는다.

| 소비자 | 읽는 권위와 용도 | 교체 시 보존할 경계 |
|---|---|---|
| `Complete-WebGptFullSetup.mjs` | 해당 bridge의 현재 config에서 controlToken을 읽어 idle/drain/resume 호출 | 원래 config와 소비자·실행본 핀을 함께 대조. 토큰만 먼저 바꾸지 않음 |
| `src/web-gpt-rescue.mjs` | 독립 rescue config의 controlToken으로 해당 rescue의 admin 호출 | 17841 기본 bridge와 rescue 비밀은 별개. 한쪽 교체를 다른 쪽 성공으로 해석하지 않음 |
| `Invoke-AiccRemoteRecovery*.ps1` | 등록 장치의 exact 작업·복구 계약과 artifact 핀 | 기존 등록·일회 신호·백업을 보존. 비밀을 명령 출력이나 작업 보고로 전달하지 않음 |
| Workspace Tunnel secret 소비자 | 등록 surface의 DPAPI 저장·해당 owner 실행 | bridge controlToken과 별개. 기존 [Tunnel secret 계약](04-workspace-mcp-and-chatgpt-apps.md)을 사용 |

이 표는 공개 core의 소스 소비자 정합 범위다. private adapter와 설치된 소비자의 현재 핀까지
대조했다는 뜻은 아니다. 실제 controlToken 교체는 독립 복구 READY, fresh exact-idle,
현재 소비자 전체의 CAS·rollback이 갖춰진 해당 작업에서만 진행한다. 현재 제어 대화가
사용하는 bridge·OCX·Workspace를 소스 편집과 함께 재시작하지 않는다.

### 관제 UI 적용과 모델 경로의 분리

관제 UI는 기존 `control-plane/mobile-control.json`의 `localUrl`을 읽는다. 옛 component
registry URL이나 고정 포트를 현재 실행 주소로 가정하지 않는다. 트레이 준비 빌드는
runtime 교체가 아니다. 인증된 서버가 `/api/mobile/supervise`에 405를 반환하면 현재
실행본의 API 미제공으로 기록하고, 등록된 제공판을 정상 적용하기 전까지 실사용을 HOLD한다.
접근 거절이나 미제공을 다른 계정·provider·listener로 우회하지 않는다.

17841은 Codex가 선택한 `chatgpt-web/*` 모델을 ChatGPT browser worker로 보내는 Responses
router다. 다른 모델은 설정된 upstream으로 전달한다. `nativeUpstreamBaseUrl`이 없으면 공식
Codex endpoint이며, OCX는 명시적으로 설정했을 때만 사용한다. Codex Desktop browser와 17841 listener는
같은 프로세스일 필요가 없으며, Desktop만 종료해도 router를 유지할 수 있다.

## remote compaction 404

Codex는 `POST /v1/responses/compact`를 호출한다. 404는 네트워크 불안정이 아니라 현재
listener가 그 contract를 제공하지 않는다는 결정적 신호다. 흔한 원인은 다음과 같다.

- 구형 bridge가 17841을 점유함
- MCP·serve·tunnel-client가 서로 다른 bundle/version임
- 새 소스는 설치됐지만 실행 중인 listener는 이전 bytes임
- stale broker socket/session이 이전 프로세스 identity를 유지함

수정 뒤에는 version 문자열만 보지 않고 exact bundle hash, listener PID, integration journal,
`remote_compaction_v2` capability를 함께 검증한다. 그 다음 v2 canary와 legacy v1 adapter
canary를 각각 정확히 한 번 실행한다. 실패 또는 응답 불확실성은 blind retry하지 않는다.

## 브리지와 Tunnel 복구

1. Desktop, 17841/17842 counters, browser target, Workspace lease의 exact idle을 증명한다.
2. serve, MCP, tunnel-client의 version·bundle identity를 비교한다.
3. stale socket은 소유 프로세스가 없고 rollback이 준비된 경우에만 교체한다.
4. router, browser, harness Tunnel을 한꺼번에 재시작하지 않는다. 실패 domain별로 한 번씩
   전환하고 post-state를 기록한다.
5. Tunnel restart budget이 소진되면 원인을 고친 뒤 명시적 restart 한 번으로 rearm한다.

ChatGPT가 먼저 열렸다는 사실만으로 Tunnel loop가 발생하지 않는다. 준비되지 않은 local
runtime, 잘못된 profile binding, stale version 혼재나 소유권 충돌을 health record에서 확인해야
한다.

## upstream과 private fork

upstream 업데이트는 자동 설치 권한이 아니다. 현재 private adapter의 route, compaction,
account identity와 recovery contract를 기준으로 patch 단위로 비교한다. 이미 반영된 contract를
낡은 대화 조언만 보고 다시 구현하지 않는다.

## Desktop 모델 선택과 웹 GPT 연결

원하는 흐름은 다음과 같다.

```text
Desktop 모델 선택
  -> Responses router
       -> 기본 모델: OCX 계정 풀(기존 Native 로그인·기록 보존)
       -> Web 모델: 로그인된 ChatGPT Web
                       -> Secure MCP Tunnel
                            -> 현재 Codex 작업의 도구와 승인
```

MCP는 도구 연결이며 모델 provider를 대신하지 않는다. Desktop의 모델 선택으로 웹 GPT를
사용하려면 Responses adapter, 모델 카탈로그, 현재 작업에 묶인 MCP 도구가 함께 필요하다.
공식 [설정 문서](https://learn.chatgpt.com/docs/config-file/config-reference)는 custom provider의
`base_url`, `wire_api = "responses"`, `model_catalog_json`을 정의한다. Provider를 정의하는 것만으로
모든 provider의 모델이 하나의 선택기에 자동 합쳐지는 것은 아니다.

2026-10-04 KST 검증에서 공식 Native 목록 11개와 Web 목록 8개를 합친 후보를 설치된 Codex
0.160.0의 `model/list`가 모두 반환했다. 같은 router를 통한 기본 `gpt-6.1-sol`의 작은 도구 없는
응답도 성공했다. 기존 사용자 설정은 보존했다. 이 결과는 backend 목록과 기본 모델 통신의
검증이며, Desktop 화면에서 선택하거나 자동 재개한 결과가 아니다.

후속 조회 중 설치된 Bun 1.3.14 실행기가 segmentation fault로 종료됐다. 원래 설치본의
정확한 부재를 확인하고 한 번 시작해 ready 상태와 모델 목록 19개를 다시 검증했다.
재전송이나 설정 교체는 없었다. 복구 성공과 종료 원인 해결은 구분하며, 원인 진단과
장시간 안정성 확인도 Desktop 적용 전 남은 조건이다.

후속 공개 원본 조사에서 같은 Bun 1.3.14 Windows 종료 유형의
[issue #86](https://github.com/miuuyy/codex-chatgpt-web/issues/86#issuecomment-5381185232)을 확인했다.
Maintainer는 v3.0.0에서 Bun 1.4.0을 묶어 재검증한 뒤 해결 처리했다. 현재 upstream의 release
workflow도 Bun 1.4.0을 사용하지만 AICC 설치본은 1.3.14다. 이는 runtime 갱신을 우선 검증할
강한 근거이며, 로컬 종료의 정확한 원인을 확정하거나 AICC에서도 해결됐다는 증거는 아니다.
별도 후보 bundle에서 같은 소스와 새 runtime의 중단·stream·동시 작업 검증을 먼저 수행한다.
공유 Bun, OCX, 등록된 Chrome과 Native 설정을 같이 교체하지 않는다.

현재 router의 고정된 이전 카탈로그에는 최신 Native 모델이 빠져 있었다. 통합 설치 전에는
공식 Native 목록을 갱신하고 Web 항목만 추가해야 한다. 후보 파일을 영구 고정해 두지 않는다.
기본 모델을 Web 모델로 바꾸거나 전체 요청을 OCX로 보내는 암묵적 전환은 하지 않는다.

### 구현할 연결 계약

1. 기본 모델은 Native 모델군·인증을 보존하고 승인된 upstream을 사용한다. Web 모델만 명시적으로
   로그인된 계정에 묶는다. 모델 이름, effort와 실제 사용 계정을 결과 상태에서 확인한다.
2. 카탈로그는 공식 목록에 계정에서 실제 확인한 Web 항목만 추가한다. 사용할 수 없는 모델은
   숨기거나 거절한다. 오래된 OCX 목록이 Native 목록을 덮어쓰지 않게 한다.
3. Desktop 작업 ID와 Web 대화를 묶고, Tunnel은 현재 작업의 도구와 승인만 전달한다.
   외부 ChatGPT용 Workspace MCP와 인증·프로세스·복구를 분리한다.
4. 전송 후 응답이 불명확하면 같은 작업을 조회해 이어받는다. 새 대화로 재전송하지 않는다.
   동일 Native 프로세스 재개 실패는 보존하고, 새 프로세스 재개 성공과 구분한다.
5. 연결 해제는 이번 설치가 소유한 설정만 원복한다. 사용자 수정과 기존 대화를 보존한다.
6. 최종 완료는 Desktop 실제 목록·선택·파일 읽기/쓰기·압축 후 이어가기·앱 재실행 후 재개를
   확인해야 한다. 현재 backend probe만으로 이 단계를 완료 처리하지 않는다.

## 공개 프로젝트 비교 — 2026-10-04 KST

스타는 같은 시점의 GitHub API 조회값이며 변할 수 있다. 평가는 공개 소스·문서·설치 릴리스·
자동 검사 구조에 따른 용도 적합성이다. 다른 제품을 이 PC에 설치해 동일 과제로 속도나
결과 품질을 측정한 순위는 아니다.

| 프로젝트 | 스타 | 용도와 완성도 판단 | Desktop Web provider 용도 |
|---|---:|---|---|
| [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) | 13,316 | 모델 선택·Responses·MCP 도구·압축·설치/업데이트를 함께 제공. v6.1.4에 Windows 패키지가 있다. 이 목적의 우선 후보 | 직접 맞음. 현재 AICC 확장의 원본. 최신 upstream 자동 덮어쓰기는 별도 검증 필요 |
| [Waishnav/devspace](https://github.com/Waishnav/devspace) | 5,179 | Web ChatGPT 등에 파일·터미널·작업 도구를 붙이는 간결한 MCP 개발 환경. v1.0.8 | 도구 쪽 기반. 별도 Responses adapter 필요 |
| [totec448-spec/chat-on-steroids](https://github.com/totec448-spec/chat-on-steroids) | 4,231 | CoS 정본 후보. Electron·Chrome 확장·작업·workers·Compact & Resume를 제공하고 3개 OS의 CI가 있다. v2.1.26 | Web ChatGPT를 자체 작업 앱으로 사용. 원본 Codex의 모델 provider와는 다름 |
| [steipete/oracle](https://github.com/steipete/oracle) | 4,038 | 파일을 묶어 다른 모델에 검토를 요청하는 CLI/MCP. Browser와 API 경로 및 세션 보존 제공 | 검토 보조에 적합. 기본 모델 교체용이 아님 |
| [uvwt/agentdock](https://github.com/uvwt/agentdock) | 1,154 | 파일·명령·Git·복구 작업·다중 장비의 MCP 실행 기반. v0.9.1에 Windows 설치본이 있다 | 여러 장비의 도구 기반. 모델 추론은 제공하지 않음 |
| [adamallcock/codex-chatgpt-control](https://github.com/adamallcock/codex-chatgpt-control) | 406 | 보이는 Chat/Work에 요청·대기·결과 회수를 위임하는 alpha SDK와 Codex 플러그인 | 필요할 때 Web GPT에 검토를 맡기는 보조 경로 |
| [ventianima-lab/codex-web-gpt-automation](https://github.com/ventianima-lab/codex-web-gpt-automation) | 51 | Oracle + DevSpace의 작업 전달·동일 세션 복구·결과 확인을 묶은 Windows/macOS 운영 패키지. v2.0.1 | 작업 위임 방식. 모델 선택기 직결은 아님 |
| [guberm/chatgpt-web-provider](https://github.com/guberm/chatgpt-web-provider) | 9 | Browser 기반 API facade. README가 Responses streaming과 로컬 도구 loop 미구현을 명시 | 현재 Codex 작업용으로 우선 선택하지 않음 |
| AICC Web GPT adapter + Workspace MCP | 비교 불가 | 현재 설치에서 두 계정의 파일 읽기/쓰기·새 Native 프로세스 재개, 50-tool 계약, guarded Workspace 쓰기 검증 | backend 목록 19개 검증. Desktop 적용·자동 재개·runtime 비정상 종료 원인·전체 source gate는 미완료 |

동명이인 [AgentDock/AgentDock](https://github.com/AgentDock/AgentDock)는 framework가 종료됐다고
명시한다. 위 표의 `uvwt/agentdock`과 혼동하지 않는다. CoS README도 Codex를 직접 호출하는
서비스가 아니라 ChatGPT 대화를 사용한다고 설명한다.

권고는 Desktop 연결에 기존 AICC adapter를 유지하면서 upstream의 설치·업데이트·UI 개선을
작은 변경으로 검토하는 것이다. Web 작업 앱의 UX는 CoS, 다중 장비 운영은 AgentDock,
간결한 MCP 개발 환경은 DevSpace를 비교 기준으로 삼는다. 새로운 MCP 제어 서비스를
중복으로 만들기보다 기존 현재-task harness와 Workspace MCP의 분리 계약을 보완한다.

공개 CI와 실제 로그인 검증은 별개다. Upstream도
[release validation](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/release-validation.md)에서
계정·MCP·완전한 Codex turn은 CI만으로 증명할 수 없다고 명시한다. AICC의 전체 source gate
실패와 Desktop 재개 실패를 다른 제품의 스타나 CI 성공으로 해결됐다고 간주하지 않는다.

### 추가 심층 판단

추천의 핵심은 기존 Desktop 모델 선택·Responses 변환·현재-task MCP·압축·설치 원복을
하나의 구현으로 제공한다는 점이다. `src/codex-integration-route.ts`는 설치 후 사용자가 바꾼
설정을 발견하면 덮어쓰지 않는 소유권 검사를 갖고 있다. 최근 v6.1.4 release는 중단, 반복
응답, follow-up plugin 선택, 시스템 proxy를 사용하는 업데이트를 보완한다.

안정성 평가는 별도로 남긴다. 최신 버전에도 terminal network error 뒤 browser turn이
끝나지 않는 [#760](https://github.com/miuuyy/codex-chatgpt-web/issues/760), 압축 이후 살아 있는
작업이 timeout으로 중단된다는 [#731](https://github.com/miuuyy/codex-chatgpt-web/issues/731)
보고가 열려 있다. 사용자 보고이며 이 PC에서 재현한 결과는 아니다. 같은 과제의 여러
제품 비교 실행도 하지 않았다. 따라서 결론은 이 목적에 가장 적합한 기반이라는 판단이며,
장시간 무중단 동작이나 모든 제품 중 절대적인 품질 1위를 증명했다는 주장은 아니다.

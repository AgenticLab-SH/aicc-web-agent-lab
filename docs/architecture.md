# AICC 구조

```text
Codex Desktop -> Web GPT bridge 17841 -> ChatGPT Web (Web 모델 추론)
                 |                         |
                 |                         \-> Web GPT 작업 하네스 전용 Tunnel
                 |                             -> 현재 Codex 작업의 광고된 도구
                 \-> OCX 10100 (Web 외 모델)

일반 codex / codex-native-rescue -> OpenAI 공식 Codex endpoint
codex-aicc -> Integrated 17841
codex-web -> browser-only direct 17842
codex-ocx -> OCX direct 10100

외부 ChatGPT -> AICC 원격 작업공간 전용 Tunnel -> AICC 원격 작업공간 MCP (STDIO)
                                             -> 별칭으로 등록된 Git workspace
```

네 기능은 인증·추론·상태를 섞지 않는다. Workspace MCP는 OCX provider나 Codex
catalog를 수정하지 않고, OCX는 Tunnel profile과 ChatGPT connector를 수정하지
않는다. Web GPT 브리지는 Web 모델만 ChatGPT Web에서 추론하고 Web 외 모델은 기존
OCX upstream으로 전달한다. `2.0.0-aicc.4`부터 macOS의 17841 Responses 라우터는
로그인 LaunchAgent가 소유하고, Codex Web GPT Desktop은 ChatGPT 브라우저와 Full
하네스 Tunnel만 소유한다. 따라서 Desktop을 종료하거나 다시 열 때는 Web 요청만
drain하고 17841의 OCX 전달은 유지한다. 17841 라우터 서비스 자체를 중지하면 같은
전역 API base를 쓰는 모델 선택기 전체가 영향을 받을 수 있으므로, 서비스 업데이트와
Native/OCX profile 전환은 전체 HTTP 작업이 없는 시점에만 한다.

기본 `codex`는 공식 Native에 고정하고 로컬 경로는 이름이 다른 실행기로만 선택한다.
각 실행기는 자신의 health/readiness와 exact-zero 계약을 통과하지 못하면 fail closed하며,
다른 경로로 자동 전환하거나 기본 설정을 수정하지 않는다.

로그인 직후 Desktop이 LaunchAgent보다 먼저 열릴 수 있으므로 Desktop은 동일 릴리스의
17841 서비스가 준비될 때까지 최대 30초만 기다린다. Codex route가 다른 도구에 의해
바뀐 상태에서는 자동으로 덮어쓰지 않으며, 명시적인 route 교체 작업만 현재 값을 복구
기준으로 저널링한다. AICC가 소유한 OCX 시작과 catalog 재확인은 route 쓰기 명령을 호출하지
않고 전후 Codex config hash를 검증한다. upstream 원본 CLI로 직접 route mutation을 실행하는
작업은 이 보호 범위가 아니므로 active turn 0과 별도 maintenance lease가 필요하다. 자세한
정책은 [OCX upstream-only 및 저장소 운영 경계](ocx-upstream-storage-governance.md)를 따른다.

Web GPT 작업 하네스 전용 Tunnel과 AICC 원격 작업공간 전용 Tunnel은 이름만 다른 동일
런타임이 아니다. 전자는 `codex-chatgpt-web mcp`를 실행해 현재 Codex turn broker에
연결하고, 후자는 AICC의 고정 `components/workspace-mcp/server.mjs`를 실행한다.
명령·수명주기·복구 책임이 다르므로 Tunnel ID와 profile을 공유하지 않는다.
대시보드와 로그인 시 자동 시작·상태 수집은 AICC가 하나로 통합 관리하지만 전송
Tunnel은 분리한다. 하나의 범용 MCP가 두 역할을 multiplex하는 구현은 기술적으로
가능하더라도, 외부 ChatGPT 고정 권한과 현재 Codex turn의 동적 권한을 같은 장애·
승인 경계에 놓게 되므로 채택하지 않는다.

## 내구 작업과 orchestration

긴 작업의 job/attempt, 역할 DAG, checkpoint와 검증된 artifact metadata는
`~/.ai-control-center/jobs`의 내구 저장소가 소유한다. 대시보드, 17841 bridge, OCX나
Workspace MCP가 이 저장소의 대체 writer가 되지 않는다. deterministic coordinator만
상태 전이와 workspace writer lease를 발급하고 Web GPT 역할 worker는 할당된 read/write
mode 안에서만 실행한다. 외부 부작용은 outbox reservation으로 중복을 막고, worker나
manager가 종료되면 자동 재실행하지 않고 lease 만료 후 pause/checkpoint에서 재개한다.
산출물은 provenance, hash와 실제 code/PDF/browser 검증이 모두 current일 때만 완료된다.
세부 운영 경계는 [내구 작업과 산출물 운영 경계](durable-jobs-artifacts.md)를 따른다.

브라우저 작업은 [브라우저와 원격 작업 경계](browser-remote-boundaries.md)의 identity tuple과
task-owned target lease를 사용한다. Web GPT tab/session broker와 registered CDP helper는
각자 소유 target만 정리한다. AICC Workspace MCP는 browser capability를 갖지 않으며,
Secure Tunnel 인증 뒤에도 workspace scope, expiry, replay guard와 durable writer binding을
별도로 통과해야 한다.

공개 extension registry, Codex plugin package, canonical entry skill, 8-tool MCP surface,
supply-chain metadata와 recoverable lifecycle은
[Extensions and Web GPT orchestration](extensions-and-web-gpt-orchestration.md)에 정의한다.

설치·target version diff, isolated state/port canary, component-only rollback과 두 번의 restart budget은 [Compatibility lab and guarded updates](compatibility-updates.md)에 정의한다. 버전 발견은 자동 적용 권한이 아니다.
plugin은 public AICC runtime을 호출하며 private Web GPT adapter나 모델 route ownership을
복제하지 않는다.

AICC 원격 작업공간 MCP는 고정 도구만 게시한다. 파일과 명령은 `workspace_id + lease`로
하나의 등록 workspace에 묶이고, 경로·심볼릭 링크·민감 파일을 검사한다. 명령은
macOS seatbelt에서 실행하며 home의 다른 경로를 읽지 못하고 선택 workspace와
private runtime 경로에만 쓸 수 있다. 브라우저와 Computer Use는 이 MCP에 넣지
않는다. Codex Web GPT 모델에서는 현재 Codex 작업에 실제로 광고된 도구만 프로젝트
경계 allowlist를 통과해 사용할 수 있다. 외부 ChatGPT의 AICC Workspace 앱은
파일·터미널·AICC 스킬 도구만 제공한다.

Owner-local 설치는 명시적 opt-in으로 `projectsRoot` 자체를 하나의 workspace alias로 등록하고
approval/job 없는 기본 write lease를 사용할 수 있다. 이 모드는 프로젝트 트리 사이의 디렉터리
장벽을 없애지만 home·인증 상태까지 확장하지 않으며, secure tunnel identity, 단일 writer,
request replay guard, symlink·민감 파일 검사와 seatbelt는 계속 강제한다.

정본은 AICC 저장소다. 인증, runtime key, Tunnel profile, workspace registry와
LaunchAgent는 `~/.ai-control-center` 및 사용자 LaunchAgents에 둔다. macOS 로그인
시 AICC 대시보드, Workspace Secure Tunnel, OCX, Web GPT 17841 라우터와 설정 완료된
Codex Web GPT Desktop이 각 소유권 경계에서 시작된다. 한 경로의 장애를 다른
계정·provider·브라우저로 숨기지 않는다.

## 공개·개인 버전 경계

- `AICC` public: 재사용 가능한 코드, 문서, 테스트와 일반화된 `guidance/` 정본
- owner-local Private Home export: public AICC 버전 pin과 비밀 없는 설치 manifest·개인 overlay만 보관하며 source/fork로 사용하지 않음
- 인증 JSON, 계정 DB, task DB, Tunnel/API key, 쿠키, 브라우저 프로필과 키체인은
  private Git에도 올리지 않는다.
- 절대 경로는 `${HOME}` 또는 설치 시 선택한 root로 치환하고 개인 계정 alias는
  private overlay에서만 관리한다.

## 참고 upstream의 현재 지위

| 프로젝트 | 현재 지위 |
|---|---|
| OpenCodex(OCX) | Codex Desktop의 선택 provider 라우터 |
| `codex-chatgpt-web` | Codex Desktop의 Web 모델 브리지. AICC fork를 별도 릴리스하고 OCX upstream을 보존한다. |
| CodexPro | 런타임 미채택. npm 최신 안정판은 참고 신호로만 관측하고 agent 비교 없이 설치하지 않음 |
| `Waishnav/devspace` | 의존성 미채택. npm 최신 안정판은 참고 신호로만 관측하고 agent 비교 없이 설치하지 않음 |
| Obsidian JSON Canvas | 구조 지도의 카드·연결선 표현과 공개 `.canvas` 내보내기 규격만 참고 |

`devspace`는 AICC나 `codex-chatgpt-web`에 서브모듈·패키지·실행 프로세스로 합쳐진
것이 아니다. 채택한 것은 범용 workspace 선택·경계·도구화라는 설계 아이디어이고,
실제 구현과 유지보수 책임은 AICC의 `components/workspace-mcp`에 있다.
두 원본의 관측은 새로운 기능·보안 아이디어를 놓치지 않기 위한 screening이며 update apply 권한이 아니다.

대시보드 구조 지도는 브라우저에서 직접 렌더링하므로 Obsidian이나 커뮤니티
플러그인이 필요 없다. 같은 내용을 `public/aicc-architecture.canvas`로 제공해
Obsidian 내장 Canvas에서도 열 수 있다. Excalidraw와 Dataview는 각각 자유형 시각화와
Markdown 질의에는 유용하지만 AICC 실시간 상태판의 런타임 의존성으로 채택하지 않는다.

## 사용자에게 보이는 두 MCP 이름

| 표시 이름 | 어디서 시작하는가 | 범위 | 이전 이름 또는 실제 앱 이름 |
|---|---|---|---|
| Web GPT 작업 하네스 MCP | Codex Desktop에서 Web 모델을 선택 | 현재 Codex 작업의 동적 도구 | 이전 `Codex Native MCP`; 네이티브 Codex 모델과 무관 |
| AICC 원격 작업공간 MCP | 폰·웹 ChatGPT에서 앱을 선택 | 등록 Git 작업공간과 13개 고정 도구 | 현재 ChatGPT 앱 이름 `AICC Workspace` |

둘은 모델이 아니다. 전자는 Codex에서 시작된 Web GPT turn이 현재 Codex 도구를 다시
호출하는 경로이고, 후자는 ChatGPT에서 시작된 대화가 독립적으로 등록 작업공간을
호출하는 경로다. 운영 상태는 AICC 한 화면에서 보되 Tunnel ID와 권한은 공유하지 않는다.

## 사용자 요청 명칭

- `Web GPT` 또는 `웹 지피티`는 Codex 모델 선택기의 `chatgpt-web/*`와 17841 브리지를 뜻한다.
- `인앱 브라우저`는 Codex Desktop 내장 Browser로 ChatGPT UI를 직접 조작하는 별도 방식이다.
- 한 경로가 실패해도 다른 경로로 조용히 바꾸지 않는다.

구형 v1 브리지 설정, 과거 에이전트 스택, 폐기 provider·port·스킬은 복구 대상으로
취급하지 않는다. 현재 v2 Web GPT 앱, 17841 bridge와 3경로 복구 문서만 유지한다.

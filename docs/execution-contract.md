# 안전 실행 계약

## AICC 제어면

계정, OCX와 Codex 모델 경로 변경은 이름이 고정된 action만 사용한다. 미리보기,
짧게 유효한 일회용 토큰, 단일 writer lock, 실행 전 상태 비교, 실행 후 검증과 복구를
거친다. Native/bridge route action은 진행 중 Web turn이 있으면 거부하고, 검증 실패 시
실행 전 route로 rollback한다. AICC 웹 API는 loopback·동일 출처·JSON 요청만 허용한다.

## MCP 로딩 수명

- `enabled=false`인 MCP는 이미 시작된 작업의 도구 목록에 없다. 같은 대화나 그 하위 agent가 스스로 추가할 수 없다.
- Desktop 설정 변경은 저장 후 해당 host를 정상 재시작해야 한다. 새 CLI process는 시작 시 설정을 다시 읽는다.
- 기본 순서는 `활성 MCP의 지연 도구 로딩` → `project-scoped MCP` → `새 전용 작업/process`다. 활성 작업 중 전역 설정을 토글하지 않는다.
- 새 작업·하위 agent도 생성 host가 MCP를 다시 로드하고 도구를 광고한 경우에만 사용할 수 있다.
- skill은 MCP의 workflow를 담을 수 있지만 도구·인증·연결을 만들지 않는다. 기존 native/CLI/API/script가 같은 capability를 제공할 때만 MCP를 retire한다.

[OpenAI MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
[OpenAI skill 문서](https://learn.chatgpt.com/docs/build-skills)

## Workspace MCP 데이터면

Workspace MCP는 임의 절대 경로를 받지 않는다. 먼저 등록 별칭을 열고 만료되는
lease를 얻어야 한다. 읽기, 검색, 패치, 명령, Git 변경 검토와 AICC 스킬 읽기만
고정 schema로 제공한다. 비밀 파일과 Git 내부 메타데이터를 차단하고, 명령 환경에서
토큰·인증 변수를 제거한다. 프로세스 세션은 재부팅 뒤 자동 재실행하지 않는다.

Business surface는 22/17/5 도구와 guarded 또는 owner-unrestricted single-writer policy를 사용한다.
Personal read/fetch surface는 별도 18/18/0 manifest, state root, remote identity, Tunnel과 publication record를
사용한다. Personal open은 read-only lease만 발급하고 write tool은 server에 등록하지 않는다.

쓰기 정책은 `가용성은 상시, 실행은 요청 시`다. 지원 경로는 쓰기 도구를 제공하되 exact workspace,
single writer, request ID, sandbox를 유지한다. 전역 unrestricted lease나 보이지 않는 양방향 자동 동기화는 만들지 않는다.
Workspace source의 `runtimeReady`와 ChatGPT 앱의 published schema는 별개다. `needsPublish=true`이면
새 write surface는 아직 외부 앱에서 보장하지 않으며, 게시와 scratch-write canary 뒤 live로 판정한다.

등록 별칭 밖의 local read는 AICC 로컬 UI가 exact root, include/deny, 예상 파일 수,
byte/file 예산과 최대 1시간 TTL을 preview한 뒤 발급한 `grant_ref`로만 연다. 임의 root
입력이나 whole-home convenience alias는 제공하지 않는다. session index는 metadata-only,
excerpt는 UUID와 작은 line/turn/byte 범위에 묶인 별도 일회용 승인이다. read capability은
memory-only이며 write/exec로 승격되지 않는다. 민감 경로, TCC 거부, symlink escape,
ungranted root, close/expiry/replay는 모두 fail closed로 검증한다.

## 완료 증거

- 단위 테스트와 실제 seatbelt 파일 생성·패치 smoke
- Tunnel launchd loaded, healthz와 readyz
- OCX 10100 health와 비대상 provider 보존
- `aicc agents check`, `aicc guidance check`
- 실제 ChatGPT connector의 workspace 목록·읽기·쓰기 호출
- `routes.status`, `web-gpt.doctor`, `ocx.diagnostics`, `support.bundle`의 비밀 제외 결과
- 대시보드 CSP 오류 0건과 desktop/mobile 문제해결 화면

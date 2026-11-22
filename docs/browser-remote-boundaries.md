# 브라우저와 원격 작업 경계

AICC는 브라우저 이름이나 열린 탭 순서로 session을 선택하지 않는다. 모든 경로는 role,
engine, OS app identity, executable, user-data root, profile, endpoint/native session,
account/workspace alias와 owner로 구성된 identity tuple을 가진다.

| 경로 | owner | 대상 정책 |
| --- | --- | --- |
| Codex in-app Browser | 현재 outer Codex browser tool | 현재 task가 선택한 native target만 |
| Web GPT partition | `webgpt-sessiond` | run/role/conversation에 매핑된 Web GPT 소유 target만 |
| registered CDP | AICC CDP target lease helper | helper가 새로 만든 background target만 |
| isolated QA | AICC stateless QA | 로그인 없는 task-owned process와 target만 |

기존 사용자 탭은 lease 후보가 아니다. target activation, 탭 위치 추측, account switch와
profile/extension 변경은 broker 권한에 없다. registered CDP adapter는 기존
`Manage-CdpChromeSlotLease.ps1` helper를 shell 없이 호출하며 helper가 반환한 exact target만
heartbeat/release한다. capability 원문은 메모리에만 있고 내구 저장소에는 SHA-256만 남는다.
broker restart로 원문 capability를 잃으면 target을 다시 추측하거나 인수하지 않고
`stale`/`quarantined`와 provider reconciliation으로 멈춘다.

관찰 lease는 navigate, inspect, screenshot, console과 network만 허용한다. click, type과
download는 durable workspace write lease를 가진 browser/remote job에만 허용한다. origin은
lease 발급 시 고정되고, download는 task artifact 디렉터리로 명시적으로 저장해야 한다.

## Web GPT tab/session

Web GPT session service가 conversation-tab-role-run mapping, 30초 identity pacing, quarantine,
tab budget과 owned cleanup의 권한 원천이다. 기본 streaming cap은 3, 전체 hard cap은 5,
saved conversation cap은 1이다. temporary target만 terminal cleanup 대상으로 반환하며 saved
conversation은 명시적으로 보존한다. restart reconciliation은 기록과 일치하는 target만
확인하고 foreign target을 adopt/close하지 않는다. raw transcript와 tab content는 저장하지 않는다.

## Remote Workspace MCP

Secure MCP Tunnel이 원격 사용자의 authentication owner이고, Workspace MCP는 그와 별도로
workspace scope와 correlation-bound lease를 강제한다. 기본 lease는 read-only다. write lease는
다음 항목을 모두 요구한다.

- opaque approval ref
- durable job ID와 running attempt ID
- 같은 workspace/identity의 single writer lease
- 짧은 expiry
- write 호출마다 한 번만 소비되는 request ID

같은 request ID replay, expired capability, wrong workspace, read lease의 write 호출과 manager
restart 전 capability는 거부된다. capability 원문은 내구 저장소에 기록하지 않는다.

Web GPT turn harness와 AICC Workspace MCP는 process owner, Tunnel identity, lifetime,
capability source와 failure domain이 모두 다르다. persistent Workspace MCP에는 browser tool이
없다. 한쪽의 outage나 restart는 17841, 10100, Native Codex, local browser broker와 durable
job을 자동으로 재시작하지 않는다.

## 운영 명령

```bash
aicc task run browser.status --json
aicc status --json
pwsh -NoProfile -File tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1 -Action Status -AsJson
npm run test:browser
```

현재 설치 runtime이 이전 Workspace MCP config/tool schema를 사용 중이면 source의 새 remote
authority를 준비 완료로 확대 해석하지 않는다. exact remote active-work가 0이고 connector
schema publication/rollback이 준비된 Phase 09/11 cutover에서 config와 runtime을 함께 바꾼다.

# CCCC 평가

상태: **production core 비채택 — optional isolated experiment로 보류**

## 식별

검토 대상은 `ChesterRa/cccc`다.

CCCC는 AgentDock 같은 단일 머신 실행 runtime이라기보다 여러 agent runtime을 하나의 durable group으로 묶는 collaboration/orchestration kernel이다.

지원 범위:
- Codex CLI
- Claude Code
- ChatGPT Web Model
- Grok Build
- OpenCode/Kilo/Kiro/Cursor/Devin/Copilot 등 다수 CLI runtime
- custom runtime

핵심 상태는 `CCCC_HOME` 아래 daemon-owned state에 두며 Web UI, CLI, MCP, IM bridge가 같은 state를 공유한다.

## 강점

### Durable coordination
- append-only ledger
- delivery/read/reply 분리
- actor/group/task/context state
- restart/resume
- Foreman + peer role model
- 메시지/파일/답장 routing

### Human operations
- Web UI
- mobile browser
- terminal tiles
- files/editor
- Git inspection
- Presentation
- automation/cron
- IM bridge: Slack/Telegram/Discord/Mattermost 등
- voice workflows

### Multi-runtime
- Codex/Claude/ChatGPT Web 등 서로 다른 runtime을 한 Group에서 협업시킬 수 있음.
- CCCC MCP를 runtime session에 actor-scoped로 주입/검증.
- custom CLI fallback 가능.

### External capabilities
- external MCP capability를 remote HTTP, package, command 형태로 enable 가능.
- allowlist와 scope를 group/actor/session 단위로 관리.
- optimistic concurrency 및 explicit block 지원.

## ChatGPT Web Model

CCCC의 `web_model`은 현재 WebGPT 요구와 크게 겹친다.

두 transport:
1. browser delivery: bound ChatGPT web chat에 메시지를 안전하게 주입
2. remote MCP pull: ChatGPT가 CCCC MCP에서 next turn을 pull하고 exact turn을 complete

ChatGPT connector가 보이면 workspace file edit, scoped command, Git inspection까지 가능하다.

따라서 다음 기능은 기존 custom WebGPT와 중복 가능성이 높다.
- web -> local agent
- local agent -> web
- ChatGPT Web를 worker/actor로 사용
- session handoff/resume
- durable task/message state
- browser delivery ambiguity/no-replay 처리

## AgentDock와 관계

AgentDock/NexusDock를 CCCC의 단순 하위호환/상위호환으로 보지 않는다.

### AgentDock가 더 직접적인 영역
- machine execution substrate
- strict path boundary
- atomic file write
- bounded command/process/PTY
- browser automation
- Dynamic MCP
- ACP coding agents
- multi-device Nexus bridge
- ARM64 A1에 맞는 NexusDock 배포

### CCCC가 더 강한 영역
- multi-agent collaboration
- durable messaging/read/reply
- actor/team/task/context lifecycle
- Web/IM/mobile operations
- ChatGPT Web actor
- cross-runtime handoff
- session/runtime recovery
- shared control-plane UX

결론: 상하 레이어 관계가 더 정확하다.

## AICC와 관계

AICC가 계속 소유할 것:
- exact workspace grant
- read/write surface separation
- durable writer lease
- replay guard
- post-read/rollback
- OCX/WebGPT/Native route policy
- recovery receipt
- CUA/RDC coordination

CCCC가 대체 후보인 것:
- multi-session handoff
- actor/group coordination
- WebGPT 일부 browser delivery
- task/message ledger
- mobile/IM operational UI
- Codex/Claude/ChatGPT runtime team orchestration

## RDC와 관계

CCCC는 RDC처럼 범용 emergency OS remote-control 제품은 아니다.
RDC는 독립 break-glass path로 유지한다.

## A1 적합성 제약

현재 CCCC 공식 native target:
- Linux x86-64
- Apple Silicon macOS
- Windows x86-64

Linux ARM64는 공식 current package 대상이 아니다.
Oracle A1은 Linux ARM64이므로 현재 CCCC를 A1 production control plane으로 바로 채택하지 않는다.

Docker/source build가 ARM64에서 실제로 작동할 가능성은 별도 POC 없이는 production capability로 간주하지 않는다.

반면 AgentDock/NexusDock는 A1 ARM64 중앙 relay에 더 자연스럽다.

## Remote access/security

- daemon IPC는 loopback-only/no-auth이며 remote exposure 금지.
- remote Web는 Admin Access Token + Cloudflare Access/Tailscale 권장.
- ChatGPT Web Model connector는 public HTTPS MCP URL을 요구하는 문서가 현재 정본.
- connector는 private credential-bearing URL을 만들고 ChatGPT 쪽 Authentication=No Auth 흐름을 문서화한다.
- shell/file tools는 workspace scope를 검증하지만 host OS 권한 자체는 sandbox가 아니다.

따라서 AICC의 security policy를 제거하지 않는다.

## 후보 구조

### Candidate A — CCCC 중심, AgentDock 생략
```text
ChatGPT Web / Codex / Claude
  -> CCCC on Windows
  -> external AICC Workspace MCP
  -> AICC policy
  -> Windows workspace

A1
  -> existing OCX/quota/Slack services
RDC
  -> emergency
```

장점:
- 가장 적은 신규 레이어
- 현재 가장 큰 문제인 세션/actor coordination과 WebGPT 중복을 직접 해결
- AICC 정책 유지

단점:
- Windows가 꺼지면 CCCC도 꺼짐
- multi-device remote substrate는 약함
- A1 ARM64에 CCCC를 바로 둘 수 없음

### Candidate B — CCCC + AgentDock/NexusDock + AICC
```text
CCCC on Windows
  -> actors/tasks/handoff/WebGPT coordination
  -> AgentDock local execution
  -> AICC exact workspace MCP/policy

NexusDock on A1
  -> multi-device remote transport

RDC
  -> emergency
```

장점:
- 역할 분리가 가장 완전함
- CCCC는 orchestration, AgentDock는 execution, AICC는 policy

단점:
- 레이어가 많아 운영 복잡도 증가
- 중복 tool surfaces가 커질 수 있음

## POC 처리

이 문서의 초기 검토 단계에서는 CCCC Windows POC를 AgentDock보다 먼저 수행하는 안을 검토했으나,
전체 아키텍처와 A1 ARM64 적합성, 기존 AICC state ownership을 종합한 최종 결정에서 폐기했다.

현재 실행 순서에는 CCCC POC를 포함하지 않는다.
필요성이 새로 증명될 때만 별도 isolated experiment로 다시 연다.

## 최종 판단

CCCC는 production core에 추가하지 않는다.

이유:
- AICC에 이미 session registry, control-plane report, user-action ledger, WebGPT/Slack 경로가 있어 orchestration state가 중복된다.
- 별도 daemon state owner를 추가하면 source-of-truth와 recovery ownership이 복잡해진다.
- Oracle A1의 Linux ARM64는 현재 공식 native package 대상이 아니다.
- 현재 가장 큰 미완료는 multi-agent UI보다 안정적인 self-host remote transport/runtime이다.

CCCC는 다음 조건이 실제로 생길 때만 isolated experiment로 재검토한다.
- AICC multi-session coordination이 실제 운영에서 부족함이 증명됨
- ChatGPT Web actor가 custom WebGPT보다 유의미하게 안정적임을 비교할 필요가 있음
- 별도 orchestration state owner의 운영 비용을 감수할 가치가 있음

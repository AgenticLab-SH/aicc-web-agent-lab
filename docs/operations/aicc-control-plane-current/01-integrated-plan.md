# 통합 작업 계획

상태: **최종 방향 선정 후 실행 계획**

상세 의사결정은 [06-final-direction.md](06-final-direction.md)를 우선한다.

## 목표

ChatGPT Web, Codex, AICC Web Bridge (compat: WebGPT)가 Windows를 안정적으로 읽고 제어하되,
A1을 24/7 control plane으로 사용하고 RDC는 break-glass 복구 경로로 남긴다.

기존 정상 구조:
- A1 OCX hub = sole credential owner
- Windows OCX = client
- A1 quota/reset watcher
- A1 Slack direct notification
- Native / OCX / WebGPT route 분리
- immutable installed AICC release
를 보존한다.

## 최종 확정 아키텍처

```text
ChatGPT Custom MCP App
  -> OpenAI Secure MCP Tunnel
  -> AICC Relay @ A1 (upstream: NexusDock)
  -> outbound endpoint transport
  -> AICC Endpoint @ Windows (upstream: AgentDock)
  -> AICC Workspace MCP / bounded AICC actions
  -> workspace grant / lease / replay / post-read / rollback

RDC
  -> independent break-glass recovery
```

역할:
- AICC: policy/orchestration owner
- AICC Endpoint: Windows execution node
- AICC Relay: A1 remote transport/fleet entrypoint
- Secure MCP Tunnel: ChatGPT private ingress
- RDC: emergency recovery
- CCCC: deferred optional experiment

현재 자작 A1 Remote Gateway는 proof-of-concept로 보존하되 production transport로 계속 확장하지 않는다.

## Phase 0 — 기존 production baseline 재검증

read-only로 확인:
- A1 OCX hub health
- sole credential ownership
- A1 watcher timer/recent result
- Slack direct path
- Windows OCX client readiness
- 10101/10102 tunnels
- AICC Web Bridge (compat: WebGPT) 17841
- Native/OCX route separation
- installed immutable AICC release/rollback receipt

PASS하지 않은 영역을 새 remote stack 변경으로 가리지 않는다.

## Phase 1 — AICC Endpoint Windows isolated POC

- 전용 state root 사용
- 기존 AICC/RDC/OCX/AICC Web Bridge와 다른 port 사용
- 기존 runtime/process/port diff를 pre/post-read
- read-only capability부터 시작
- AICC Workspace MCP를 downstream/dynamic MCP로 연결 가능한지 검증
- `open-aicc` read-only canary
- secrets/log redaction
- duplicate process prevention
- Windows reboot/reconnect

초기에는 열지 않음:
- unrestricted shell
- unrestricted filesystem root
- daily Chrome profile
- broad browser mutation
- upstream Recall/Workflow의 task source-of-truth 역할

## Phase 2 — AICC Relay A1 isolated POC

- pinned ARM64 image
- 별도 persistent root
- private/loopback deployment
- 기존 OCX/quota/Slack services와 port/state 분리
- AICC Endpoint pairing (upstream AgentDock node pairing)
- outbound reconnect
- unified MCP tool discovery
- A1 restart recovery
- CPU/RAM/disk/latency 측정

## Phase 3 — transport 결정 및 정식화

AICC Endpoint/Relay 후보와 기존 자작 relay prototype을 비교:
- reliability
- reconnect
- latency
- tool schema
- auth/security
- observability
- deployment/update
- rollback
- maintenance burden

AICC Endpoint/Relay acceptance PASS 시:
- production transport로 채택
- 자작 gateway 기능 확장은 중지
- prototype는 reference/rollback으로 보존

FAIL 시:
- 자작 gateway로 즉시 회귀 가능해야 한다.

## Phase 4 — 관측성

필수:
- MCP/tool calls
- status/error class
- latency
- queue/reconnect
- node online/offline
- result bytes
- AICC snapshot/cache hit/miss
- lease/replay counters

금지:
- prompt 원문
- file contents
- secrets/auth header
- ChatGPT model token/cost 임의 추정

정확한 외부 usage source가 있을 때만 별도 비용 지표를 연결한다.

## Phase 5 — ChatGPT Custom MCP App

- OpenAI Secure MCP Tunnel 연결
- Create app -> MCP app
- Connection=Tunnel
- Tool Scan
- tool schema/annotations snapshot
- read-only evaluation
- follow-up identifier reuse
- unsupported write 요청
- device offline
- stale snapshot
- timeout
- reconnect

실제 ChatGPT -> A1 -> Windows -> AICC read canary를 완료한다.

## Phase 6 — read-only 기본경로 승격

일반 remote 파일/코드 조회:
- default: AICC Remote Fabric
- emergency: RDC

RDC는 삭제하지 않는다.

## Phase 7 — bounded write

- task-owned scratch workspace부터 시작
- durable writer lease
- one-use request ID
- replay deny
- apply -> post-read -> rollback
- uncertain dispatch reconcile
- reader parallelism/writer exclusion fault tests

broad shell/write를 기본으로 열지 않는다.

## Phase 8 — AICC Web Bridge / Codex / Computer Use 통합

- Native / OCX / AICC Remote Fabric route를 명시적으로 유지
- AICC Web Bridge full harness는 해당 task가 광고한 tool만 사용
- 같은 파일/GUI resource의 동시 write 금지
- GUI mutation은 exact PID/window/tab lease 뒤 수행
- Computer Use는 GUI가 실제 필요한 경우만 사용

## CCCC 처리

CCCC는 production core에서 제외한다.

재평가 조건:
- AICC session/report/user-action ledger가 실제 multi-agent coordination에 부족함
- CCCC ChatGPT Web actor가 AICC Web Bridge보다 유의미하게 안정적임
- 별도 orchestration state owner 추가 비용보다 이득이 큼

그 전까지 설치/통합하지 않는다.

## 완료 기준

- 기존 A1/OCX/AICC Web Bridge baseline 무변경
- AICC Endpoint Windows reboot recovery PASS
- AICC Relay A1 restart recovery PASS
- endpoint outbound reconnect PASS
- AICC exact workspace E2E PASS
- ChatGPT Custom MCP App Tool Scan PASS
- ChatGPT 실제 read canary PASS
- secret-free observability PASS
- bounded write acceptance PASS
- RDC 독립 recovery path PASS

# 최종 방향성 결정 — AICC Remote Fabric

상태: **2026-09-26 최종 방향 선정 / 구현 전환 준비**

## 결론

production 기본 구조는 다음으로 선정한다.

```text
ChatGPT Custom MCP App
  -> OpenAI Secure MCP Tunnel
  -> AICC Relay @ Oracle A1 (upstream: NexusDock, loopback/private)
  -> outbound endpoint transport
  -> AICC Endpoint @ Windows (upstream: AgentDock)
  -> AICC Workspace MCP / bounded AICC actions
  -> exact workspace / lease / replay / post-read / rollback

RDC
  -> independent break-glass recovery
```

CCCC는 production core에 넣지 않는다.
필요할 경우 multi-agent collaboration UX를 검증하는 별도 isolated experiment로만 남긴다.

현재 자작 `components/remote-gateway`는 즉시 삭제하지 않는다.
AgentDock/NexusDock POC와 acceptance가 끝날 때까지 reference/rollback prototype로 보존한다.

## 왜 이 구조인가

### 1. 기존 AICC 투자를 보존한다

AICC는 이미 다음을 소유한다.

- exact registered workspace
- read-only / guarded-write surface
- durable writer lease
- one-use request/replay guard
- post-read verification
- rollback/receipt
- Native / OCX / WebGPT route separation
- control-plane report/session registry
- CUA/RDC resource arbitration 방향
- Windows-first recovery contracts

이 기능은 AgentDock나 CCCC의 범용 tool runtime으로 대체하지 않는다.

### 2. 범용 remote transport/runtime은 직접 재구현하지 않는다

자작 A1 gateway MVP로 기술 가능성은 증명했다.
그러나 production까지 직접 만들 경우 다음을 장기 유지해야 한다.

- reconnect
- device registry
- multi-device routing
- OAuth/auth
- update/installer
- task/process transport
- browser runtime
- observability
- protocol compatibility

AgentDock/NexusDock는 이 범용 부분을 이미 제품화하고 있으므로 해당 층을 재사용한다.

### 3. A1 ARM64와 맞는다

NexusDock 공식 이미지가 linux/arm64를 지원한다.
Oracle A1은 NexusDock의 24/7 control-plane 역할에 적합하다.

### 4. Windows는 outbound node로 둔다

Windows inbound port를 공개하지 않는다.
AgentDock node가 A1 NexusDock로 outbound 연결한다.

A1은 기존 OCX/quota/Slack 기능과 함께 24/7 서버 역할을 유지하지만
각 서비스는 별도 process/state/port/failure domain을 유지한다.

### 5. CCCC의 중복 비용을 피한다

CCCC의 강점:
- multi-agent group
- durable message/read/reply
- ChatGPT Web actor
- task/context/session handoff
- shared Web UI/IM bridge

하지만 현재 AICC에 이미:
- session registry
- control-plane report
- user-action ledger
- WebGPT/browser path
- Slack integration
- task ownership/recovery

가 존재한다.

CCCC를 core에 추가하면 orchestration state owner가 두 개가 될 위험이 있다.
또한 현재 A1 Linux ARM64 공식 native 지원이 없다.

따라서 CCCC 기능은 필요 시 선택적으로 참고/실험하되,
production state owner는 AICC 하나로 유지한다.

## 역할 경계

### AICC — policy/orchestration owner

소유:
- workspace grants
- lease/replay/single writer
- post-read/rollback
- route policy
- recovery receipts
- current operations documentation
- control-plane reports/session registry
- AICC Web Bridge / OCX / Computer Use / RDC arbitration

소유하지 않음:
- 범용 remote device transport
- fleet WebSocket protocol
- generic multi-device runtime

### AICC Endpoint — Windows execution node (upstream: AgentDock)

초기 허용:
- AICC Workspace MCP downstream capability
- read-only system/device status
- bounded diagnostics

초기 비허용:
- unrestricted shell
- unrestricted filesystem root
- daily Chrome profile takeover
- broad browser automation
- duplicate task/Recall state ownership

추후 capability는 AICC policy와 acceptance를 통과한 것만 연다.

### AICC Relay — A1 remote transport/fleet entrypoint (upstream: NexusDock)

소유:
- AgentDock node pairing
- outbound node connectivity
- device availability
- unified MCP transport
- transport auth

초기에는 Recall/Workflow를 AICC session/task state 대체재로 사용하지 않는다.

### OpenAI Secure MCP Tunnel

ChatGPT 개인/개발 Custom MCP App과 private A1 MCP endpoint 사이의 ingress 역할.
public unauthenticated MCP port를 직접 열지 않는다.

### RDC

계속 독립 유지:
- AICC/AgentDock/NexusDock 장애 복구
- 설치/repair
- unsupported Windows operation
- break-glass

평상시 기본 route로는 사용하지 않는다.

### CCCC

상태: **deferred / optional experiment**

다음 경우에만 다시 평가:
- AICC session registry가 실제 multi-agent coordination에 부족함이 증명됨
- ChatGPT Web actor 기능이 AICC Web Bridge보다 의미 있게 안정적인지 비교할 필요가 생김
- 별도 state owner 추가 비용보다 collaboration 이득이 큼

production credential owner, workspace policy owner, remote transport owner로 사용하지 않는다.

## 자작 Remote Gateway 처리

현재 구현:
- A1 Streamable HTTP gateway
- Windows long-poll device agent
- read-only AICC MCP roundtrip
- reboot/autostart 일부

판정:
- 기술적 proof-of-concept로 성공
- production remote substrate로 계속 확장하지 않음
- AgentDock/NexusDock acceptance 완료 전까지 삭제하지 않음
- acceptance 후 `experimental/reference`로 이동하거나 archive
- 기존 gateway의 AICC adapter/tool schema/metrics 아이디어는 재사용 가능

## 최종 구현 순서

### Gate A — 기존 production baseline 재확인

1. A1 OCX hub/credential ownership
2. quota watcher
3. Slack direct notification
4. Windows OCX client/tunnels
5. Native / OCX / AICC Web Bridge routes
6. installed immutable AICC release

변경 없이 read-only PASS 확인.

### Gate B — AICC Endpoint Windows isolated POC

1. 전용 state root
2. 별도 port
3. 기존 process/port diff 0
4. local health
5. read-only tool discovery
6. AICC Workspace MCP를 dynamic/downstream MCP로 연결
7. open-aicc read canary
8. reboot/reconnect
9. log/secret scan

### Gate C — AICC Relay A1 isolated POC

1. ARM64 pinned image
2. 별도 persistent data root
3. loopback/private bind
4. 기존 OCX/relay-prototype port 충돌 0
5. AICC Endpoint pairing
6. outbound reconnect
7. unified MCP tool scan
8. A1 restart recovery
9. resource usage measurement

### Gate D — 자작 gateway와 비교 후 transport cutover

비교:
- reliability
- reconnect time
- tool schema
- latency
- operational complexity
- security boundary
- logging/metrics
- rollback

AICC Endpoint/Relay PASS 시:
- 새 기능 개발은 AICC Remote Fabric 위에서 진행
- 자작 gateway production 확장은 중지
- prototype는 rollback/reference로 보존

### Gate E — observability

수집:
- tool calls
- status/error
- latency
- queue/reconnect
- node online
- result bytes
- AICC snapshot/cache hit/miss
- lease/replay counters

금지:
- prompt/file contents
- auth headers
- secrets
- ChatGPT token/cost 추정치

정확한 외부 usage source가 있을 때만 별도 비용 지표를 연결한다.

### Gate F — ChatGPT Custom MCP App

1. OpenAI Secure MCP Tunnel
2. Create app -> MCP app
3. Connection=Tunnel
4. Tool Scan
5. read-only evaluation
6. device-offline/stale/timeout negative tests
7. schema snapshot
8. 실제 ChatGPT -> A1 -> Windows -> AICC canary

### Gate G — 기본 경로 승격

read-only remote 작업:
- AICC Remote Fabric = default
- RDC = emergency only

### Gate H — bounded write

1. scratch workspace
2. one writer
3. request/replay guard
4. apply/post-read
5. rollback
6. uncertain dispatch reconcile

broad shell/write를 먼저 열지 않는다.

## 비채택 항목

- CCCC를 production core state owner로 추가하지 않음
- 자작 long-poll remote gateway를 production fleet layer로 계속 확장하지 않음
- public unauthenticated MCP 노출 금지
- AICC Endpoint의 upstream unrestricted shell/root filesystem을 초기 기본 surface로 사용하지 않음
- upstream Recall/Workflow를 AICC task/session 정본과 이중화하지 않음
- RDC 제거 금지

## 완료 기준

- 기존 A1/OCX/AICC Web Bridge 정상 기능 무변경
- AICC Endpoint Windows reboot recovery PASS
- AICC Relay A1 restart recovery PASS
- outbound node reconnect PASS
- AICC exact workspace read E2E PASS
- ChatGPT Custom MCP App Tool Scan PASS
- ChatGPT 실제 read canary PASS
- observability secret-free PASS
- bounded write acceptance PASS
- RDC 독립 recovery path PASS

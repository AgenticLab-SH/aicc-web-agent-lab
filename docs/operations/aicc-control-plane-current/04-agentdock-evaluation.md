# AgentDock / NexusDock 평가

상태: **production remote substrate 우선 후보로 선정 — isolated POC 전**

## 식별

"AgentDock" 이름의 서로 다른 프로젝트가 여러 개 있다.

- `uvwt/agentdock`: ChatGPT 등 MCP client가 로컬/서버의 파일, 명령, Git, browser, Skills, ACP, task를 실행하는 범용 runtime. 이번 비교의 주대상.
- `Nigh/AgentDock`: Codex/Claude/Cursor CLI의 PTY 세션을 브라우저에서 원격 접속하는 terminal/session 제품.
- `agentdock.ai`: writing editor + Chrome extension + Agent API. Windows remote-control 대체재가 아님.
- 기타 동명 프로젝트는 별도 제품으로 취급한다.

## uvwt/AgentDock 핵심

- Apache-2.0 오픈소스.
- Streamable HTTP MCP.
- Windows native graphical installer 지원.
- 파일 읽기/검색/atomic write, bounded command execution, process/session/PTY.
- Git, Skills, dynamic MCP.
- recoverable task state/checkpoints.
- browser automation.
- ACP를 통한 Codex/Claude/Grok local coding-agent 연결.
- Bearer Token/OAuth.
- Cloudflare Quick/Named Tunnel.
- `NexusDock`과 pairing 시 multi-device unified MCP.
- NexusDock node는 outbound WebSocket으로 연결되어 node 측 inbound port가 필요 없다.

## 보안 경계

AgentDock는 완전한 OS sandbox가 아니다.
실제 보안은 실행 OS account, container mounts, enabled capability, input validation 등에 의존한다.
따라서 AICC의 exact workspace grant, read/write 분리, durable lease, replay guard,
single writer, post-read/rollback contract를 대체한다고 간주하지 않는다.

## RDC와 비교

### RDC 장점
- 설치/사용이 가장 간단.
- 범용 Windows filesystem/process/command surface가 이미 안정적.
- ChatGPT Web Remote MCP 연결이 바로 됨.
- emergency/break-glass에 적합.

### RDC 단점
- hosted control plane 의존.
- remote usage quota/계정 상태 의존.
- hosted backend 자체 self-host 소스는 공개되지 않음.
- AICC의 workspace-specific lease/replay 정책과 직접 통합되어 있지 않음.

## 현재 자작 A1 Remote Gateway와 비교

### 자작 gateway 장점
- exact AICC workspace contract만 노출 가능.
- 최소 tool ABI와 lease/replay semantics를 직접 통제.
- 기존 AICC receipts/recovery/control-plane과 결합하기 쉬움.
- external dependency가 적음.

### 자작 gateway 단점
- transport, reconnect, multi-device, auth, UI, metrics, installer, updater,
  browser, task persistence 등을 모두 직접 유지해야 함.
- 아직 MVP/read-only 단계.
- AgentDock/NexusDock가 이미 구현한 범용 runtime 기능과 중복이 큼.

## AgentDock/NexusDock와 AICC의 역할 분리 후보

권장 검토 구조:

```text
ChatGPT Custom MCP App
  -> NexusDock on A1
  -> outbound WebSocket
  -> AgentDock on Windows
  -> AICC adapter / Workspace MCP
```

역할:
- NexusDock: remote transport, node registry, unified MCP, OAuth/token, device status.
- AgentDock: local execution runtime, Files/Shell/Git/Browser/ACP/Tasks.
- AICC: route selection, exact workspace policy, lease/replay/single-writer,
  recovery receipt, OCX/WebGPT integration, CUA arbitration.
- RDC: independent emergency recovery path.

## 채택 판단

즉시 기존 AICC를 AgentDock로 교체하지 않는다.

다음 POC를 먼저 수행한다.
1. AgentDock Windows를 isolated test root로 설치/실행.
2. 현재 AICC/RDC/OCX process와 포트 충돌 0 확인.
3. loopback MCP에서 read-only file/tool canary.
4. NexusDock를 A1의 별도 loopback port에 Docker로 설치.
5. AgentDock node pairing + outbound reconnect 확인.
6. ChatGPT에는 아직 등록하지 않고 MCP inspector/client로 tools/schema 확인.
7. AICC exact workspace adapter를 AgentDock dynamic MCP 또는 bounded wrapper로 넣을 수 있는지 검증.
8. 기능/보안/운영 복잡도를 현재 자작 gateway와 비교.
9. 채택 시 자작 gateway는 즉시 삭제하지 않고 rollback 가능한 실험 branch로 유지.

## 평가 기준

- Windows native 안정성
- reboot/reconnect
- tool schema 품질
- path/workspace isolation
- command safety
- secret redaction
- OAuth/Tunnel 운영
- multi-device routing
- logging/metrics
- updater/rollback
- browser/CDP 충돌
- AICC lease/replay 통합 가능성
- RDC 독립성 유지
- A1 CPU/RAM/디스크 부하

## 최종 방향

범용 remote transport/runtime의 production 우선 후보로 AgentDock/NexusDock를 선정한다.
AICC는 제거하지 않고 policy/orchestration owner로 유지한다.
실제 채택 cutover는 isolated Windows/A1 POC와 restart/reconnect acceptance가 PASS한 뒤 수행한다.
자작 remote gateway는 그때까지 reference/rollback prototype로 보존한다.

# AICC 명명 체계

상태: **canonical naming contract — 2026-09-26**

## 목적

명칭이 구현 기술이나 특정 upstream 이름에 종속되지 않고 역할·책임·failure domain을 바로 드러내도록 통일한다.
외부 오픈소스는 구현 원천/provenance로 기록하되 production component 이름에는 직접 쓰지 않는다.

## 최상위

- **AICC**: 전체 제품/플랫폼 이름.
- **AICC Control Plane**: policy, ownership, task state, recovery, routing의 정본.
- **AICC Remote Fabric**: ChatGPT/A1/Windows 사이의 remote transport/execution 계층.

## Remote Fabric

### AICC Relay

A1에서 동작하는 24/7 remote transport/fleet entrypoint.
책임: endpoint pairing, outbound connectivity, remote MCP transport, availability, transport auth, reconnect/fleet routing.
현재 upstream 후보: NexusDock.
production 코드나 문서에서는 upstream 제품명을 component identity로 사용하지 않는다.

### AICC Endpoint

Windows에서 동작하는 local execution node.
책임: Relay outbound 연결, bounded local execution, downstream MCP attachment, runtime health, local task/process execution.
현재 upstream 후보: AgentDock.

### AICC Remote App

ChatGPT에서 보이는 Custom MCP App surface.

```text
ChatGPT
 -> AICC Remote App
 -> Secure MCP Tunnel
 -> AICC Relay
 -> AICC Endpoint
 -> AICC Workspace MCP
```

## Policy / state

### AICC Workspace MCP

기존 stable machine/tool ABI는 유지한다.
책임: exact workspace registration, read/write separation, workspace lease, replay protection, sensitive-path guard, post-read, rollback-compatible mutation.
표시명은 `AICC Workspace`로 쓰고 machine tool prefix `aicc_workspace_*`는 compatibility contract로 유지한다.

### AICC Work Ledger

대화/세션이 끊겨도 작업이 이어지게 하는 durable progress source.
통합 대상: control-plane reports, session registry, user-action ledger, current work log, checkpoint/handoff evidence.
목표: 모든 AI가 목표/완료/현재/남은 일/next gate/rollback을 동일하게 읽고 중복 작업을 피한다.

### AICC Resource Lease

모든 충돌 가능한 자원의 공통 ownership 모델.
resource type: workspace-writer, browser-slot, browser-target, ui-focus, terminal-session, deployment, credential-writer, file-mutation.
공통 필드: resource_id, owner_task_id, owner_actor_id, acquired_at, expires_at, heartbeat, generation, recovery_ref.
규칙: same resource single writer, safe readers only, stale-owner reconcile, PID 단독 ownership 판정 금지.

## Interaction safety

### AICC Browser Pool

CDP browser/profile/port allocator.
여러 AI가 동시에 웹을 다뤄도 port/profile 충돌을 방지하고 task-owned target만 조작한다.
9222~9225 기존 등록 슬롯은 보존하되 신규 slot은 registry에서 atomic lease한다.
hard-coded port 임의 선택을 금지하고 종료 시 owned target/profile만 release한다.

### AICC Focus Guard

GUI 작업의 foreground/focus ownership.
기본 실행 순서: API/MCP/CLI -> UI Automation/CDP -> background browser target -> foreground Computer Use -> coordinate fallback.
foreground mutation은 exact window/tab/resource lease가 있을 때만 허용하고 사용자 마우스/키보드/포커스를 기본적으로 빼앗지 않는다.

### AICC Auth Broker

로그인/OAuth/browser session lifecycle manager.
책임: OS-native credential store, authorized refresh/reconnect, browser profile binding, automatic session restoration, expiry detection, explicit reauth-required state.
비밀번호/token을 repo에 저장하지 않고 MFA/CAPTCHA/account protection을 우회하지 않는다.

### AICC File Guard

파일 mutation safety layer.
기본 규칙: delete보다 quarantine/move 우선, exact path/root/owner 검증, overwrite preimage/hash 보존, unrelated dirty file 보호, symlink/junction boundary 확인, post-read/hash, rollback receipt.
broad recursive delete, `git reset --hard`, `git clean -fd`는 explicit task contract 없이 금지한다.

## Web / browser

### AICC Web Bridge

기존 `WebGPT` 기능의 canonical 장기 이름.
책임: Web model <-> local control path, browser delivery, native route pass-through, task-owned browser surfaces.
현재 machine identifier `web-gpt`, `WebGPT`, port 17841은 compatibility 때문에 즉시 바꾸지 않는다.
새 문서에서는 `AICC Web Bridge (compat: WebGPT)`로 표기하고 machine rename은 별도 immutable release gate로 수행한다.

### Computer Use

`CUA`는 외부/기능 범주 이름이므로 AICC component로 재명명하지 않는다.
AICC 내부 문서에서는 `Computer Use`를 쓰고 실행 권한은 AICC Focus Guard와 Resource Lease가 조정한다.

## Recovery

### RDC Recovery Path

Remote Desktop Commander는 외부 독립 복구 수단이므로 component rename 대상이 아니다.
목적: AICC Relay/Endpoint/Workspace 장애 복구, 설치/repair, unsupported Windows operation.

## Upstream provenance

- AgentDock -> AICC Endpoint upstream/reference 후보
- NexusDock -> AICC Relay upstream/reference 후보
- CCCC -> AICC Work Ledger/coordination UX reference
- RDC -> independent recovery provider

upstream 이름은 source attribution, license, pinned revision, patch queue, update review 문서에서만 사용한다.

## Compatibility migration

사람에게 보이는 이름과 machine identifier를 분리한다.
1. canonical display/documentation rename
2. compatibility alias 추가
3. source directory/module rename
4. tests/fixtures 갱신
5. immutable candidate
6. cutover
7. old alias deprecation
8. 충분한 안정화 후 제거

stable tool ID, service name, port, state path를 mass search/replace로 동시에 바꾸지 않는다.
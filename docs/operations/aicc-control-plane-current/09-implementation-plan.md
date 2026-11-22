# AICC 구현 계획

상태: **naming contract 확정 후 실행 계획 — 2026-09-26**

## 구현 원칙

- 기존 정상 기능을 다시 만들지 않는다.
- 기존 class/file/tool ID는 compatibility surface일 수 있으므로 일괄 rename하지 않는다.
- canonical name은 중앙 identity registry에서 관리하고 alias를 단계적으로 제거한다.
- upstream은 pinned source + provenance + AICC adapter/patch로 흡수한다.
- 모든 mutation은 preimage/post-read/rollback을 가진다.
- 새 기능은 기존 failure domain과 격리된 상태에서 canary 후 승격한다.

## 기존 코드와 canonical 역할 매핑

| Canonical role | 현재 구현/근거 | 처리 |
|---|---|---|
| AICC Control Plane | `src/control-plane/*` | 유지·확장 |
| AICC Work Ledger | `report-store.mjs`, session registry, user-action ledger | 하나의 resume contract로 통합 |
| AICC Workspace MCP | `components/workspace-mcp/*` | stable ABI 유지 |
| AICC Browser Pool | `src/browser/session-broker.mjs`, `cdp-lease-provider.mjs`, CDP slot scripts | canonical display/registry로 승격 |
| AICC Resource Lease | workspace/browser별 lease 구현 | 공통 resource ownership schema 추가 |
| AICC Focus Guard | 여러 UI/browser guidance에 분산 | 공통 decision/lease gate 추가 |
| AICC Auth Broker | OAuth/browser/login 로직에 분산 | authorized session lifecycle 계층 추가 |
| AICC File Guard | backup/receipt/rollback 패턴에 분산 | 공통 mutation guard 추가 |
| AICC Web Bridge | current `WebGPT` / 17841 | compatibility alias 유지 후 단계 migration |
| AICC Relay | NexusDock 기반 후보 | isolated fork/adapter POC |
| AICC Endpoint | AgentDock 기반 후보 | isolated fork/adapter POC |
| AICC Remote App | ChatGPT Custom MCP App | Relay/Endpoint acceptance 후 생성 |
| RDC Recovery Path | Remote Desktop Commander | 독립 유지 |

## Phase 1 — Naming registry와 compatibility map

구현:
- `src/control-plane/component-identity.mjs`에 canonical ID/display name/aliases/upstream role 정의
- stable machine identifiers를 compatibility alias로 등록
- 신규 코드와 dashboard는 canonical ID를 사용
- alias는 validation 없이 임의 추가하지 않음

Acceptance:
- duplicate canonical ID/alias 거부
- upstream 이름이 production canonical ID로 노출되지 않음
- WebGPT/remote-gateway 등 legacy alias 조회 가능

## Phase 2 — AICC Work Ledger

목표: 대화가 끊겨도 새 AI가 즉시 재개.

기존 control report/session registry/user-action/current work log를 하나의 read model로 연결한다.
새로운 monolithic DB를 만들지 않고 기존 append-only/receipt 구조 위에 resume snapshot을 만든다.

필수 resume fields:
- objective
- constraints
- decisions
- completed
- current
- evidence
- remaining
- next_gate
- rollback
- resource_leases
- updated_at

Acceptance:
- 새 세션이 transcript 없이 resume 가능
- stale worker sequence 거부
- concurrent report conflict fail-closed
- secret-like content rejection 유지

## Phase 3 — AICC Resource Lease

기존 workspace/browser lease를 대체하지 않고 공통 resource ownership envelope를 추가한다.

resource types:
- workspace-writer
- browser-slot
- browser-target
- ui-focus
- terminal-session
- deployment
- credential-writer
- file-mutation

Acceptance:
- same resource single writer
- independent resources 병렬 실행
- stale PID reuse로 owner 오판 금지
- heartbeat/expiry/generation/reconcile

## Phase 4 — Browser Pool + Focus Guard

기존 BrowserSessionBroker/CDP Lease Provider를 기반으로:
- CDP slot 자동 선택
- profile root 격리
- task-created target only
- exact target lease
- background-first executor selection
- user activity 시 foreground mutation HOLD
- focus restore

Acceptance:
- 동시에 2개 이상 AI browser job이 서로 다른 slot 사용
- 같은 slot 경쟁은 한쪽만 성공
- user daily Chrome target 무변경
- 좌표 클릭은 structured approach 불가 시에만 허용

## Phase 5 — AICC File Guard

공통 file mutation transaction을 추가한다.

기본:
- exact root containment
- lstat/realpath
- symlink/junction guard
- preimage/hash
- atomic temp+rename
- quarantine over delete
- post-read/hash
- rollback receipt

Acceptance:
- wrong-root/wildcard/broad delete 거부
- unrelated dirty file 보존
- simulated partial write rollback
- delete는 explicit destructive contract 없으면 거부

## Phase 6 — AICC Auth Broker

목표: 로그인/session을 가능한 범위에서 자동 유지.

기능:
- OS-native credential store binding
- authorized OAuth refresh
- browser profile/session binding
- exact account identity check
- service restart restore
- session expiry detection
- reauth-required state

금지:
- MFA/CAPTCHA/security bypass
- password extraction
- quota 회피용 account rotation

Acceptance:
- reboot 후 authorized session 자동 복구
- wrong account/profile fail-closed
- expired session은 무한 retry하지 않음
- human reauth 필요 시 정확한 action만 반환

## Phase 7 — AICC Remote Fabric

### Upstream intake

1. AgentDock/NexusDock exact repo/revision/license 기록
2. pristine upstream mirror를 별도 vendor root에 보존
3. AICC integration code는 `components/remote-fabric/`에 둠
4. upstream 직접 수정이 필요하면 patch queue + reason + tests 유지
5. update 시 upstream diff -> patch rebase -> full acceptance

### AICC Endpoint
- unnecessary broad capability default-off
- AICC Workspace MCP downstream 연결
- AICC Auth/File/Focus/Lease policy 적용
- Windows hidden/background operation

### AICC Relay
- A1 ARM64
- private/loopback
- outbound endpoint connection
- transport auth
- node availability/reconnect
- existing OCX/quota/Slack services와 state/port 완전 분리

Acceptance:
- Windows reboot
- A1 restart
- network disconnect/reconnect
- duplicate endpoint
- stale device
- secret scan
- latency/resource budget

## Phase 8 — Observability / performance

측정:
- tool count/status
- p50/p95 latency
- reconnect time
- queue wait
- cache hit/miss
- result bytes
- lease conflict/replay counts
- browser slot utilization
- focus fallback count

slow path budget를 넘으면 기능 추가보다 병목 제거를 먼저 한다.

## Phase 9 — AICC Remote App

Relay/Endpoint read-only acceptance 후:
- Secure MCP Tunnel
- Create app -> MCP app
- Tool Scan
- schema snapshot
- offline/stale/timeout negative test
- ChatGPT -> Relay -> Endpoint -> Workspace read canary

write/command는 별도 gate.

## Phase 10 — Legacy naming migration

`WebGPT`, `remote-gateway`, 기타 legacy ID는:
1. display name 변경
2. alias/telemetry
3. source rename
4. tests
5. immutable release
6. cutover
7. deprecation period
8. 제거

포트/state path/tool ID는 이름 정리만을 이유로 바꾸지 않는다.

## 작업 우선순위

1. component identity registry
2. Work Ledger resume view
3. Resource Lease envelope
4. Browser Pool + Focus Guard
5. File Guard
6. Auth Broker
7. AICC Endpoint/Relay upstream intake/POC
8. Remote Fabric integration
9. observability/performance
10. ChatGPT Remote App
11. bounded write
12. legacy alias cleanup
## 현재 구현 상태 — 2026-09-26

| 단계 | 상태 | 현재 근거 | 다음 연결 |
|---|---|---|---|
| Canonical identity registry | SOURCE PASS | `component-identity.mjs`, 5 tests | immutable release 반영 |
| AICC Work Ledger resume view | SOURCE PASS | owner-local live resume target 복구, CLI source canary | session registry/report writer binding 개선, installed release 반영 |
| AICC Resource Lease | BROWSER INTEGRATED PASS | read/write conflict, expiry/restart/generation + BrowserSessionBroker `cdp:<port>` 공통 lease | workspace/deploy 등 나머지 domain 연결 |
| AICC Browser Pool | LIVE REGISTRY PASS | 실제 coordination registry + helper status를 매 acquire마다 재조회, 외부 busy/policy-excluded 제외, `cdp:<port>` exclusive lease | installed candidate에 연결 후 reboot/concurrency fault test |
| AICC Focus Guard | GUARDED CUA SOURCE PASS | Cua Driver 0.28.2 snapshot→background action→verify, foreground는 `background_unavailable`+승인+`GetLastInputInfo` idle+exclusive focus lease 필요 | Slack CAPTCHA/외부 CUA caller의 우회 불가 end-to-end 증명 |
| AICC File Guard | FIRST REAL ADOPTION PASS | rollback 계약 + 실제 `~/.codex/agents` 배포 create/update/quarantine/manifest/reverse rollback 적용 | 다른 high-risk 사용자 파일 mutation 경로로 점진 확대 |
| AICC Auth Broker | WEB/CDP LIVE PASS · OCX HOLD | Registered-CDP live restore + 17841 v2 runtime identity live PASS; OCX exact-account adapter는 no-switch 계약 PASS지만 현재 account management surface `not_found` | OCX topology/upstream account surface 원인 규명 |
| AICC Endpoint/Relay | PENDING | upstream 평가/POC 계획 | 안전 계층 이후 intake |
| AICC Remote App | PENDING | app/tunnel 설계 | Endpoint/Relay acceptance 이후 |

주의:
- source checkout PASS는 installed immutable release PASS와 다르다.
- 현재 `aicc.cmd` 설치본은 새 `work-ledger` 명령을 아직 포함하지 않는다.
- source 검증 완료 후 별도 immutable candidate/cutover gate에서 반영한다.

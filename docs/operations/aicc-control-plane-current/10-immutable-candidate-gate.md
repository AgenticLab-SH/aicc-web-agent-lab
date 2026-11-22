# AICC Immutable Candidate Gate

업데이트: 2026-09-27 21:55 KST

## 목적

현재 `C:\demo\open-AICC` source checkout의 신규 Control Plane 안전 계층을 installed immutable AICC release로 승격하기 전의 단일 gate이다. source acceptance, isolated candidate acceptance, installed cutover를 분리한다.

## 현재 판정

**SOURCE PASS / ISOLATED IMMUTABLE CANDIDATE PASS / NETWORK·REBOOT SURVIVAL HOLD / INSTALLED CUTOVER HOLD**

현재 최종 passing candidate:
- path: `C:\demo\owner\.codex\releases\open-aicc\controlplane-40169375`
- working-tree fingerprint: `40169375fe3696ce71f2d7485656475d9d6c3e07764c2ff5c415543e92062070`
- full manifest SHA-256: `03bd9608072b73ab6556e02c612801473a3773509f7c5b39c6fb3a7ae1fb77d6`
- sealed manifest inventory: 6,836 files
- task-owned overlay: 89 paths
- source HEAD: `6e44d66be899dd348e127c74c54acddf320e5ca3`
- verified base manifest: `3085387e624027c56cd5019653b6bffd5097f9ad043ad1050bbb0e534f623761`
- overlay spec SHA-256: `56caa87304ce59b1cc42966b44700763661bfcc9d0bd382698e27340a6f17477`

live installed route는 의도적으로 아직 기존 verified base `a1client-cc582dfa`를 가리킨다. candidate는 production route에 연결하지 않았다.

## r3 packaging 정리

이전 passing candidate `controlplane-52539e1e`의 runtime은 정상이나, candidate fingerprint를 다시 source 문서에 기록하는 `00/02/09/10/12` dynamic 운영 원장을 overlay에 포함하면 source 기록 갱신이 다시 candidate input을 바꾸는 자기참조 drift가 생긴다.

이를 제거하기 위해:
1. dynamic 운영 원장 5개는 candidate overlay에서 제외했다.
2. runtime/static contract 89개 path만 sealed candidate input으로 유지했다.
3. 진행 상태와 candidate hash는 source-side canonical ledger가 기록한다.
4. sealed candidate 내부의 `.aicc-candidate-overlay.json`이 exact build receipt 역할을 한다.
5. unrelated dirty Workspace MCP 파일은 계속 구조적으로 제외한다.

## 통과한 Source·Candidate 안전 계약

- Work Ledger resume view
- task/actor/generation 기반 Resource Lease
- live registered-CDP inventory와 exclusive Browser Pool
- BrowserSessionBroker exact target capability + common browser-slot lease
- Focus Guard + Guarded CUA Driver
- runtime direct `cua-driver` 호출 중앙화
- Slack CAPTCHA exact browser/resource lease background-browser only
- Windows recent-user-activity fail-closed
- File Guard exact-preimage / quarantine / rollback
- Codex agents partial-failure reverse rollback
- Registered-CDP Auth Broker
- AICC Web Bridge v2 identity binding
- OCX no-switch exact-account adapter
- A1 Hub raw account ID 비노출 SHA-256 identity observer
- Restore V2 no-replay / same-attempt reconcile
- installed-route atomic junction swap
- Node-independent hash-bound PowerShell rollback
- verified-base + explicit-overlay immutable builder

## Acceptance 증거

| Gate | 조건 | 현재 |
|---|---|---|
| Source focused acceptance | fault/concurrency/auth/CUA | PASS |
| Packaging/recovery focused suite | builder + Restore V2 + installed route | 19/19 PASS |
| Candidate r3 full-tree seal | manifest 전체 inventory exact hash | PASS, 6,836/6,836 |
| Candidate r3 Node smoke | Control Plane/browser/auth/CUA/Slack/restore | 198 PASS / 1 platform skip / 0 fail |
| Candidate r3 A1 Python suite | Hub watcher + identity-status | 13/13 PASS |
| Candidate r3 CLI read-only smoke | `restore`, Work Ledger | PASS, exit 0 |
| Read-only non-mutation | isolated state에서 restore journal 미생성 | PASS |
| OCX hashed identity live | raw ID 비노출, exact active identity | PASS, 4 identities / active 1 |
| Independent rollback | hash-bound PowerShell exact old junction recovery | PASS |
| Live route preservation | candidate smoke 동안 production route 미변경 | PASS, `a1client-cc582dfa` 유지 |
| Network interruption survival | exact idle 후 tunnel stop/reconnect | HOLD — live Codex task active |
| Reboot survival | exact idle 후 actual reboot canary | HOLD — live Codex task active |
| Post-smoke full manifest reverify | r3 6,836 files | PASS, 동일 manifest `03bd9608072b73ab6556e02c612801473a3773509f7c5b39c6fb3a7ae1fb77d6` |

현재 exact-idle gate:
- `aicc codex-desktop status --json`: `safe=false`
- active tasks: 2
- 두 active record 모두 PID 24840 (`codex.exe ... app-server`), 최근 timestamp 2026-09-27T13:44:46Z
- unknown: 0
- 5분 bounded idle watcher도 `HOLD_TIMEOUT`으로 종료됐으므로 10101/10102 tunnel 중단, reboot, live junction cutover를 실행하지 않는다.
- network canary는 `a1-hub-tunnel-survival-receipt.json`에 durable PASS/HOLD receipt를 남기며, 현재 `codex_not_exact_idle` HOLD_PRE_DISPATCH를 기록했다.

reboot survival 정의:
- `AICC-A1-Hub-Tunnel`과 `opencodex-proxy`는 모두 Interactive 사용자 로그온 trigger이며 AutoAdminLogon은 비활성이다.
- 따라서 검증 대상은 **Windows reboot → 정상 사용자 로그온 → A1 tunnel/OCX 자동 복구 → post-logon receipt**이다.
- `AICC-Reboot-Survival-Canary` 로그온 task를 설치했고 수동 실행 경로는 정상 PASS였다.
- `reboot-survival-baseline.json`의 이전 boot ID와 새 boot ID를 비교해, 단순 로그아웃/로그인에서는 `boot_not_changed`로 fail-closed한다.
- actual reboot는 exact idle 전에는 실행하지 않는다.

## Candidate packaging 규칙

1. 기존 installed release를 in-place 수정하지 않는다.
2. verified immutable installed release를 candidate base로 사용한다.
3. `13-candidate-overlay.json`의 explicit task-owned static/runtime path만 overlay한다.
4. dynamic candidate-status ledger는 candidate input에서 제외한다.
5. overlay 밖 dirty working-tree 파일은 candidate에 들어가지 않는다.
6. source HEAD, base manifest, overlay spec, 각 overlay SHA-256/size로 working-tree fingerprint를 만든다.
7. overlay 후 candidate 전체를 다시 seal하고 전 파일을 재검증한다.
8. 실패 candidate와 이전 passing candidate는 증거로 보존하고 수정하지 않는다.
9. cutover는 exact-idle + atomic junction swap + post-read 방식으로만 수행한다.
10. foreground CUA는 cutover canary에 포함하지 않는다.

## 다음 실행 순서

1. active Codex task가 0이 될 때까지 mutation 없이 exact-idle gate 재확인
2. `controlplane-40169375` full manifest post-smoke reverify 완료 확인
3. exact idle이면 10101/10102 A1 tunnel controlled interruption → fail-closed 확인 → existing ensure script로 reconnect
4. reconnect 후 OCX status + A1 hashed identity + candidate manifest 확인
5. 실제 Windows reboot 후 route/tunnel/state reconnect canary
6. post-reboot read-only → safe write → browser → CUA background → auth canary
7. 전부 PASS할 때만 live junction atomic cutover 판단

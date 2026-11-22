# AICC 복구·통합 최종 실행계획

상태: **사용자 승인 완료 — 다음 Codex 작업에서 적용 대기 / 운영 구현 미착수**

2026-08-23 추가 Pro 지식 자료, LLM Wiki 대조와 최신 ChatGPT plugin 구조를 반영한 override는
[`docs/operations/aicc-next-thread-handoff/00-index.md`](operations/aicc-next-thread-handoff/00-index.md)다.
실제 구현 순서가 충돌하면 해당 index와 `06-next-task-execution-plan.md`를 우선한다.

이 문서는 AICC의 반복 장애를 한 번의 유지보수 창에서 근본적으로 닫기 위한 승인용 실행 정본이다.
한 번의 창은 여러 구성요소를 동시에 재시작한다는 뜻이 아니다. 전체 topology와 rollback을 먼저 봉인한
뒤, 각 failure domain을 독립된 one-shot checkpoint로 순차 적용한다는 뜻이다.

## Pro 최종 검토와 로컬 판정

Account 3 Personal Pro의 exact registered 9224 CDP saved Chat에 최종 패킷을 한 번 제출했고, Chat/Pro,
계정·Workspace identity, 첨부 1개와 1 user/1 assistant lineage를 post-read했다. 재전송과 fallback은 0회였다.
최종 verdict는 `APPROVE_WITH_CHANGES`다.

로컬 source와 테스트에 대조한 disposition은 다음과 같다.

| 판정 | 반영 내용 |
| --- | --- |
| 채택 | 하나의 control plane과 분리된 failure domain, one-shot/no-replay, 공통 attempt journal 우선, route-local readiness, inventory-before-publication |
| 수정 채택 | HOLD 전파를 전역이 아니라 dependency DAG 범위로 제한하고, 공통 journal → restore candidate → 격리 테스트 → live CLI 순으로 변경 |
| 수정 채택 | callback·compaction reconcile을 duplicate quarantine보다 먼저 닫고, quarantine은 core closure 뒤 비핵심 tail로 이동 |
| 보류 | 과거 launchd exit 5의 OS 원인을 재현 없이 확정하지 않는다. current registration/provenance/process/socket/rollback을 exact evidence로 닫는다. |
| 거부 | hard delete, broad reinstall, blind retry, 권한 UI 설정으로 로컬 safety contract를 우회하는 안은 이번 창에 포함하지 않는다. |

패킷 기준 독립 import closure가 있는 suite는 55/55 PASS였고, 현재 작업공간의 집중 suite는 122/122
PASS였다. 그러나 패킷에 실제 signed App Server writer와 일부 transitive source가 없었으므로 이를 full source
closure로 승격하지 않는다. 현재 `src/aicc-restore.mjs`도 목표 v2가 아니라 v1 schema/engine이며, live
`aicc restore`는 sealed legacy pointer를 사용한다. 따라서 아래 Phase A가 첫 구현 범위다.

## 결과 목표

완료 뒤 사용자는 다음을 기대할 수 있어야 한다.

- 문제가 생기면 경로에 관계없이 `aicc restore`로 상태와 안전한 복구 대상을 확인한다.
- 모든 복구 시도는 표준 owner-only 위치에 pre/post/log/result/rollback을 남긴다.
- 502·503·JSONL 손상·first-action hang을 하나의 원인으로 추정하지 않고 request phase와 process
  generation으로 정확한 실패 구역을 구분한다.
- 17841이 고장 나도 17842, 10100, Native direct와 Workspace read-only control plane은 살아 있다.
- Business 두 계정은 같은 22-tool binding을 공유하고 Personal은 별도 18-tool read-only binding을
  유지한다.
- duplicate app은 canonical lineage 검증 뒤 하나씩 quarantine하며 이번 작업에서 hard delete하지 않는다.
- Project·Custom GPT·Notion의 이미 검증된 remote 자산은 다시 생성하거나 동기화하지 않는다.
- source, installed, runtime, browser-visible, publication, callback와 compaction/default-route를 각각
  증명한다.

## 불변 아키텍처

```text
Codex default route ─ Integrated 17841 ─┬─ ChatGPT browser branch
                                        └─ OCX upstream 10100 branch

Web GPT direct rescue ─ 17842
OCX direct rescue     ─ 10100
Native rescue         ─ official Codex endpoint

Business Workspace   ─ full binding, 22 = 17 read + 5 write
Personal Workspace   ─ read-only replica, 18 = 18 read + 0 write
```

공유하는 것은 inventory, fingerprint, activity gate, operation order, policy와 result index뿐이다.
process, label, config, socket, authentication, state root, browser mapping, Tunnel, publication과 rollback은
각 구성요소가 소유한다. ChatGPT의 Work surface는 사용하지 않는다.

## 실행 전 공통 계약

1. 사용자의 최종 승인 전에는 운영 mutation을 시작하지 않는다.
2. exact target의 active 또는 UNKNOWN이 하나라도 있으면 mutation은 0회다.
3. 모든 단계는 새 operation ID, fresh pre-snapshot, one writer, exact component lease를 사용한다.
4. dispatch 후 결과가 불명확하면 `UNCERTAIN`으로 봉인하고 같은 side effect를 재실행하지 않는다.
5. 이전 단계가 `PASS` 또는 명시적 `NOT_APPLICABLE`이 아니면 다음 단계로 가지 않는다.
6. 비대상 route·Workspace·browser identity가 변하면 즉시 HOLD한다.
7. prompt, cookie, token, auth header, raw conversation과 browser profile은 evidence에 기록하지 않는다.
8. 큰 변경 전에 status, stop, restore 명령과 복구 스크립트를 먼저 제공한다.

## Phase A — 복구·증거 기반을 먼저 완성

### A0. source와 installed entry closure

실제 CLI entry, launchd installer/service, Workspace topology/tool manifest/server-side write handler, publication
driver/post-read, registered-CDP identity helper, compaction adapter와 installed bundle manifest까지 import closure를
만든다. signed App Server writer는 외부 component로 명시하고, AICC가 소유한 parent reader 범위만 수정한다.

성공 조건은 selected/full tests, import closure, source-to-bundle hash, secret scan과 installed entry post-read다.
하나라도 빠지면 source PASS를 installed PASS로 승격하지 않는다.

### A1. 공통 durable attempt journal

신규 `src/control-plane/durable-attempt-journal.mjs`를 중심으로 coordinator는 dependency DAG만 소유하고,
component adapter가 inspect/apply/verify/reconcile을 담당한다. 한 attempt에는 component ID 하나만 허용한다.

```text
invocation_received → parsed | parse_rejected → gate_sampled → inspected
→ preimage_sealed → backup_sealed → commit_reserved → dispatch_started
→ dispatch_acknowledged → postread_observed → verification_passed | verification_failed
→ rollback_reserved → rollback_started → rollback_verified → terminal
```

모든 event는 operation/attempt/component/request hash, monotonic sequence, previous-event hash, process start token,
executable/bundle/config hash와 route generation을 갖고 owner-only bounded journal에 fsync한다. parser rejection,
help, status와 dry-run도 terminal artifact를 만든다. `dispatch_started` 전까지만 stop할 수 있고, 그 뒤 stop은
kill이 아니라 `RECONCILE_REQUIRED`다.

성공 조건:

- crash-before/after-dispatch, fsync failure, PID reuse, stale lease와 stop 경계 fault test PASS.
- journal 실패 시 mutation 0 또는 typed UNKNOWN/HOLD이며 effect를 추측하지 않음.

### A2. absolute-path restore v2 candidate와 live CLI 연결

대상은 `src/cli.mjs`, `src/aicc-recovery-command.mjs`, `src/aicc-restore.mjs`와 관련 schema/tests다. 현재 sealed
pointer는 legacy rollback adapter로 유지한 채, v2 candidate를 절대경로로 L0/L1에서 먼저 검증한다.

필수 동작:

- 인자 없는 `aicc restore`의 기본값은 read-only status이며 자동 apply하지 않는다.
- `--help`, `--status`, `--dry-run`, parser failure도 A1 형식으로 기록한다.
- apply는 exact component, operation/attempt ID, expected generation, backup과 rollback target이 없으면 거부한다.
- health UNKNOWN만으로 cold start하지 않는다. label/PID/listener/socket absent, provenance valid, active exact zero,
  owner/lease 없음과 one-shot post-read가 모두 정의된 component만 cold start 가능하다.
- live CLI routing 전환 자체를 별도 rollback unit으로 다룬다.

성공 조건:

- fake runner fault matrix와 owner-only permission test PASS.
- absolute-path candidate와 live CLI status/dry-run artifact post-read.
- 기존 sealed pointer hash 보존과 exact preimage rollback 리허설 PASS.

중단 조건:

- journal/lock/fsync/preimage seal 실패, parser ambiguity, path dependence, unrelated state write.

### A3. end-to-end request journal, route readiness와 watchdog

request phase는 다음을 사용한다.

```text
accepted → classified → route_selected → dispatched → upstream_started
→ first_progress → response_started → terminal | stalled_unknown
```

각 event는 request ID, HMAC thread/turn refs, route generation, requested/selected model, branch, upstream class,
process start token, executable/bundle/config hash, browser generation과 typed status만 저장한다. raw prompt, token,
cookie, auth header와 conversation은 저장하지 않는다. `x-aicc-request-id`를 반환하고 native/browser/compaction
readiness를 route별로 분리한다.

AICC 소유 App Server parent reader는 raw chunk sequence, byte length/hash, newline count, complete-line sequence,
trailing-partial length/hash와 child exit/signal ordering을 기록한다. writer-emitted sequence는 upstream 지원 전까지
UNKNOWN이다. `task_started` 뒤 progress가 없으면 `stalled_unknown`으로 분류하며 자동 kill·재전송하지 않고
Native same-thread recovery handoff만 허용한다.

필수 회귀에는 63,999/65,536/65,537/1MiB valid frame, UTF-8 split, abrupt exit, trailing/interior partial,
parallel burst, interrupted/orphaned resume, first-action stall, journal overload와 route-local PASS/HOLD가 포함된다.

### A4. remote effect durable reconciliation

callback, Workspace write/publication과 compaction은 effect별 semantics를 유지하면서 다음 공통 transition을 쓴다.

```text
reserved → preimage_verified → dispatch_started → acknowledged
→ postread_observed → PASS | NO_EFFECT | UNCERTAIN | ROLLED_BACK
```

ACK unknown이면 authoritative post-read만 수행한다. 원래 create/save/send/write/compact를 재실행하지 않는다.
`turn_aborted`, `task_complete`, failed와 stalled를 exact task/thread/turn/request identity로 구분한다. callback은
client message ID로 exact 0/1/2 turn을 reconcile하고, remote write request ID는 effect 전 consumed 처리하지
않는다. compaction은 authoritative result/no-effect/reconcile 경로가 생기기 전 canary를 HOLD한다.

## Phase B — 격리 후보와 main 무변경 증명

### B1. L0

- temp AICC state root
- fake launchctl/browser/Tunnel
- network deny
- deterministic clock/process identity fixtures

### B2. L1

- immutable candidate bundle
- unique label, random port, separate state root
- account credential 없음
- restore/request journal/JSONL/watchdog/outbox fault matrix

### B3. L2

- live config, route, manifest와 publication metadata의 read-only mirror
- write API와 real browser target 생성 없음

### B4. 9226

- 로그인 없는 dashboard shell과 responsive/error-state QA
- account, plugin과 publication canary는 하지 않음

성공 조건:

- main label/port/config/state/account/browser의 write diff 0.
- nearest tests와 `npm run verify:mac` PASS.
- candidate의 source→bundle reproducibility와 rollback bytes PASS.

## Phase C — 유지보수 창 one-shot 순서

### M0. session freeze와 survival baseline

현재 Codex turn이 terminal이 된 뒤 target route와 무관한 로컬 maintenance CLI process가 session owner가
된다. 승인 scope hash와 dependency DAG를 봉인하고 2초 간격 5회 동안 다음이 exact zero/known이며 generation이
같은지 확인한다.

- 관련 Codex active/UNKNOWN
- 17841 HTTP/browser-HTTP/browser counters
- 대상 Workspace lease
- browser task target conflict
- component writer/operation conflict

17842, 10100, Native direct, Business와 Personal 상태를 pre-snapshot으로 봉인한다. 공통 journal·maintenance
owner·browser broker identity의 UNKNOWN은 전체 mutation을 HOLD한다. 특정 Workspace component의 HOLD는 그
component와 의존 단계에만 전파하고 독립 read-only 진단과 survival 확인은 계속한다.

### M1. restore v2 live CLI route 전환

A1/A2의 absolute-path candidate, legacy sealed pointer와 Native same-thread rescue를 다시 post-read한다. 첫 운영
mutation은 CLI entry/routing만 exact preimage에서 v2로 전환하는 별도 attempt다.

- Backup: 기존 executable/symlink, CLI route, sealed pointer JSON/script/hash.
- Success: no-arg status-only, status/dry-run/parser-failure journal, installed entry hash와 rollback 리허설 PASS.
- Stop: path dependence, journal 누락, pointer hash mismatch, unrelated diff.
- Rollback: CLI route와 pointer만 exact old preimage로 atomic 복원.

### M2. 17841 launchd·runtime transaction

먼저 현재 상태를 read-only로 닫는다.

- plist syntax/hash와 loaded ProgramArguments
- disabled state와 user-domain registration
- listener owner와 PID reuse를 배제한 process start identity
- executable/wrapper/manifest provenance, permission, quarantine, signing과 path
- stale label, orphan PID/socket와 unload ordering

역사적 exit 5의 OS 원인을 재현 없이 확정할 필요는 없지만 위 current state가 UNKNOWN이면 진행하지 않는다.
exact preimage와 rollback이 닫히면 다음 candidate transaction을 한 번 수행한다.

```text
exact bootout
→ label/PID/start-token/listener/socket 소멸 증명
→ staged plist validation + atomic install
→ candidate bootstrap once
→ loaded job/process/listener post-read
```

nonzero 뒤 같은 bootstrap을 반복하지 않는다. candidate job이 실제 존재하면 verify하고, 존재하지 않으며 old
preimage가 valid할 때만 old unit을 별도 rollback attempt로 한 번 bootstrap한다. 17842, 10100과 Native는
관찰만 하며 재시작하지 않는다.

### M3. 17841 route별 readiness와 response canary

listener와 aggregate health만으로 ready라고 하지 않는다. service/current bundle identity, accepting turns,
native/browser dependency, exact counters, route generation과 bounded terminal을 함께 확인한다.

순서는 native branch side-effect-free response → browser preflight → 승인된 saved Chat browser response 1회다.
request ID부터 terminal까지 같은 journal generation이어야 한다. target/account mismatch, first-progress timeout 또는
persistence ambiguity면 해당 route를 HOLD하고 재전송하지 않는다. 이 단계에서는 compaction을 수행하지 않는다.

### M4. Workspace local installed/runtime identity

Business와 Personal을 별도 read-only component로 확인한다.

1. source manifest와 installed package/runtime marker/Tunnel/lease 대조
2. Business 22/17/5와 Personal 18/18/0을 current generation에 결속
3. 이미 current/ready이면 reinstall/restart를 `NOT_APPLICABLE`로 기록
4. mismatch가 있으면 publication 전에 exact component install/cutover 계획만 생성

한 surface의 실패가 다른 surface를 변경하거나 rollback하지 않는다.

### M5. 세 계정 app/plugin read-only inventory와 branch 결정

registered CDP를 다음 순서로 직렬화한다.

```text
9224 Account 3 Personal Pro
→ 9222 Account 1 Business owner
→ 9223 Account 2 Business member
```

첫 validation은 Account 3의 task-owned saved Chat에서 one-shot post-read와 lineage를 확인한다. 각 binding에서
observed app ID, canonical stable ID, account/workspace identity hash, package/version/hash, frozen publication
revision/manifest/tool schema, risk/action policy, sharing, runtime generation과 current canary proof를 수집한다.

이름은 authority가 아니다. 404/451, incomplete inventory, target/account drift 또는 same-ID lineage 불명은
해당 branch HOLD다. Account 3의 Personal mismatch는 Business read-only inventory를 막지 않지만 broker/target
identity 공통 결함은 모든 CDP 작업을 중단한다.

### M6. publication·권한·세 계정 canary

논리 plugin ID는 `aicc-workspace` 하나지만 물리 publication lineage는 Business와 Personal 두 개다.

- KEEP: Business shared 22-tool과 Personal separate 18-tool manifest/revision/lineage가 exact면 mutation 0.
- SAME-ID UPDATE: authoritative same-ID update, exact post-read와 prior revision rollback을 모두 지원할 때만 수행.
- HOLD: lineage/manifest/identity/capability/rollback 중 하나라도 불명확.
- NEW STABLE ID: 이번 승인 범위가 아니며 별도 remote transaction 승인 필요.

제품이 지원하는 경우 Business app의 `Never ask`/action control을 사용해 반복 prompt를 줄인다. 이 설정은
single writer, durable lease, request ID, scratch target, post-read/rollback과 제품 필수 confirmation을 대체하지
않는다. Personal은 catalog와 server handler 양쪽에서 write를 거부한다.

| 계정 역할 | read/retrieval | reversible write | write deny | lineage |
| --- | --- | --- | --- | --- |
| Business owner | PASS 필요 | dedicated scratch에서 PASS | N/A | shared stable |
| Business member | PASS 필요 | 실제 policy가 허용할 때만 PASS, 아니면 expected deny | N/A | same shared stable |
| Personal Pro | PASS 필요 | 금지 | forged call도 PASS 필요 | separate replica |

### M7. callback E2E와 compaction

callback을 먼저 수행한다. side effect 없는 terminal result 하나로 exact task/root/result/executable/manifest,
client message ID 하나, turn 하나와 terminal 하나를 증명한다. `task_started`, `task_complete`, `turn_aborted`,
failed와 stalled를 분리하고 ACK unknown이면 exact thread read만 수행한다.

callback PASS 뒤 compaction ledger v2의 authoritative result/no-effect/reconcile 경로를 검증한다. 그 뒤 V2와
필요한 legacy V1 canary를 각각 새 one-shot request로 수행한다. remote send/compaction을 되돌리거나 같은
request를 재전송하지 않는다.

### M8. default route CAS와 RCA closure

필요한 acceptance가 같은 current generation에서 PASS한 경우에만 expected-old-generation CAS로 default
route를 promotion한다. conflict 뒤 blind write하지 않고 current generation으로 새 plan을 만든다. canary
failure면 expected-new-generation CAS로 old route를 복원한다.

최종 RCA는 confirmed root cause, contributing factors, disproved hypotheses, still UNKNOWN, exact evidence,
fixes/regression tests, operator one-line recovery와 preserved failure domains를 분리한다. 남은 UNKNOWN이 있으면
“원인 해결 완료”라고 보고하지 않고, 그 UNKNOWN이 다른 route/control plane을 중단시키지 못한다는 containment
evidence를 남긴다.

### M9. duplicate quarantine — 비핵심 tail

core route, account canary, callback/compaction과 default-route closure 뒤 exact obsolete ID 하나씩
disable/unshare한다. 매번 reference-zero, inventory와 canonical app canary를 post-read한다. ambiguous 결과면
중단하고 exact 대상만 re-enable/reshare한다. 최소 14일 quarantine과 rollback rehearsal을 유지하며 hard
delete는 이번 계획에서 금지한다. cleanup HOLD는 이미 PASS한 core route를 다시 변경하지 않는다.

## 구현 batch와 exact source 경계

| Batch | 주요 파일·symbol | 완료 기준 |
| --- | --- | --- |
| S0 source closure | `src/cli.mjs`, `src/control-plane/registry.mjs`, Workspace tool manifest/server, launchd installer, publication/CDP/compaction adapter | selected test import closure와 installed entry hash |
| S1 attempt/restore | 신규 `durable-attempt-journal.mjs`, `MaintenanceCoordinator.plan/execute`, `parseAiccRestoreArgs`, `createAiccRestoreService`, `runAiccRestoreCli` | crash/fsync/PID-reuse/no-arg/status/dry-run/one-component fault matrix |
| S2 request/transport | Integrated server request correlation/readiness, `src/adapters/codex-app-server.mjs`, `src/codex-desktop-transport-diagnostics.mjs` | route별 readiness, request phase chain, partial JSONL metadata, secret scan |
| S3 launchd | `bootstrapServiceOnce`, `waitForJobProcessSocketGone`, `inspectLaunchdIdentity`, `restartServiceTransaction`, preimage/reconcile/restore helpers | candidate bootstrap 최대 1회와 rollback separate attempt |
| S4 remote reconcile | `CodexTaskCallbackService`, `DurableRemoteWriterAuthorizer`, Workspace write handler, compaction ledger | ACK 전/후 loss, process death, exact 0/1/2 turn, duplicate effect 0 |
| S5 Workspace | `planWorkspaceAppCleanup/Sync`, `verifyWorkspaceAppSyncPostRead`, status/sync executor와 server-side Personal deny | canonical/observed ID, frozen revision, stale PASS 방지, delete action 0 |
| S6 exact CDP | exact-target attachment/navigation, Pro picker, inventory-only registered-CDP driver, prompt/attachment transport | about:blank bounded wait, foreign target fail, picker variants, attachment limit HOLD |
| S7 orchestration | 신규 maintenance session/acceptance vector/survival observer와 fault-injection suite | DAG-scoped HOLD, main diff 0, same-generation acceptance matrix |

source 작업은 공통 journal interface 확정 뒤 S2~S6의 fake/L0 테스트를 병렬화할 수 있다. live CLI pointer,
17841 bootout/bootstrap, registered-CDP 접근, publication/write canary, callback send, compaction, route CAS와
quarantine은 반드시 직렬화한다.

## 복구 명령 제공 형식

실제 구현 전 사용자에게 다음 명령군을 절대경로 의존 없이 제공한다. exact 옵션은 구현 결과와 dry-run
evidence가 확정된 뒤 채운다.

```bash
aicc restore
aicc restore <exact-component> --status
aicc restore <exact-component> --dry-run
aicc restore <exact-component> --apply --operation-id <exact-operation>
aicc restore <exact-component> --reconcile --operation-id <exact-operation> --attempt-id <exact-attempt>
aicc restore <exact-component> --rollback --operation-id <exact-operation> --attempt-id <exact-attempt>
aicc restore --stop --operation-id <exact-operation> --attempt-id <exact-attempt>
aicc restore --legacy-pointer --status
```

단순 `aicc restore`는 항상 read-only status와 다음 명령만 출력하며 자동 apply하지 않는다. 명령 형태는
구현 목표이며, 실제 설치·dry-run evidence가 나오기 전에는 현재 CLI가 이를 지원한다고 주장하지 않는다.

## 최종 acceptance matrix

| Gate | PASS 조건 |
| --- | --- |
| Source | selected/full tests, static check, closure, secret scan |
| Installed | exact package/binary/config/plist/runtime marker hash |
| Runtime | listener/dependency vector/counters/current generation/canary |
| 17841 native/browser | route-local readiness와 각각의 bounded response terminal |
| Survival | 17842·10100·Native의 maintenance 전후 identity/health 불변 |
| Browser-visible | exact CDP account/workspace/Chat/model/tool/permission post-read |
| Publication | frozen manifest, stable ID/version/share/risk/action policy |
| Callback E2E | same task, one result, one turn, terminal, duplicate 0 |
| Compaction | V2 then legacy V1 each-once, ledger terminal/reconcile |
| Default route | same-generation acceptance와 CAS promotion/canary |

## 승인 뒤 시작할 첫 세 행동

1. 현재 turn을 terminal로 닫은 뒤 17841에 의존하지 않는 로컬 maintenance owner가 승인 scope hash와 새
   read-only snapshot을 봉인한다. exact idle이 아니면 `HOLD_PRE_DISPATCH`로 끝내고 source/test만 진행한다.
2. 공통 journal과 absolute-path restore v2 candidate를 구현하고 legacy pointer·Native rescue·첫 component
   preimage/rollback을 봉인한다. 이 단계까지 main mutation은 0이다.
3. L0 fault suite, L1 candidate one-shot, L2 main-diff-zero를 증명하고 사용자에게 실제 설치된
   status/stop/reconcile/rollback 명령을 먼저 제공한다. 모두 PASS일 때만 M1 live CLI route를 첫 운영
   mutation으로 수행한다.

Project/Custom GPT/Notion의 기존 remote 자산 재생성, 계정/login 변경, app hard delete는 이 승인에
포함되지 않는다.

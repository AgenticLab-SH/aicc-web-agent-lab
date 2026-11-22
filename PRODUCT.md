# open-AICC product frame

## 사용자 전체 현황 · 2026-11-20

PC·폰 사용자가 개발 범위를 이해하고 앱·보고·지시로 이동하는 읽기/운영 진입이다.
기존 중앙 기록에서 처음 목표·현재·잔여·다음을 투영한다. 그룹 10개를 빠뜨리지 않고
원 이력·작업 ID·기존 편집/큐를 보존한다. 새 작업 원장·모델 호출·완료율 추정은 없다.
정본 변경 시 오래된 요약임을 표시한다. 완료는 운영 배포·실제 화면 검증까지 구분한다.

## G1 중앙 CLI 원 5시간 한도 거절 후 단회재개 안전 계약 · 2026-11-10

목표는 동일 saved CLI conversation과 기존 goal을 **진짜** 5시간 OCX
거절 시 한도 해제 후 정확 1회 이어가기다. `Register/Enable`이나
reset 시계·프로세스 생성만으로 발신·ACK·goal 계속을 선언하지 않는다.

현재 source는 `Invoke-AiccCodexContinuity.ps1 -Action QuotaPreflight`
(ThreadId, StrictAccountNumber=2, QuotaDeadlineUtc)로 read-only
점검한다. installed strict sender가 직접 본 exact
`thread.started` + `turn.started` + `turn.failed`의 typed OCX
`usage_limit_reached`/`five_hour`/`resetAt`/원 turn hash를 요구하며,
일반 오류 문자열, 다른 account, 결과 불명, 주간 한도·Native 경로는
한도 재개 증거가 아니다. 실행기는 원 claim을 terminal 수용 뒤에도
보존하며 새 worker 재인가 전에는 자동 replay를 HOLD한다.

단회 재개는 원 2026-11-10 15:00 KST 이전, 동일 exact
thread/root/owner revision/stop epoch/route/원 goal, 원 terminal
issuer 권위, 원 작성권 반환, fresh 동일 OCX 계정
admission·quota, 사용자 중지 없음·ce9a 미결 조정·maintenance
worker 정상 활성화/정식 발신 경로를 모두 요구한다.
실제 queue ACK·새 turn·goal 착수는 별도 영수증으로 판단한다.

이번 진단에서 중앙 정확 CLI는 등록·활성·원 자체 pending 0이나
**strictAccount=null**, 별도의 original quota terminal receipt 없음,
worker STOPPED_FOR_MAINTENANCE/Task Disabled/stop fence 유지,
historical 원 ce9a pending 1임을 read-only 확인했다. 현재 active CLI
소유권을 넘겨받는 공식 once-only issuer API/owner revision binding은
없다. 단순 `exec resume`은 중복 모델 발신이자 작성권 탈취이므로 금지.

기존 strict bridge와 정식 `command-route-r2` CLI는 실제 sender
부품이지만 지금 중앙 대화에 발신할 수 있는 상태가 아니다.
새 quota helper는 source-only, 원 등록 helper pin은 이전 SHA로
유지한다. 기존 정식 maintenance source closure/immutable Apply
절차는 preview/원장 CAS·정상 rollback/독립 READY를 필요로 하고,
기존 `strictRouteLauncher`가 존재할 때 upgrade가 거절되는
설치기 제약도 중앙이 먼저 해결해야 한다. no Native fallback.

근접 5시간 quota 반례 17PASS, 기존 strict route 회귀 22PASS.
새 발신0·ACK0·새 turn0·실 goal 착수 미검증. 운영 적용은 중앙
인수 후 formal owner issuer/installer and consumed drain 별도.


## G1 Chrome Queue 실설치 전 owner issuer / native 후보 준비 (2026-11-10)

일반 Chat business-full의 4개 gptQueue 도구는 **새 소스 후보**이며,
실제 앱·공유 Workspace 설치본에 아직 노출되지 않았다. 기존 QueueOnly 트레이
`ac3ddcfe` 설치와 33개 pin은 별도 인수 완료 상태로 재설치하지 않는다.

등록 슬롯의 **원 CDP 소유자**는 `Manage-CdpChromeSlotLease.ps1`의
`QueueOwnerInspect`를 사용한다. 이 동작은 원 active `ready` lease의
`OwnerId`, `LeaseToken`, 정확한 `TargetId`, 슬롯/계정/workspace,
task-target nonce, 등록 Chrome 신원과 `https://chatgpt.com/c/<UUID>`
저장 대화를 조회해 120초 이내 증거를 반환한다. `ReadExisting` 읽기
임대나 포트 번호·트레이 익명 지문은 이 증거를 대신하지 못한다.
브라우저 자동시작·탭 활성화·새 메시지 발신·원 lease 반환은 하지 않는다.

정확 원 소유자가 발급한 비공개 요청 JSON과 SHA가 있을 때만
`tools/platform/web-automation/Prepare-GptQueueOwnerBinding.mjs`를
별도 owner-local CLI로 실행한다. 계정·대화·nonce·lease token을 원문으로
추정하거나 일반 Workspace 쓰기 파일에서 읽지 않는다. 원 요청의
`operationId/bindingId/ownerId/ownerIdentityHash/workspaceAlias/workspaceRoot/
title/roles[2]`와 각 role의 `id,slot,targetId,leaseToken,targetNonce,
conversationId,prompt,accountAlias,browserWorkspace`를 엄격히 확인한다.
원 등록 슬롯, 읽기 전용 현재 신원, native 설치 exe/config/manifest·
Chrome NativeMessagingHosts 등록을 교차 확인한다. 인증되지 않으면 HOLD.

원 요청이 성립한 경우에만 사용자별 비공개 경로에 role proof 2개,
SHA 고정 owner binding, business-full config **후보**와 영수증을
한 번 생성한다. 중복·일부 기록·원본 변경/만료 시 덮어쓰지 않는다.
`gptQueue.enabled` 실제 적용과 도구 게시·실제 target 인수는 별개.
등록은 일시 중지 저장일 뿐 발신이 아니며 원 결과 get/list/안전 cancel은
기존 소유자와 원장 상태로 판단한다. 120초 증거 만료 뒤 새 등록은
차단하되 원 작업 읽기/미발신 취소를 재시작 후에도 구분해 지원한다.

별개 `chatgpt-queue/deploy/windows/Install-WebGptQueueNativeHost.ps1`
`-Action Prepare [-DryRun]`은 기존 `Install`을 호출하지 않고
`runtime/webgpt-queue-native-prep/source-<SHA24>` 안에 exe·manifest
불변 후보만 생성한다. 기존 설치 native exe/config/manifest/등록과
원장 SHA·상태는 읽기 전용으로 기록하고 불명은 UNKNOWN으로 둔다.
기존 설치본은 변경하지 않았다. 준비 결과의 `canApply=false`는 의도된
보호이고, 현 설치 경로의 in-place `Install`은 안전 운영 교체 영수증을
제공하지 않으므로 **활성 서비스에 바로 사용하면 안 된다.**

Workspace `runtime-integrity` 소스 closure는 gpt-queue-provider 포함
SHA 봉인에 성공했고 business-full의 기존 26 → opt-in 후보 30도구(+4),
개인 `personal-read-fetch` 신규 도구 0이다. 이는 실제 remote app의
도구 수가 아니라 **현재 소스의 후보 계약**이다.
중앙은 원 issuer active 2slot 증거, 정확 임대/계정 승인, immutable
native 후보 인수와 원장 원본 백업, 구설치/후보·registry CAS, 독립
READY/3 provider active·UNKNOWN 0 consumed drain, 정식 owner-only
Apply/rollback 후 실설치 SHA 및 기존 ChatGPT 앱 새 action E2E를 분리
검증해야 한다. 기존 `ce9a`, Host 원 미반환, G3 `66da`는 변동 없음.
외부 트레이→Chrome확장 deep-link의 안전한 task-owned API는 아직 없어
기존 `chrome.tabs.update(active:true)`를 사용자 탭에 실행하지 않는다.


## G1 일반 Chat · 기존 WebGPT Queue owner-bound 도구 첫 인수 (2026-11-10, SOURCE-ONLY)

기존 Chrome Queue/native-host 원장만 사용한다. Workspace MCP business-full에 opt-in
gptQueue.enabled와 소유자 외부 SHA 고정 binding이 모두 있을 때만
aicc_gpt_queue_register/list/get/cancel 네 가지 명시 도구를 노출한다.
personal-read-fetch에는 신규 읽기·쓰기 도구를 노출하지 않는다.
등록 도구는 원 request_id/definition SHA, 정확한 등록 workspace, 계정
신원 해시, 원래 CDP owner의 대상·대화·64-hex nonce와 유효기간 120초의
외부 영수증, 설치 native-host exe/config SHA를 확인한다. 이는 트레이의
익명 작업 지문을 발신 권한으로 바꾸지 않는다.

새 native-host의 읽기 전용 orchestration_capabilities로 pausedRegistration과
revisionFencedCancel을 확인하기 전에는 등록을 실행하지 않는다. 등록 시
startPaused=true / registrationOnly=true로 원장에 저장되며 원 Role READY여도
worker claim은 불가하다. 기존 확장의 일반 등록(startPaused 미지정)은 이전처럼
동작한다. 원 등록 중복 ID·원응답 불명·오래된 target proof·다른 계정·
원본 drift는 새 ID 재전송이나 다른 slot으로 우회하지 않는다.

get/list는 같은 소유자의 고정 1건에 한해 송신·답변·도구 처리와
원장 상태를 구분하고, 프롬프트·원 대화 ID·토큰을 복제하지 않는다.
cancel은 원장이 paused이고 원 claim/dispatch/UNKNOWN이 없을 때만
expectedRevision CAS로 취소한다. 이것은 **실제 CDP target lease
반환이 아니며** 원 등록 target·작성권은 기존 원 소유자가 반환해야 한다.
원 다음 역할의 activation/claim/실제 메시지 전송은 아직 공식 일반 Chat
도구로 지원하지 않으며 HOLD다.

격리된 Workspace MCP 정식 도구 → 현재 native-host 소스를 재컴파일한
독립 원장 등록→get→cancel→readback은 1 PASS; owner/UNKNOWN/서명·
개인 read-only 근접 8 PASS, 별도 native-host 신계약 1 PASS.
실제 일반 Chat 도구 노출·기존 설치 runtime/API·대상 lease·실시간 재개는
**미확인/미설치**다. 후속 인수자는 소유자 바인딩·새 native-host release
pin·전체 Workspace runtime closure·공식 candidate/독립 READY/consumed drain
및 기존 앱 action 새로고침·실도구 회수로 단계별 적용한다.
원 ce9a/Host 원 UNKNOWN/G3 66da는 이번 도구와 독립된 HOLD로 유지한다.
트레이→확장 deep-link는 현재 확장의 내부 chrome.tabs.update 외에는
정식 외부 소유자 API가 확인되지 않아 사용자 탭·포커스를 잡지 않는다.


## G3 AI 통합 대시보드 · 2026-11-02

사용자는 PC와 폰에서 같은 보고를 읽고 그룹→프로젝트→기능을 정리하며 exact 대화에 보낼 다음 지시를 저장한다. 주 메뉴는 에이전트 보고 / 작업 / Queue & Goal이다. 운영·계정·트레이는 운영/설정에서 유지한다. 그룹 번호는 등록된 namespace를 따른다.

기존 index/mobile에 같은 모듈을 포함한다. portfolio·보고·세션·continuity·goal을 투영하고 설명/핀/명시적 미전송 지시만 project-catalog 확장 상태에 저장한다. 기존 task brief의 메모리 전용 계약은 유지한다. 분류 추가는 저장소·계정·에이전트 생성이 아니다.

저장/API 검사·설치·운영 서버·브라우저·실제 폰/APK를 분리한다. 자동 다음 실행·닫힌 대화 resume·호스트 mux 열기·목표 편집·사용자 응답 회수는 미연결이다. 네트워크 전용 PWA 진입은 Android 설치 완료가 아니다. 전체 잔여는 docs/dashboard-product-spec.md의 G3 절을 따른다.

## 사용자와 작업

The primary user is the owner operating several local AI routes, browser identities, Workspace apps, and recovery paths on one Mac. The recurring job is to answer three questions without memorising commands: what is usable now, which failure domain is blocked, and what is the smallest safe next action.

## Promise and completion evidence

open-AICC is a local operational ledger that keeps cumulative goals, configured source, installed bytes, live runtime, browser visibility, remote publication, and callback evidence separate. The job is complete when the owner can search and sort every goal, record personal review without falsifying operational status, identify every survival path, see UNKNOWN instead of a fabricated zero, and reach a component-scoped diagnostic or recovery action.

## 비목표

- The dashboard does not silently switch route, provider, account, browser, or workspace.
- It does not create, upload, publish, share, delete, or retry remote ChatGPT assets without the owning transaction.
- Historical acceptance and source tests do not become live PASS.
- The dashboard is not the long-running worker; durable local owners execute jobs.

## 제약과 위험

The surface is local-only vanilla HTML/CSS/JS with same-origin JSON APIs and no remote assets. Partial API failure, stale evidence, active/UNKNOWN gates, long Korean text, 320px reflow, keyboard operation, 200% zoom, and reduced motion are required states.

## One-click recovery promise

The Recovery Console exposes one prominent `최신 안전 복구` control and the cwd-independent `aicc restore` command. Both resolve only the latest owner-sealed exact component; ACTIVE, UNKNOWN, hash drift, a used recovery marker, or a failed status/dry-run closes the control. Every risky maintenance stage seals its own preimage before dispatch, and a completed or ambiguous dispatch cannot be replayed.

## Web GPT continuation settings

The Monitoring Center stores owner-local settings for the seven ChatGPT tabs in the user's Chrome tab group named `GPT`: check interval, stalled threshold, enabled flag, and three continuation messages. The Codex monitor skill reads the same file on its scheduled heartbeat. It verifies the user-designated Chrome anchor, the `GPT` group, and exactly seven unique tab IDs before acting. AICC edits configuration only; it does not control Chrome or claim that the Codex scheduler is running. Defaults and validation are defined in `specs/web-jjonku-monitoring/`.

## G1 Windows resource lifecycle follow-up (2026-11-08)

### Windows registered-browser lifetime boundary · accepted install / source-only gap (2026-11-10)

Central already installed the later official Host candidate and independently
verified ready/hash, real remote capabilities and workspace_list, CDP default
and Aside auxiliary. This accepted **installed Host route** replaces the
historical source-only deployment status in the older G1 entries.
An on-demand Aside attach is supported by the installed source and earlier
fake tests, **not** by an observed child-process exit or OS resource snapshot.

The registered Windows helper already supports explicit cold start with
exact identity verification and independent per-task target Acquire/Release.
Host's current CDP provider omits AllowBrowserStart, so an offline
browser is not silently started by Host open. The base Windows launcher can
create a standby page. Bounded target Release, the 600-second Host session
idle close and Playwright disconnect **do not establish whole Chrome Quit**.

No safe Windows whole-browser auto-quit has been proven: exact owner PID/
creation proof, zero active/UNKNOWN/retained leases, all page targets and
CDP clients absent, and supported normal process exit/ACK are needed together.
No matching live residency cause or same-condition RAM reduction was
measured; source helper and existing tests were not reimplemented or rerun.
Mac Dock/NSRunningApplication/SIGTERM instructions must not be used on
Windows. The detailed owner/operator gate is [Windows resource lifecycle](docs/runbooks/browser-resource-lifecycle.md#windows-등록-cdp-슬롯의-필요시-기동과-안전-반환-2026-11-10).
Original G1 ce9a/Host history and G3 66da UNKNOWN remain HOLD.
Central's next task is **read-only exact owned process/target/lease/client
inventory and installed launcher SHA**, then separate supported normal
exit validation only when the complete owner/idle/rollback gate is proven.
No new price research or server relocation performed.


### G1 recovery authority visibility · source-only (2026-11-10)

The still-blocked G1 auto-resume and Host returns have *different*
independent original-owner proof gates. The `ce9a` historical
`QUEUE_ACCEPTED` requires an issuer-bound original terminal settlement
and genuine normal owner handoff; the `yt_project_inspect_20261108_01`
`OUTCOME_UNKNOWN` open lacks recorded lease/target hashes and normal-close
proof. No other group or resource has been declared returned.

Small source-only diagnostics, without new tools or management services:
the existing GroupActivation readiness exposes pending-class counts and
the original issuer as the required actor; the existing Host status and
same-owner recovered inventory expose **boolean proof-presence fields**
(never actual hashes, profile, account or private paths). The pending
activation gate, owner boundary and `HOST_HISTORY_UNPROVEN` remain strict.
Original issuer inspection, verified receipt, live stop/close, installation
and end-to-end restart are **not** completed by these diagnostics.

Source paths: [continuity read-only checklist](docs/runbooks/codex-continuity-maintenance.md#g1-원-발신자-pending-근거-표시--source-only-2026-11-10),
[Host original return checklist](components/host-control/README.md#g1-original-owner-host-return-evidence-diagnosis--source-only-2026-11-10).


### G1 Aside on-demand resource return gate · source follow-up (2026-11-09)

The present `server.mjs` attaches Aside only when an admitted, explicit
Aside browser request or registered CUA app needs it; CDP default or
capabilities/inventory reads do not launch that executor. A narrow source
repair refuses normal close when the REPL has no proven owned page and
does not mark a session `CLOSED` until both tab close and executor
transport close succeed. Host shutdown no longer normally closes
recently active, `UNKNOWN`, or `CLOSE_PENDING` sessions. A normal close
attempt on shutdown requires the existing 600-second idle threshold and
the exact current owned session, with no force-kill or retry of uncertainty.

Six isolated fake-runner cases cover the state changes. This is **not**
evidence that any live installed child PID exited or that all active CDP
leases are empty. One read-only OS snapshot counted two Aside-named
processes parented by `codex.exe`, but task ownership and active lease
status remain unproven; neither was closed. No before/after RAM
measurement or saving is asserted. The original `HOST_HISTORY_UNPROVEN`
for the old open session and all UNKNOWN evidence stay unchanged.

Central owns the separate pinned Host re-installation and actual runtime
lease/child-return verification. Existing resource policy, Aside explicit
auxiliary route and no server migration remain unchanged. Details in
[Host Aside lifecycle README](components/host-control/README.md#g1-aside-lazy-lifecycle-and-safe-return--source-only-2026-11-09).


### G1 exact CDP browser identity discovery · source boundary (2026-11-09)

The registered Host already pins its private `cdp.identities` list, while
`aicc_host_open` requires `browser_identity`; the pre-existing
`aicc_host_capabilities` gave only `cdpIdentityRequired` and no safe way to
find the exact selector. The FBTT QA `EXACT_REGISTERED_CDP_IDENTITY_REQUIRED`
was `NOT_DISPATCHED` before a target was acquired, **not** evidence of an
authentication/security driver refusal.

The source-only fix emits `cdpIdentityDiscovery.identityIds` from the
existing owner-bound, valid Host registry and requires an explicit
`browser_identity` selection. It deliberately emits **no login, owner,
account, endpoint, profile, private path or identity hash metadata**;
mixed-owner or malformed binding gives an empty HOLD list. Selection is
not per-caller login authorization; live in-page identity and exact target
lease must still pass independently. Existing Aside auxiliary, unknown
journal and historic return HOLD are unchanged. **8 tools remain**, but
the public capabilities description/tool snapshot hash changes and
must be installed by central as a new fully pinned candidate. No live
Host open, deployment or FBTT QA replay was performed in this task.

Source procedure and failure classes: [Host CDP discovery README](components/host-control/README.md#g1-cdp-identity-discovery-2026-11-09-source-only);
reusable stage distinction: [지원/거절 증거 단계](guidance/skills/capture-operational-knowledge/references/문제와-해결책/완료-근거-단계.md).


Extend the existing host-control, workspace and registered browser-slot lifecycle rather than introducing a controller/service. Preserve distinct persistent ChatGPT profile/account/workspace identities, existing conversations, user input and target ownership. Compare registered Chrome profiles with shared-process profile and Playwright-context approaches; prefer existing separated profiles when durable identity/recovery wins. Never copy, merge or reset auth stores.

Measure physical RAM, commit, interval CPU/GPU, response latency and recovery before and after. Classify listeners, lazy executors, active/unknown work, recovery paths and unowned processes using code, process parentage, connections and leases. Retain OCX/Web/current Codex and authenticated receive paths. An idle executor requires zero active commands/leases/owners, no uncertain work, a reachable restart path and confirmed normal-close support. Evaluate 15-30 minute idle intervals from evidence. Aside remains installed with updates and an explicit auxiliary path; Chrome CDP/Playwright becomes default only after equivalent actual capability and identity tests. Main/read-only Workspace authorization stays separate. Oracle/Cloudflare relocation is design/cost-effect review only; no remote deployment, new fees or authentication transfer.

Acceptance includes source/test/install/runtime separation, multi-account concurrent isolation, reconnect and UNKNOWN preservation, safe close/refusal, and measured resource comparison. Source-only preparation never establishes live route conversion. Existing G1 controller/tasks own this follow-up; G1/G3 share a single root writer.

### G1 Windows decision and measured baseline · source-only acceptance slice

**Browser choice:** keep the existing **distinct registered Chrome
user-data roots** for concurrent, durable ChatGPT account identities. A
single Chrome application/process that still uses separate independently
registered user-data roots does not prove a single shared process or reduce
auth-state complexity; merging user-data roots would risk cookies and restart
ownership. Separate Playwright `BrowserContext` instances isolate ephemeral
tasks but do not automatically preserve the original long-term login/profile
identity, exact saved conversations and verified target leases. Use Playwright
`connectOverCDP` **inside each existing verified separate root** to select an
owned target, not a new merged context. Slot port alone proves no account.
User Chrome tab and physical focus remain unowned.

**Source delta:** `components/host-control/server.mjs` supports an opt-in
private `cdp.enabled`, exact per-open `browser_identity`, optional Aside
auxiliary and a thin `cdp-browser.mjs` adapter that reuses the existing
`CdpLeaseProvider`/managed slot helper. The original 600-second idle
normal-close, max 4 host sessions (3 browser/1 desktop), serial queue,
original request journal/UNKNOWN and preserved installed Aside/Cua remain.
A live route requires new pinned private config and a real owner-controlled
update, not source-only completion. Any actual browser/Aside close, listener
termination or user profile change is outside this slice.

**Windows resource reading (2026-11-08 03:16 KST):** OS physical total
15,912 MiB, available 395 MiB; commit limit 43,132 MiB, free commitment
11,902 MiB. Observed browser processes: Chrome 39 (aggregated WS 4,371
MiB/private 5,926 MiB), Aside 12 (373/823 MiB), cloudflared 2 (39/134),
Node 24 (243/1,545), Bun 2 (239/1,065). Physical memory is **not** the
sum of working sets because pages may be shared. A separate 2.02 s sample
on eight logical CPUs reported Chrome 12.4% of total CPU capacity,
Aside/Node/Bun/cloudflared 0% during that interval, and four positive
GPU-engine counters with summed 1.56%, **not** whole-GPU utilization.
Available physical RAM was then 329 MiB and free commitment 11,334 MiB.
Sampled telemetry is a point-in-time observation, not attributable to the
new code. No before/after live cutover or recovery-latency comparison has
been measured; operational savings = **UNMEASURED**. The earlier owner
baseline was collected at another time and is not a controlled comparison.

**Ownership classes:** Workspace Tunnel/supervisor and cloudflared
connections are authenticated receiving paths, not per-browser executors;
host-control Aside REPL/Cua clients and CDP target adapters are per-request
executors; Chrome processes/tabs can belong to the user or another
concurrent agent; native Codex/OCX/Web17841 and independent recovery
channels cannot be reclaimed from idle CPU/RAM. G1 current source only
contains an unref'd 30-second host idle **check** with a 600-second
owned-session age, not an Aside respawn loop. Windows Task/gateway
supervision and recovery must be measured separately before blaming a
scheduler. Any unmatched parent PID/lease/connection/UNKNOWN remains
`OWNER_UNPROVEN` and is preserved.

**Safe future idle-stop gate:** require proof of all exact owned sessions
and target leases returned, 0 active commands, other GPT jobs 0,
pending/UNKNOWN 0, reliable normal-close/ACK, preserved local receiving
endpoint and documented one-shot reconnection and rollback. Evaluate a
15–30 minute idle option *only after* measured workload/latency and
receiver survival; do not change the current 600-second session timer.
macOS `browser-resource-lifecycle.md` includes Swift/AppController
semantics and is **not** a Windows termination implementation.

**Server relocation comparison (design only):** cloud-only queues,
status receipts and notifications may reduce local poller/Node memory
*after* accounting for storage/egress, operating cost and webhook latency.
Periodic collection and permitted public APIs may move only if owners,
rights, source authentication and recovery are independently validated.
Cloudflare Workers/Queues/D1/R2 and existing Oracle could avoid some
local scheduled CPU but may add paid execution, storage, bandwidth and
operational reconciliation; prices and actual memory reductions are
unverified here. Windows file/GUI/Chrome profiles, authenticated
interactive input, Codex/OCX/Web model routes and local receiver must
stay local. No deployment, service/public URL, billing, login or token
migration is authorized by this source slice.

**Owner follow-up, 2026-11-08 (design only):** official Workers pricing is
100,000 requests/day with 10ms CPU/invocation on Free, or a $5/month base
on Paid before usage beyond included allowances. Queues Free includes
10,000 operations/day with 24-hour retention; one normal small-message
write/read/delete consumes three operations, so 1,000 jobs/day is about
3,000 queue operations before retries. Paid includes 1 million operations
per month, then $0.40/million. This is a capacity estimate, not a purchase
or evidence that this account has unused quota. Existing unrelated projects
share account limits. Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).
Oracle's current official Always Free documentation lists 1,500 A1 OCPU-hours
and 9,000 GB-hours/month (equivalent to 2 OCPUs/12GB), home-region and
capacity constraints, and possible reclamation of idle instances. Actual
existing tenancy entitlement, running workloads, region and headroom must be
read before any placement decision; do not assume the historical 4/24 quota.
Source: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

| Candidate | Local saving and migration decision |
| --- | --- |
| Queue/state/notification | Unmeasured attributable RAM; consider existing cloud facilities only after isolating a reclaimable local executor. Preserve exact request IDs, owners and UNKNOWN, authenticated receiver and rollback; avoid a new permanent Windows relay. |
| Permitted collection/API work | CPU/RAM saving depends on measured duty cycle, rights, server headroom and network round-trip. Benchmark the existing server before choosing placement; no deployment or auth transfer in this scope. |
| Workspace tunnels and local GUI/Codex | Keep local. Two observed cloudflared processes are separate authenticated receive/recovery routes, not proven duplicates. Their historical combined 39MiB working set is an upper process aggregate, not a guaranteed saving or proof of ownership. |

Network delay and actual reclaimable RAM remain unmeasured. Relocating a
small poller while retaining its entire local supervisor can save nothing;
do not deploy until expected benefit exceeds the extra operational and
recovery cost.

### G1 owner CDP binding · official prepare/install source gate (2026-11-08)

The previous CDP source could not actually become the host default through
the authorized updater: installed `host.json` and its gateway
`args[2]`/SHA were fixed. The official
`components/host-control/prepare-update.mjs` and existing
`tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1`
now accept an *explicit* owner-local, SHA-bound CDP candidate as the only
exception. They copy the entire existing Host config to a separately pinned
immutable release file, add just `cdp`, and change the Host config argument
and its unique config pin together, plus each copied CDP closure file pin
within the same Host provider. Existing Aside/Cua, blocked URLs,
apps, journal/stateRoot, native/workspace graph and published privileges
remain byte- or structure-identical.

The private binding must match installed registration for each distinct
Chrome profile, port, account and workspace, with official helper and runtime
file SHA pins plus an in-page identity hash. Missing and foreign identity,
unrelated fields, altered source/receipt/binding, duplicate config pins and
damaged rollback preimages are rejected. Backup requirements include original
Host config, exact private binding/coordination and source/manifest closure.
The original `host-runtime-local-backup/v1` + fresh operation-specific
gateway maintenance, independent READY, Task/registry CAS, one-shot
planned stop/start and rollback are not relaxed.

**Status:** source implementation and isolated fake validation only.
An owner-private CDP binding is not created, old host config is not edited,
no candidate is installed, and no live Chrome/Aside process is closed or
restarted. Real profile/session identity, concurrency, latency, saved
conversation recovery and actual physical RAM reduction are **NOT VERIFIED**.
The next actor is central after source SHA acceptance and original private
queue/UNKNOWN/stop-fence reconciliation, not this source writer.


### G1 Windows CDP dependency HardLink gate · source remediation (2026-11-08)

The first actual owner candidate produced a signed immutable Host 8-tool
bundle, but the official updater refused a raw npm/pnpm Playwright
`index.js` HardLink at the existing `Regular()` gate before touching
the live installation. This was a **dependency file-form mismatch**, not a
permission denial. No service, account or installed config is changed by
the follow-up source repair.

The official candidate now freezes **either** the single complete verified
`playwright-core` package **or** full `playwright` with the exact matching
`playwright-core`, together with the audit module's checked relative import
closure. The candidate and updater accept only those two explicitly pinned
package kinds, reject invalid name/version/exports/entry/optional/nested or
linked dependencies, and produce regular files under the **same existing Host
release**. It moves only the CDP
module paths in the *new* Host config and pins the complete copies in the
existing gateway Host provider and recovery backup; source HardLinks remain
unchanged. The updater keeps `Regular()` intact and independently verifies
source provenance and every copied manifest byte using the pinned Node
preparer. Symlink/junction, missing imports, source or release drift, scope
extension and rollback preimage loss fail closed. The old Aside/no-binding
path remains unchanged; CDP still cannot become the live default just from
source code.

Acceptance is *source + focused fixture* only. An actual rebuilt and
prepared candidate, independent READY, consumed empty gateway drain, one-shot
CAS apply/rollback, real account/profile identity, multi-account browser
operations and measured RAM savings still require central's authorized
private operation. The historical G1 pending/UNKNOWN and original owner
are neither resolved nor replayed by this repair.


### G1 core-only Playwright entry correction · source-only (2026-11-08)

A later owner Prepare detected an additional pre-live blocker:
`CDP_OFFICIAL_PACKAGE_IDENTITY_REQUIRED`. The registered package is
`playwright-core` 1.62.1 with a valid `index.js` CommonJS export;
full `playwright` is absent. The official source now accepts only two
kinds: single complete `playwright-core-only`, or complete
`playwright-plus-core` at exactly matching versions. The candidate
provenance and updater bind that kind to its unique materialized
entrypoint and validate name, version, exports, source/target hashes,
full file closure and unchanged Host graph. Other package names,
optional/nested dependencies, missing files and links remain refused.
Existing strict `Regular()`, rollback and owner READY/drain/CAS gates
remain unchanged.

The real private owner audit must separately supply the already
authorized dependency-free `sessionIdentityHashExpression`; no private
audit implementation, login or profile was changed here. A passing fake
candidate does not prove fresh private Prepare, live installation,
8-tool runtime use or physical RAM savings.


### G1 exact Host historical return · source gate (2026-11-09)

The owner reports a successful separate CDP default cutover (two registered
identities and eight available tools), followed by a blocked *new* Host
admission. A prior explicitly opened request still has
`OUTCOME_UNKNOWN`/`resultEvicted=true` and no observed resource-return
evidence. That is not a proved security refusal or proof of a live target.

The existing Host source now supports a narrow, owner-authenticated
normal-return reconciliation through optional parameters on
`aicc_host_close`. It will accept only a durable tagged **successful**
normal-close journal from the *same original instance, owner, lease, session
and exact CDP target/CUA process*. A separate SHA-bound, create-once receipt
leaves the original unknown result and journals immutable. No receipt is
minted from a returned status alone, empty capacity, age, PID absence,
manual assertion or failed close. Unverified old sessions and damaged
original/receipt evidence continue to block new admission.

This changes the existing Host close-tool schema/hash and the future private
journal's target/lease-hash metadata; installed Host and gateway pins are
**not updated** by source editing. Legacy Aside/old open records lacking
these independent proofs cannot be adopted or safely returned by the
current Host tools, so the specific historic HOLD remains unresolved until
the owner provides supported original-resource release proof and central
authorizes another candidate. The further browser idle/Aside helper and
physical memory acceptance are explicitly separate future work.

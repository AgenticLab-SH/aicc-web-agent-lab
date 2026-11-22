# Independent Codex CLI routes specification

## Authority and document roles

- Owner/lifecycle/last reviewed: product owner, active, command-route-r2 source amendment 2026-10-29 (not installed)
- Source intent: `specs/independent-codex-cli-routes/intent.md`
- This specification: verifiable Native/OCX CLI selection and isolation contract
- Related authoritative documents: `context/PROJECT.md` owns current decisions; `docs/agent-operations.md` owns operations; `README.md` owns user commands
- Supersedes: none

## Outcome

평상시 공식 CLI/Desktop은 같은 Codex HOME의 사용자 설정을 상속하고 일반 명령은 codex 하나로 단순화한다. 기본 route 목표는 OCX10100이며 Native 독립 정비와 Web 통합은 공식 V2 opt-in profile로 분리한다. 현재 설치·daemon 연결은 제품 current의 별도 상태다.

## User value

- User/problem: OCX를 단일 입구로 두면 한 장애가 모든 Codex CLI 작업을 막는다.
- Value promise: 평상시 OCX를 사용하고, OCX/AICC 자기 경로를 끊는 좁은 정비만 Native로 분리한다.
- Success signal: 두 명령과 TUI 항목이 분리되고 경로·실패 차단 fixture가 통과한다.

## Scope

### In
- `aicc codex native`, `aicc codex ocx`, `aicc codex status`
- route별 선택 모델을 위한 `--route-model MODEL`
- 공식 Codex 실행 파일에 전달하는 route별 최상위 CLI override
- OCX health, readiness, advertised-model preflight
- TUI의 분리된 Native/OCX Codex 항목

### Out
- 전역 Codex config 쓰기
- OCX 서비스·integration·계정·인증 변경
- Codex Desktop provider 전환

### Later
- 실제 OCX launch/canary는 소유자가 최종 검토 뒤 별도로 승인할 때 수행한다.

## Requirements

- **FR-001** — 일반 명령은 공식 codex이고 OCX10100을 기본 route 목표로 한다. ocx는 서비스 status/start/recover/dashboard/update 전용이며 코딩 명령이 아니다.
- **FR-002** — 같은 공식 0.165 V2 CLI/Desktop과 공유 HOME을 사용한다. native.config.toml/aicc-webgpt.config.toml은 base user config 위 opt-in layer이며 별도 깨끗한 HOME을 강제하지 않는다. legacy rescue는 보존한다.
- **FR-003** — compat는 route/provider/profile/auth/catalog 재정의를 거절하되 --model/-m/--route-model의 명시 모델과 --route-effort 및 좁은 사용자 설정 -c를 처리한다. 미지정 model/effort/catalog·승인·sandbox·personality·skills/plugins를 강제로 덮지 않는다.
- **FR-004** — OCX compat는 기존 health/ready와 authenticated catalog admission을 보존한다. 명시 모델/계정은 광고를 대조하고 미지정 모델은 Codex의 실제 config/session 계층이 결정한다. 사용자 layer 값은 advisory이며 effective daemon 증거가 아니다.
- **FR-005** — OCX 검사 실패 시 Codex를 실행하거나 Native로 fallback하지 않아야 한다.
- **FR-006** — 상태 명령은 서비스나 설정을 변경하지 않고 두 경로의 로컬 준비 조건을 별도로 보여야 한다.
- **FR-007** — OCX catalog는 실제 OCX 광고와 검증된 metadata를 기존 단일 owner 생성기로 결속한다. compat는 낡은 route/native-rescue/cache catalog로 fallback하거나 고정5.6을 요구하지 않는다. 명시6.1/high 지원은 보존하며 GPT-5.5 기존 차단을 유지한다.

## Scenarios

- **S-001 / Native:** Given 공식 실행 파일과 Native catalog가 있을 때, 사용자가 Native를 선택하면 공식 endpoint로 Codex가 열린다.
- **S-002 / OCX ready:** Given 10100이 healthy/ready이고 모델을 광고할 때, 사용자가 OCX를 선택하면 10100 endpoint로 Codex가 열린다.
- **S-003 / OCX down:** Given 10100이 응답하지 않을 때, OCX 명령은 실패하고 Codex나 Native를 실행하지 않는다.
- **S-004 / override:** route/provider/auth/catalog override는 실행 전에 거절한다. 명시 -m/--route-model과 사용자 reasoning/approval/sandbox는 별도 정상 입력이며 route 보호를 약화하지 않는다.

## Quality and boundaries

- Accessibility/responsive/performance/compatibility: 기존 키보드 TUI와 Windows PowerShell 흐름을 유지하고 preflight timeout은 기본 3초로 제한한다.
- Security/privacy/data: secret이나 계정 값을 출력·저장하지 않고 local catalog와 loopback 상태만 읽는다.
- Recovery/external actions: 명령 실행은 config를 쓰지 않으며 이번 검증에서는 실제 Codex·OCX process를 시작하지 않는다.

## Dependencies and risks

- Dependency/assumption: 공식 Codex 실행 파일과 선택 모델이 포함된 local catalog가 있어야 한다.
- Risk/recovery: local prerequisite가 없거나 OCX가 준비되지 않으면 구체적인 준비 명령과 함께 fail closed한다.

## UNKNOWN and HOLD

- HOLD: 실제 OCX launch/canary — resume when: owner approves live connection after final review — owner: product owner

## Acceptance evidence

| ID | Success criterion | Evidence |
| --- | --- | --- |
| **SC-001** | 두 endpoint와 config 불변 | `node --test test/codex-route-launchers.test.mjs` |
| **SC-002** | OCX 실패 시 spawn 0회 | `node --test test/codex-route-launchers.test.mjs` |
| **SC-003** | TUI 두 항목과 명령 분리 | `node --test test/catalog.test.mjs` |
| **SC-004** | 관련 소스 문법과 diff 정상 | `node --check src/codex-cli-routes.mjs`; `git diff --check` |

## Implementation outline

- Existing stack and boundaries to preserve: Node CLI/TUI, official Codex executable discovery, local catalog, no-fallback route policy
- Intended touchpoints: `src/codex-cli-routes.mjs`, `src/cli.mjs`, `src/catalog.mjs`, focused tests and user/operations docs
- Key decisions and rationale: Desktop 설정 대신 process별 CLI override를 사용해 failure domain을 분리한다.
- Rollout/recovery: offline code review first; live activation remains HOLD and code changes can be reverted without runtime migration.


## 일반 Chat 접근 확장 — 2026-10-20

- FR-008: --route-effort는 명시 추론 수준만 전달한다. compat의 -c는 approval_policy/approvals_reviewer/sandbox_mode/personality/model_reasoning_effort/model_verbosity만 허용하고 route·auth·catalog 주입은 차단한다.
- FR-009: 일반 Chat은 owner가 별도 결속한 Windows 전용 start/status를 통해 Native/OCX를 명시한다. 일반 exec 격리는 유지한다.
- FR-010: exact Git alias/lease/모델·effort allowlist/prompt SHA/실행파일 SHA/owner journal/자식 Job lifetime을 결속한다.
- FR-011: operation_id의 durable intent를 spawn 전에 저장하고 DISPATCHING/session/turn.started/turn.completed/result SHA를 구분한다. 불명·거절·fallback 재전송을 하지 않는다.
- FR-012: CLI가 쓰는 동안 일반 write와 lease close를 차단하고 종료 불명은 잠금을 유지한다. GPT용 tool manifest와 runtime/publication identity를 같은 capability로 계산한다.
- FR-013: 로컬 트레이 내부 CLI 탭에서 OCX/Native·Git root·선택적 모델·상속/medium/high를 고르고, 우클릭과 도구 버튼도 같은 탭으로 연결해 기존 managed CLI를 새 터미널로 시작한다. 비활성 이유·F1·접근성 설명을 제공하고 Desktop/전역 route를 변경하지 않는다.
- SC-008: 설치 후보 빌드, 새 릴리스의 실제 프로세스, 두 경로 인수·Unicode 폴더 전달 및 잘못된 입력의 dispatch 이전 거절, 두 테마의 선택 창 상태·렌더를 확인한다. 모델 추론과 터미널 열기 접수는 구분한다.
- SC-005: 권한이 없거나 personal-read-fetch면 새 도구 미노출. owner binding 밖 모델/경로/입력을 dispatch 전에 거절한다.
- SC-006: 요청된 fake-runner 범위에서 단일 dispatch·원 ID 조정·lease 만료·Job 종료·부분결과 미완료를 확인한다. 사용자 명시 검증으로 dispatcher fake-runner 4개 및 Workspace 관련 시험을 통과했다.
- SC-007: 실제 적용 후 같은 PRIVATE 플러그인의 도구 발견과 지정 route/effort의 최소 read-only 작업 결과를 별도 요청 범위로 확인한다. 호스트 설치와 기존 앱57개 enabled 계약, 실제 일반 Chat 두 경로 COMPLETED를 회수했다. 최종 binding 수정본의 실제 일반 Chat 두 경로도 COMPLETED/exit0/한글 결과 SHA 일치/lease0을 확인했다.
- 적용 범위: codex-chatgpt-web-private exact alias만 활성화. 다른 root는 별도 owner binding이 필요하다. 원 comm 요청 및 과거 search 미확정 결과는 재전송하지 않는다.

## 기존 G1 command-route-r2 실제 source slice · 2026-10-29

원 PK02 source10/21-action DRAFT_NOT_INSTALLABLE은 재사용한다. 원 CLI terminal exit0/작성권 반환과 queue 접수→143ms interrupted/items없음은 별개이며 queue 채택을 확정하지 않는다. 이번 추가 요구는 같은 task에서 새 source로 구현하고 별도 task/원장/Native 실행을 만들지 않는다.

- FR-014: `Read-AiccOcxAdmission.ps1`은 공식 provider `auth.command`의 stdout pipe에만 기존 등록 data token을 반환한다. 기존 registry의 windows-local/A1 credential writer/정확 home·token 파일·regular/no-link·크기 경계를 확인하고 로그인/발급/ACL 변경이나 fallback을 하지 않는다. baseURL만 고치거나 token을 config/로그/command args에 쓰지 않는다. helper를 사람 터미널·일반 도구로 실행해 stdout을 관찰하지 않는다.
- FR-015: `Prepare-CodexSharedHome.ps1`은 expected config/helper SHA와 검증된 catalog 3개로 base config 후보 및 공식 V2 native/aicc-webgpt profile 후보를 create-once한다. 사용자 model/reasoning/approval/reviewer/sandbox/personality/skills/plugins는 그대로 보존하고 route/catalog/command-backed auth만 준비한다. live HOME 쓰기·서비스 호출·실행·Apply 모드가 없다. 임의 기존 provider/default profile/원 secret 설정은 덮지 않고 owner 조정으로 반환한다.
- FR-016: 일반 base는 단일 OCX-only catalog, Native는 기존 독립 catalog, Web17841은 별도 Web-only catalog를 쓴다. raw /models에 reasoning metadata가 없으면 high를 발명하지 않고 검증된 모델 metadata 및 별도 session 관측을 구분한다. 기존 slug/대화는 기계적으로 이전하지 않는다.
- FR-017: `aicc codex ocx`는 endpoint/admission·명시 account 선택을 보존하는 compat다. 일반 no-account tray는 공식 codex.exe, Native 선택은 같은 실행기의 --profile native, 명시 계정은 기존 managed compat를 호출한다. 신규 입력의 기본 model/effort는 빈 값/사용자 설정 상속이다. explicit 6.1/high는 이미 지원되며 '항상5.6강제'는 기각한다.
- FR-018: private catalog 생성기는 다른 Git root의 원 owner가 수정한다. 지원된 변경 계약과 구체 후속 명령은 기존 [운영 runbook](../../docs/runbooks/workspace-codex-cli.md#command-route-r2-적용-준비와-정확-owner-의존)에 둔다. HOME·managed CLI·트레이·Desktop daemon·지피티 global/project instructions/skills/plugin 설명은 같은 G1 배포 의존이며 각 적용 상태를 나눈다.
- FR-019: 실제 profile/config/catalog/CLI 설치·Desktop restart·새 모델 call은 root의 fresh recovery/active+unknown/CAS/rollback/정상 완료 gate로만 잇는다. 기존 source/installed/private/remote 계약을 동일시하지 않는다. PK02 native revision/epoch/CAS 미지원은 이 독립 slice를 막지 않는다.

S-005: 기본 launch에 model/effort/catalog 인수가 없으면 사용자 설정을 상속한다. --route-model gpt-6.1-sol/--route-effort high와 표준 -m은 명시 선택으로만 전달한다. 같은 의미의 중복 인수는 거절하고 -- 뒤 지시문은 launcher 옵션으로 해석하지 않는다.
S-006: 계정 번호는 기존 owner alias로 결속하고 paused/삭제/변경을 실행 직전 거절한다. 계정 임시 catalog는 단일 configured OCX catalog metadata에서만 만들며 그 작업의 자식 종료 때 원 범위만 정리한다.
S-007: auth.command와 env_key는 같은 provider에서 결합하지 않는다. plain은 aicc-ocx의 command-backed auth, compat는 process-only aicc-ocx-compat의 기존 child-env handoff를 쓴다. credential helper 실패는 직접 인증이나 다른 계정으로 fallback하지 않는다.
S-008: root가 승인한 적용 뒤의 CLI/Desktop effective endpoint/실제 call/지피티 원문 반영은 별도 수용이다. 이번 source 작성에서는 이 시나리오 및 기존 SC 검사 모두 NOT_RUN이다. 과거 테스트 목록/성공은 이번 revision의 검증 증거가 아니다.

현재: SOURCE_AUTHORED_NOT_VERIFIED. 생성기 실행·후보 release 생성·HOME 문서 배포·runtime install·Desktop·실제 call은 NOT_RUN. 선택 파일 preimage는 기존 root backups/g1-ocx-foundation-command-route-r2/preimages로 보존한다.

## G1 계정 연속성·97% 보호 source 후속 · 2026-10-30

- FR-019의 activation gate를 유지한다. 이번 소스는 설치판이 아니며 검증 미실행이다. 현재 대화 issuer를 바꾸는 설치 옵션은 없다. 일반/계정우선은 새 대화의 계정 선택, 엄격고정은 정확 계정만 선택한다. 기존 issuer·암호화 reasoning·response/file ID는 원 계정에 남긴다.
- public pool, 최종 HTTP admission, inflight monitor는 모든 모드에서 min(owner threshold,97)를 적용한다. 더 엄격한 owner 제한은 보존하며 stop 정책을 switch로 바꾸지 않는다. 진행 중 cutoff는 partial/UNKNOWN과 원 effects를 보존하고 재전송하지 않는다. 5초 quota poll/1초 검사·15초 freshness 및 upstream 관측 지연 때문에 정확97.000% 무초과를 보장하지 않는다.
- 부모 thread header는 상관 정보이며 자식의 issuer 증명이 아니다. 자체 thread/session/socket 결속만 사용한다. 새 자식이 계정 한정 carriers를 갖고 있으나 issuer 증거가 없으면 owner_unknown 거절을 유지한다. 이를 다른 계정 호출로 우회하지 않는다. 정상 병렬 인수는 추후 실제 provenance 계약과 명시된 새 요청의 별도 수용을 필요로 한다.
- quota threshold는 pre-dispatch429와 continuation 안내, quota 미확인·model roster 미확인·확인된 모델 미지원은 구별되는503 진단이다. 기존 외부 error.message 원문은 원인 판정에 쓰지 않는다. 직접 OCX의 request-failures.jsonl에는 request/thread/parent/turn 식별과 safe failure/전송상태만 남기며 비밀·본문·ciphertext·response/file ID는 쓰지 않는다. 옛 로그에 없는 필드는 UNKNOWN이다.
- 기존 CLI source 옵션 --handoff-checkpoint는 fresh owner-local 평문 checkpoint를 1회 새 OCX 대화로 전달하는 소비자다. 엄격고정은 거절하고 초기화 대기한다. 원 CLI 정상종료/PID 부재·writer release·active0/unknown0·effects의 completed/not_dispatched와 원 operation SHA를 요구한다. 원 request 재실행, resume/fork, 추가 argv·route 변경·Native fallback을 허용하지 않는다. approval은 on-request+auto_review, sandbox는 기존 설정 상속이다.
- checkpoint 생성·정상종료 영수증 생산·현재 controller 작성권 반환·새 exact ID/issuer/응답/결과채택은 별도 producer/controller 연결이다. 소비자 존재나 CLI exit0은 전체 자동 전환 완료가 아니다. 미설치 source 옵션을 현재 설치판의 지원 옵션으로 안내하지 않는다. command-route-r2 overlay에 새 소비자 모듈을 포함했지만 builder/설치0이다.

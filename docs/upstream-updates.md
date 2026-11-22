# 외부 오픈소스 업데이트 절차

## 대시보드 적용 정책

| 대상 | 관측 기준 | 대시보드 적용 |
|---|---|---|
| OpenAI Codex CLI | 설치된 공식 standalone과 npm `latest` | exact idle, 관리 설치, daemon updater 비활성, 2단계 확인과 이전 release rollback이 모두 확인될 때만 `안전 업데이트` |
| OpenCodex(OCX) | 설치 버전과 npm `latest` | pinned submodule·10100 service·route 회귀를 agent가 함께 검토하므로 신호만 표시 |
| Codex Web GPT | private fork가 마지막으로 검토한 `upstream/main`과 원본 HEAD | private delta·보안·브라우저 회귀를 agent가 선택 흡수하므로 신호만 표시 |
| CodexPro·DevSpace | npm `latest` | 미설치 참고 원본. 버전만 screening하고 설치·업데이트하지 않음 |

업스트림 검사는 최대 8개 bounded worker로 읽기만 병렬화한다. 결과 순서는 manifest 순서를 유지하고,
owner-only snapshot 이외의 Git·npm·runtime 상태는 변경하지 않는다.

## 감지와 알림

- `com.agenticlab.aicc-scheduler`는 30초 bounded tick을 실행하지만 upstream 원격 조회는
  `guidance/monitoring.json`의 24시간 cadence가 도래했을 때만 수행한다.
- 스캔은 deterministic local worker가 담당한다. 매일 Web GPT 대화를 열어 확인하지 않는다.
- `update_available` source의 ID와 최신 version/revision 집합이 새 signature일 때만 owner outbox에
  `report_ready` 알림을 한 번 등록한다. 같은 signature는 event ID와 dedupe key로 재발송하지 않는다.
- 알림은 검토 신호일 뿐 적용 권한이 아니다. `automaticApply=false`와 component별 idle/rollback gate를
  그대로 유지한다.
- OCX installed baseline은 PATH의 별도 standalone CLI보다 관리 중인 `10100/healthz` runtime identity를
  우선한다. 대시보드도 runtime version과 standalone CLI version을 분리해서 표시한다.

### Windows 정기 에이전트 검토

Windows는 같은 `src/local-scheduler.mjs --upstream-review-only`를 로그온 및 30분 간격의
`AgenticLab-AICC-Durable-Scheduler`에서 실행한다. tick은 1분 이내에 끝나는 모델 없는 작업이며,
upstream scan, 다른 알림 발송, 계정 refresh나 설치를 직접 실행하지 않는다. 검토 주기는 기존
`guidance/monitoring.json`의 24시간을 사용한다. 등록한 기준 시각에 due를 고정하며 장기 중단 뒤에는
밀린 날짜들을 재생하지 않고 현재 due 하나로 합친다.

owner-local `monitoring/scheduler/agent-review-registration.json`은 exact 기존 담당 대화·root·rollout,
공식 CLI의 실제 release 경로와 current 슬롯, 실행 source SHA, 기존 추적 목표와 사용자 승인을 결속한다.
개인 값은 공개 소스에 넣지 않는다. 실행 코드나 공식 current 슬롯이 바뀌면 승인된 등록 갱신까지 HOLD한다.

기존 durable job store의 `upstreamReviews`에 due별 `registrationId:dueIndex` 키와 일회성 발신 의도를
먼저 저장한다. 기존 monitor의 due 요청을 재사용하고 UpdateCoordinator 상태를 연결한 뒤 공식
`codex queue --thread EXACT --message ... --resume`로 검토를 접수한다. 동일 due와 미결 이전 접수는
새로 발신하지 않는다. ACK 유실·timeout은 불명 상태로 보존한다. 중지된 continuity/S0나 별도
sender를 재활성화하지 않는다. 이 접수는 제품 root 작성권을 배정하지 않는다.

기존 담당은 공식 최신·변경·호환성·현재 작업·복구를 검토하고 기존 writer 배정에 따라 조치한다.
예약 등록, 실제 tick, 검토 할 일 생성, 큐 ACK, exact marker가 있는 실행 turn, 담당의 수신 확인,
검토 완료는 별개다. 담당은 같은 scheduler의 `--ack-upstream-review ID`를 exact 대화에서 호출해
수신 확인을 남길 수 있다. 완료는 같은 turn의 terminal event로 관측한다.

```powershell
& tools/platform/dashboard/Manage-AiccSchedulerTask.ps1 -Action Preview
& tools/platform/dashboard/Manage-AiccSchedulerTask.ps1 -Action Install -PlanPath $freshPlan
& tools/platform/dashboard/Manage-AiccSchedulerTask.ps1 -Action Status
& tools/platform/dashboard/Manage-AiccSchedulerTask.ps1 -Action RunOnce
& tools/platform/dashboard/Manage-AiccSchedulerTask.ps1 -Action Rollback -ReceiptPath $exactInstallReceipt
```

Preview는 현재 사용자·원 task XML·실행 파일 SHA를 읽는다. Install은 15분 이내 preview를 한 번만
소비하며 최소 권한·숨김 창·중복 실행 무시로 정확 task 하나를 등록한다. 실패 시 자기 task만 복구하고,
Rollback은 실제 현재 XML이 설치 영수증과 일치할 때만 이전 XML로 돌아간다. 실제 다음 task 실행은
Task Scheduler의 nextRun, 다음 검토 due는 review status로 각각 확인한다. QUEUE_ACCEPTED만으로
에이전트 실행이나 검토 완료를 주장하지 않는다.

## OCX

1. 현재 `vendor/opencodex.UPSTREAM.md`와 submodule 커밋을 확인한다.
2. 새 공식 태그를 임시 폴더에 얕게 가져온다.
3. 라이선스, 의존성, 명령, 관리 API, 설정 형식의 변경을 비교한다.
4. AICC의 OCX 연결 테스트와 OCX 자체 검증 명령을 실행한다.
5. 계정 정보가 없는 격리 환경에서 시작, 상태, 모델 조회, 중지와 기본 GPT
   복구를 확인한다.
6. 실제 사용자 환경 적용 전에는 현재 vendor 폴더와 실행 버전으로 돌아갈 수
   있는 복구점을 만든다.
7. 검증된 경우에만 submodule 포인터와 `opencodex.UPSTREAM.md`를 함께 갱신한다.

외부 원본을 갱신하는 작업은 설치된 실행본이나 `~/.opencodex` 설정을 자동으로
바꾸지 않는다. 실행본 전환은 별도 승인과 실제 smoke를 거친다.

AICC-managed OCX는 version별 격리 디렉터리와 exact LaunchAgent `--ocx` 경로가 설치 authority다.
OCX 대시보드의 일반 npm self-update가 관리 runtime이나 별도 PATH CLI를 대신 전환했다고 보지 않는다.
전환 전에는 `aicc restore ocx`를 owner-only rollback pointer에 연결하고, 동일 PID의 exact idle 5회,
health/ready/catalog/route fingerprint와 실제 response canary를 검증한다.

## 공통 승격 원칙

- 새 upstream 발견은 review 신호일 뿐 apply 권한이 아니다. `automaticApply=false`를 유지한다.
- private adapter는 가능하면 upstream에 rebase해 중복 patch를 제거하고, AICC 고유 contract delta만
  남긴다.
- source pin, generated schema, installed runtime과 live evidence를 서로 다른 필드·artifact로 기록한다.
- critical direct dependency는 exact pin 또는 frozen lockfile CI로 재현성을 보장한다.
- 전환 중인 major protocol은 production과 분리된 compatibility lane에서 검증한다.

## OpenAI tunnel-client와 MCP SDK

1. 현재 private runtime binary의 버전과 SHA-256을 기록한다.
2. 공식 release와 SDK 변경 내역에서 profile, runtime key, STDIO transport와 도구
   schema 호환성을 확인한다.
3. 격리된 임시 profile에서 Workspace MCP tool list, healthz와 readyz를 검증한다.
4. launchd 원본은 유지한 채 새 binary로 bounded restart를 수행한다.
5. 실제 ChatGPT connector 호출을 확인한 뒤에만 이전 binary를 제거한다.

MCP TypeScript SDK v2처럼 package 구조가 바뀌는 전환은 v1 production line을 유지한 채 별도 canary로
검토한다. Workspace와 Web GPT Tunnel profile은 identity와 failure domain이 다르므로 upgrade를 이유로
합치지 않는다.


## Windows 오픈소스 통합 점검 (2026-10-11 추가)

오픈소스/의존성/크롤러를 조회하는 사용자의 직접 요청은 [\`manage-upstream-assets\`](../guidance/skills/manage-upstream-assets/SKILL.md)에서 시작한다. 기존 정본을 복제하지 않고 다음 항목을 연결한다.

| 대상 | 소유 원본 | 의미 |
| --- | --- | --- |
| 프로젝트·Git 원격 | owner-local \`cross-device/project-portfolio.toml\` | worktree 중복 없이 현재 등록된 원본 프로젝트만 |
| AICC가 참조한 외부 소스 | \`guidance/skills/aicc-guidance-review/references/absorption-ledger.json\` | 참조/채택/보류/라이선스, 설치 사실과 구분 |
| 공식 문서 크롤러 목록 | \`src/knowledge-review/policy.mjs\` | 허용된 seed URL과 manualOnly 정책 |
| npm/Python 직접 의존성 | 각 등록 원본 저장소의 manifest | 선언된 범위일 뿐 설치된 바이너리 버전 아님 |
| 원격 최신 감시 | \`src/upstream-monitor.mjs\` | 업데이트 신호, 자동 적용 0 |
| Windows 런타임 | 실제 10100·10101·10102·17841/CLI 조회 | 로컬 OCX, A1 허브, Web GPT, standalone CLI 구분 |

읽기 전용 조회: \`python guidance/skills/manage-upstream-assets/scripts/inventory.py --live\`. \`--write\`는 owner-local \`inventory/upstream-assets.json\` 파생 스냅샷만 갱신한다. 미등록 소프트웨어와 외부 크롤러는 전체 조회 완료라고 보고하지 않는다. 이 출력은 다운로드·설치·업데이트·실서비스 전환을 수행하지 않는다.

Windows에서는 OCX 버전 셋을 반드시 구분한다: \`ocx --version\`의 독립 CLI, \`10100/readyz\`의 실제 실행 서버, \`10102\` A1 계정 관리 허브. 포트가 정상이라고 릴리스가 최신인 것은 아니다. 기존 \`Prepare-AiccOcxUpstream.ps1 -Action Check\`는 공식 latest를 읽는 동작이며, \`Prepare\`는 검증된 upstream 압축 파일만 별도 저장하고 실행 중인 서비스나 인증을 교체하지 않는다. 실제 배포는 compatibility/idle/rollback과 owner 게이트가 확인된 개별 작업으로 한다.

Windows 작업 스케줄러·PowerShell, WinForms 트레이+Node 수집기와 Bun 기반 OCX의 런타임을 강제로 통합하지 않는다. OCX의 Bun은 공급자별 고정 해시, 독립 설치 경로, startup/repair 검증이 있어야 한다.

## 2026-10-11 후속 적용·검증 경계

- AICC 전역 지침 검사는 축약된 canonical 공통 지침의 실제 행동 계약에 맞춰 검사 구문을 고쳤다. 대상 지침 원문, 생성본, 사용자 Codex 홈은 변경하지 않았고 지침 비교 검사 19/19, 전체 그룹 5/5가 통과했다.
- `windows-design`의 누락 참고 자료 5개를 새로 작성하고, `manage-codex-model-routes`를 AICC 정본에서 정확히 한 스킬만 재배포했다. `manage-chatgpt-assets`는 자주 쓰는 entry와 상세 예외·삭제·검증 reference로 분리해 implicit 4KiB 한도를 충족했다. 전체 Codex managed manifest는 prune 없이 재동기화했다.
- ChatGPT 개인 Skills (`https://chatgpt.com/skills`)와 공유 관리자 Skills (`/admin/skills`)는 별개의 소유 범위다. 현재 등록된 개인 계정에서 `manage-upstream-assets`의 원격 누락을 읽기 전용으로 확인했고, 개인 페이지의 `스킬 추가 → 컴퓨터에서 업로드` UI, 정확한 파일 입력 1개(`.zip,.skill,.md`)를 확인했다. **실제 업로드 요청은 OpenAI 도구 안전 검사에서 차단**됐으므로 원격 설치 완료라고 기록하거나 다른 경로로 우회·재전송하지 않는다. 로컬 검증·전송 결과·원격 이름 표시를 분리한다.
- OCX upstream 2.83.0은 공식 npm 무결성 통과 아카이브만 보관. 설치된 Windows OCX 서버 2.81.0과 별도 PATH CLI 2.77.0은 유지한다. 현재 전환기와 adapter 수용 계약의 supplier 2.81.0 고정을 우회하지 않는다. 추가 후보 정적 비교 요청도 도구 안전 검사에서 차단돼 실행하지 않았다.
- Windows의 마지막 부팅과 등록된 자동시작 작업은 읽기 전용으로 점검했으나, 현재 사용자 작업을 중단하는 새 재부팅은 수행하지 않았다. **재부팅 후 변경된 구성 실측**과 실제 2.83.0 적용/Responses canary는 미완료다. 다른 agent의 staged·dirty 변경은 건드리지 않는다.

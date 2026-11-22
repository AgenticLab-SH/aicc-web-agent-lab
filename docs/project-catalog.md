# Project Catalog와 Notion priority sync

Project Catalog는 로컬 실행 정본과 Notion 관리 정본을 한 화면에 투영하되 어느 한쪽으로 조용히
덮어쓰지 않는다. 로컬 Git과 service runtime은 실행 사실을, Notion Project와 Idea/Task는 lifecycle,
priority와 next action을 소유한다. 값이 다르면 `DRIFT`로 남긴다.

## 입력과 owner state

- workspace 구조 README와 발견된 독립 Git root
- optional project manifest와 명시적 overlay
- website workspace/profile과 allowlisted project service
- connector가 읽어 저장한 Notion snapshot
- durable priority outbox

Notion snapshot과 outbox는 owner-only 상태이며 공개 package에 포함하지 않는다. snapshot에는 version,
capture time, project 배열과 idea 배열이 필요하다. priority는 안정된 `projectId` 또는 `uniqueId`와
0 이상의 정수 rank로 표현한다.

## 로컬 API

읽기:

- `GET /api/projects`: catalog projection, source summary와 outbox status
- `GET /api/projects/priority/outbox`: 외부 쓰기 없이 exact operation 목록

상태 전이:

- `POST /api/projects/notion-snapshot`: connector가 읽은 current snapshot을 로컬에 반영
- `POST /api/projects/priority/preview`: 예상 remote version과 desired rank를 검토
- `POST /api/projects/priority/confirm`: one-use confirmation으로 `PENDING_SYNC` 예약
- `POST /api/projects/priority/sync/prepare`: current remote version이 같을 때만 `SYNCING`
- `POST /api/projects/priority/sync/complete`: 원격 결과 snapshot에서 exact rank를 검증한 뒤 `APPLIED`
- `POST /api/projects/priority/sync/failure`: retryable connector 실패를 `PENDING_SYNC`로 복귀

모든 POST는 loopback, same-origin JSON만 받는다. 이 API들은 Notion에 직접 쓰지 않고 owner-local
outbox와 snapshot만 변경하므로 응답의 `externalWritePerformed`는 false다.

## connector 작업 순서

1. Notion connector identity, workspace, data source ID와 exact schema를 read-only로 확인한다.
2. current rows를 읽어 local snapshot과 page ID를 대조하고 rollback snapshot을 보존한다.
3. outbox operation을 preview/confirm한 뒤 `sync/prepare`로 exact remote version을 예약한다.
4. connector가 한 page의 명시한 property만 쓴다. 다른 property나 page content는 건드리지 않는다.
5. 같은 data source를 다시 읽어 exact rank와 새 version을 포함한 snapshot을 만든다.
6. `sync/complete`가 원격 결과와 local snapshot을 함께 확정한다.
7. transport 실패면 `sync/failure`; 결과 불일치면 `DRIFT`로 남기고 blind retry하지 않는다.

process crash가 journal append 뒤 발생하면 restart에서 reserved effect를 원격 current snapshot과
reconcile한다. 이미 적용된 결과, 아직 적용되지 않은 결과와 불명확한 drift를 구분한다. `APPLIED`
operation을 되돌리려면 새 guarded remote operation이 필요하다.

구현 계약은 [`../contracts/projects/`](../contracts/projects/)와
[`../src/projects/`](../src/projects/)에 있다.

공식 Notion API worker와 Project·skill·plugin·ChatGPT 통합 inventory는
[`asset-control-plane.md`](asset-control-plane.md)를 따른다. connector는 이 문서의 기존 priority outbox를
교체하지 않고 external worker로 연결한다.


## Registered portfolio와 development Notion drift

`tools/platform/inspect/plan-development-notion-drift.mjs`는 외부 쓰기 없이 현재 로컬 프로젝트와 Notion 개발 DB의 차이를 계획한다.

- `AICC_PROJECTS_ROOT` 또는 `--projects-root`의 Project Catalog를 읽는다.
- owner-local `git-portfolio/latest.json`의 등록 source/worktree를 합친다.
- Notion의 현재 `프로젝트 ID`와 `로컬 기준 경로`를 기준으로 canonical 프로젝트만 매핑한다.
- worktree는 Notion 프로젝트로 만들지 않고 WIP 수치로만 집계한다.
- 기존 baseline과의 drift, 새 baseline candidate, candidate 재검증을 owner-local JSON으로 남긴다.
- Notion write, archive, delete, worktree prune은 수행하지 않는다.

대규모 의도적 재구조화 뒤 기존 baseline이 `record-presence` 충돌을 내면 candidate가 `IN_SYNC`인지 먼저 확인한다. candidate 활성화는 기존 baseline digest와 candidate digest를 모두 고정하고 `migrate ... --dry-run`으로 미리보기한 뒤, `--confirm migrate-development-sync-baseline`을 사용한 별도 명시적 migration으로만 수행한다. migration은 owner-local baseline만 바꾸며 기존 baseline을 digest 이름으로 backup하고 post-read를 검증한다. Notion snapshot을 먼저 fresh-read하고 candidate를 다시 생성하지 않았다면 migration하지 않는다.

## Portfolio WIP aging 경고

`tools/platform/inspect/plan-development-wip-warnings.mjs`는 기존 registered portfolio와 owner-local Notion snapshot을 재사용해 WIP 위험만 계산한다.

- dirty 지속 7일 이상은 첫 관찰 시각을 owner-local state에 기록한 뒤 실제 경과가 증명될 때만 경고한다.
- 미완료 구현 작업 3개 초과, worktree 5개 초과 또는 dirty worktree 2개 초과를 경고한다.
- `전략 분류=집중` 프로젝트는 집중 부모-자식 관계를 한 프로그램 축으로 접어 3축 초과일 때만 경고한다.
- registered source의 Git head가 Notion 마지막 확인일보다 최신이면 경고하며, `보관 검토`면 별도 경고를 추가한다.
- worktree는 프로젝트 수로 세지 않는다.
- owner-local `notion-current.json`에는 프로젝트 ID, page URL, 전략 분류, 상위 프로젝트, 마지막 확인일이 필요하다.
- owner-local `notion-tasks-current.json`에는 작업 ID, 상태, 코드 단계, 프로젝트 relation이 필요하다.
- 출력과 dirty first-seen state 외에는 아무것도 쓰지 않으며 `externalWritePerformed=false`를 유지한다. 프로젝트 상태·전략 분류·archive/delete/reset/clean은 자동 변경하지 않는다.

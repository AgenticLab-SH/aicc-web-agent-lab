# Notion registry 계약

Notion은 lifecycle, priority, owner, remote binding과 사람이 보는 운영 상태를 mirror한다. Instructions·source 원문,
코드, raw 대화, session과 secret의 정본이 아니다. 반드시 Notion connector를 사용하고 브라우저로 우회하지 않는다.

## 필드 권위

- 로컬: logical asset ID, canonical path, Instructions/source hash, backup/evidence 경로
- ChatGPT post-read: remote stable ID/URL, 실제 이름·권한·source count, registered 여부
- Notion: lifecycle, priority, next action, owner가 보는 상태와 위 두 권위자의 verified mirror

## 상태 전이

| 상황 | Registered | Lifecycle | Sync Status | Remote binding |
| --- | --- | --- | --- | --- |
| 로컬 설계만 존재 | false | Candidate | Candidate Ahead | 없음 |
| remote 생성됐지만 검증 미완료 | true | Candidate 또는 Hold | Remote Observed/Blocked | stable ID/URL |
| Instructions·Sources·retrieval 검증 | true | Applied | In Sync | stable ID/URL |
| remote/local drift | 실제 상태 | Hold | Drift | 보존 |
| verified remote 삭제 | false | Archived 또는 Retired | In Sync | ID/URL 제거 |

목적지는 [공통 원칙](../../aicc-workspace-operator/references/notion-file-transfer.md#notion-목적지-원칙--공통-정본)을 따른다. 기존 registry data-source/부모의 exact ID·schema 확인 전 쓰기는 HOLD하며 최상위를 자동 생성하지 않는다.

## 쓰기 절차

1. connector identity와 registry data-source schema를 fetch한다.
2. Asset ID 또는 page ID로 exact record 하나를 고른다. 이름 검색만으로 update하지 않는다.
3. mutation 전 remote/local evidence를 확인한다.
4. 필요한 property만 update하고 local canonical path와 history를 보존한다.
5. 같은 record를 fetch/query해 exact property를 post-read한다.
6. partial failure는 ChatGPT와 Notion 결과를 분리해 journal에 남기고 `HOLD_NOTION_*`로 종료한다.

삭제된 remote asset의 Notion page를 지우지 않는다. `Registered=false`, remote binding 없음과 backup·재설계 상태를 남겨 과거와 현재를 구분한다.

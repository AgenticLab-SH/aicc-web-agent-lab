# 실행·복구 계약

## 공통 preflight

1. public guidance와 private adapter의 정확한 Git root/dirty state를 확인한다.
2. owner-only desired manifest와 signed-in account/workspace identity binding을 읽는다.
3. broker가 만든 exact task-owned target만 사용하고 origin이 `https://chatgpt.com`인지 확인한다.
4. stable ID/name/type inventory를 정규화·정렬하고 동일 inventory를 다시 읽어 fingerprint가 같은지 확인한다.
5. dry-run evidence를 원자적으로 owner-only 권한으로 저장한다.

모든 단계는 port, account ordinal, profile label, sidebar order와 locale에 독립적이어야 한다.

## Create

- exact user scope와 desired specification이 있어야 한다.
- 빈 create surface, source file absolute path/regular-file/size/SHA-256, Instructions 제한을 검증한다.
- create confirmation은 `CREATE:<kind>:<exact name>`처럼 action/name에 묶는다.
- 생성 후 remote stable ID, name, Instructions, Source 목록/해시와 setting을 post-read한다.
- 같은 이름이 이미 존재하거나 생성 응답이 불명확하면 재시도하지 않는다.

## Update

- expected remote ID와 before snapshot hash가 일치해야 한다.
- name, Instructions, settings, missing Source upload만 계획한다.
- extra Source와 hash가 다른 same-name Source는 자동 삭제·대체하지 않는다.
- 각 bounded update 후 exact editor post-read가 desired와 같아야 `verified`다.

## Share

- owner identity, exact Project remote ID, 대상 identity의 owner-only hash, 현재 membership을 다시 읽는다.
- 중복 초대가 0일 때 최소 권한 초대를 정확히 1회 수행한다.
- 대상 identity와 role을 post-read한다. 원문 이메일은 출력·원장에 남기지 않는다.

## Delete

삭제는 normal sync와 분리된 고위험 transaction이다. 사용자에게 이미 받은 exact 범위와 보존 조건의 승인은 재사용한다. 내부 review-bound confirmation은 도구 호출의 결합 조건이며, 기존 승인을 다시 받으라는 뜻이 아니다.

필수 approval manifest:

```json
{
  "schemaVersion": 1,
  "expectedIdentity": {
    "identityHash": "sha256",
    "workspaceIdentityHash": "sha256-or-null"
  },
  "expectedInventoryHash": "sha256",
  "reviewId": "sha256",
  "targets": [
    {
      "kind": "project-or-custom_gpt",
      "remoteId": "stable-id",
      "name": "exact-current-name",
      "sourceCount": 0,
      "conversationCount": 0,
      "conversationLossApproved": true,
      "sourceLossApproved": true
    }
  ]
}
```

실행 규칙:

1. report-only review를 새로 만들고 identity/workspace, inventory hash와 deterministic review ID를 비교한다.
2. 각 target이 현재 owner/deleter이고 ID/name/type/sourceCount/conversationCount가 승인과 정확히 같은지 확인한다.
3. 대화 또는 Source가 있으면 owner-only backup/export/distillation 상태와 사용자의 명시적 손실 승인을 확인한다.
4. dry-run 뒤 commit에는 `DELETE:<reviewId>` 같은 exact review-bound confirmation을 요구한다.
5. target을 deterministic stable-ID order로 1건씩 삭제한다.
6. 각 dispatch 직후 target 부재와 모든 비승인 asset의 stable ID/name 보존을 post-read한다.
7. dispatch failure는 다음 target을 막는다. dispatch 이후 post-read failure는 `submission_uncertain`이며 자동 재시도하지 않는다.
8. 완료 inventory가 desired set과 맞는지 다시 읽고 owner-only mutation journal을 저장한다.

복구는 local canonical package와 owner-only backup에서 새 stable ID로 recreate하는 방식이다. 삭제된 asset의
원래 stable ID, 공유 링크, UI 대화 배치의 exact restore는 지원된다고 가정하지 않는다.

## Notion mirror

외부 mutation이 verified된 뒤에만 해당 record의 `Registered`, lifecycle, source count, remote ID, evidence를
connector로 갱신한다. update 후 같은 page를 fetch해 exact property를 확인한다. connector가 없거나 post-read가
다르면 ChatGPT 결과와 Notion 결과를 분리해 `HOLD`한다.

Candidate 설계와 remote binding의 필드 권위·상태 전이는
[`notion-registry-contract.md`](notion-registry-contract.md)를 따른다. remote 삭제 후에는 `Registered=false`,
remote ID/URL 없음과 lifecycle을 post-read하되 local canonical path, historical source count와 backup 설명을
지우지 않는다.

## 코덱스·지피티의 공통 실행과 기본 메모리

일반 Chat 지피티는 기존 AICC Workspace의 등록 작업공간과 실제 지원되는 관리 실행 capability로 같은 private manager를 호출한다. 일반 exec·파일 읽기만으로 Node와 브라우저 관리가 가능하다고 추정하지 않는다. 기능이 없으면 필요한 작업 범위를 보고하고 정상 등록·배포로 마련한다. 웹 Python/터미널에서 Windows 경로를 실행하지 않는다. 코덱스도 같은 source·설정·내용 주소 백업 원장을 사용한다. 생성·수정·삭제 전에 [공통 자산 수명주기](../../manage-chatgpt-skills/references/asset-lifecycle.md)의 GitHub·Notion 실제 원본 백업을 완료하고 같은 버전은 재사용한다.

새 Web Project는 이름을 `w-프로젝트 명`으로 만들고 **기본 메모리(default)**를 선택한다. `w-w-`·`w-l-`처럼 접두사를 중첩하지 않는다. Instructions와 BASE/ACTIVE source는 design-chatgpt-projects의 목적·포함/제외·정본·출력·자료 lifecycle 계약으로 작성한다. 기존 ID/대화/Source는 보존하며 기존 memory를 변경할 수 없으면 재생성으로 우회하지 않는다. 이 관리 능력의 구현 요청만으로 관련 없는 기존 프로젝트를 일괄 개명·삭제하지 않는다.
구체적인 실행 입력과 create→configure 연결은 [references/project-executor.md](project-executor.md)를 따른다. 실제 실행기는 Node.js를 사용한다.


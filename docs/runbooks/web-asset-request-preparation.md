# 지피티의 프로젝트·스킬 요청 준비

기존 `aicc_web_management_start/status`가 원격 실행기다. 일반 Chat의 격리된
`aicc_workspace_exec`에서 브라우저 관리기를 직접 실행하지 않는다. PowerShell 준비기는
등록 workspace의 파일만 읽어 요청 JSON과 SHA를 만든다. Node·CDP·계정 전환은 필요 없다.

## 기존 관리 workspace에서 시작

소유자가 배치한 `web-asset-requests/README.md`와 `catalog.json`을 읽는다. 이 경로는
현재 owner binding이 지정한 workspace 안에 있어야 한다. 전체 PC alias와 같은 것으로
추정하지 않는다. 도구가 없는 세션은 실제 capability 미노출을 보고한다.

```powershell
powershell.exe -NoProfile -File web-asset-requests/Prepare-WebManagementRequest.ps1 `
  -WorkspaceRoot 'EXACT_REGISTERED_WORKSPACE_ROOT' -Action Inventory
```

목록은 로컬 후보 관측이다. 같은 slug의 서로 다른 ZIP은 별도 버전 후보이며 원격에 모두
등록할 대상이 아니다. `remoteId:null`은 원격 부재가 아니다. 원래 목록의 sandbox 링크를
Windows 경로로 실행하지 말고 catalog의 workspace 상대 경로를 쓴다.

## 파일에서 실행 입력까지

1. 기존 관리기 `personal-skill-list/inspect` 또는 `project-inspect`로 실제 신원·ID·현재
   SHA를 회수한다. 일반 read 요청은 백업이 필요 없고 `personal-skill-plan-file`은
   후속 수정의 원본·후보 바이트를 결속하므로 양쪽 VERIFIED 백업이 필요하다. 개인 스킬 목록 요청은
   `{"schemaVersion":1,"action":"personal-skill-list","skill":{}}`다.
2. 파일 수정은 기존 `aicc_workspace_apply_patch`로 한다. 새 스킬은 ZIP 한 개, 기존
   스킬 본문은 `bodyFile`, 설명은 `descriptionFile`을 사용한다. 기존 supporting file의
   Markdown 수정만 `filePath`에 결속한다. 프로젝트 지침·소스도 기존 action을 사용한다.
3. 변경 전·후 원본을 기존 공통 asset lifecycle로 백업한다. 신규 작업의 backup manifest
   `stateRoot`는 처음부터 이 workspace의 비공개 운영 하위 경로로 지정한다. 기존 원장이나
   영수증을 옮기지 않는다. `backupReceipt`, bundle, inline proof는 모두 같은 등록 workspace
   안의 원래 경로여야 한다. 이전 경계 밖 receipt가 있으면 그대로 보존하고 별도 복제·다른
   stateRoot의 새 백업으로 불명 또는 거절을 해소하지 않는다.
4. [기존 입력 계약](workspace-web-management.md)에 맞는 JSON을 workspace에 쓴다.
   계정·실행 파일·호스트 설정·신원 해시는 입력하지 않는다. body/file/description 및
   sources의 SHA는 준비기가 계산하며 기존 값이 있으면 일치해야 한다.
5. 아래 준비기를 실행한다. 이 단계는 외부 통신·백업 업로드·원격 변경을 하지 않는다.

```powershell
powershell.exe -NoProfile -File web-asset-requests/Prepare-WebManagementRequest.ps1 `
  -WorkspaceRoot 'EXACT_REGISTERED_WORKSPACE_ROOT' -Action Prepare `
  -InputPath 'web-asset-requests/input/update.json'
```

`REQUEST_PREPARED_NOT_DISPATCHED`의 `request_path`, `request_sha256`, `request_id`를
열린 write lease와 함께 `aicc_web_management_start`에 **한 번** 전달한다. 다음에는
동일 `operation_id`로 status를 조회한다. 같은 mutation bytes는 같은 operation ID를
사용하므로 새 이름으로 재시작하지 않는다. 이미 write request ID가 사용됐으면 status로
기존 결과를 회수한다. 보통 read는 새 관측마다 새 ID를 받지만, 실제 다운로드를 동반하는
`project-source-read`는 `read-`와 요청 SHA 앞 40자를 결속한다. 원 결과가 불명일 때
다른 ID로 같은 Source를 다시 받지 않는다.

기존 Project의 원문 Source를 읽을 때는 `project-source-read`에 exact `remoteId`,
`expectedName`, 전체 Project `preimageSHA256`, `source:{filename,includeBody:true,maxBytes}`를
넣는다. 단일 UTF-8 Markdown이고 `maxBytes`는 1~262144다. 알고 있는 원바이트 SHA가 있으면
`expectedSha256`도 결속한다. `commit`은 생략하거나 false다. 이 action은 provider 소스에
있어도 owner allowlist와 설치된 고정 manager가 제공하지 않으면 사용할 수 없다.

기존 개인 스킬의 `references/*.md`를 고칠 때는 `personal-skill-plan-file`로 exact skill ID,
name/displayName, `filePath`, 현재 full logical `expectedCurrentSha`, 후보 `bodyFile`과 양쪽
VERIFIED `backupReceipt`를 먼저 묶는다. 원 plan ID의 status가 반환한 `plan_sha256`을
같은 대상의 `personal-skill-update-body`에 `skill.planRequestId/planSHA256`으로 전달한다.
계획은 저장이나 설치가 아니며, 원 적용 영수증이 있으면 새 apply를 만들지 않는다.

## 실제 지원 범위

| 대상 | 생성 | 수정 | 삭제 |
| --- | --- | --- | --- |
| 개인 스킬 | `personal-skill-upload` | `personal-skill-update-body`, `personal-skill-update` | `personal-skill-delete` |
| 프로젝트 | `project-create` 후 exact ID 구성 | `project-update`, `project-upload` | `project-source-delete`, 빈 프로젝트의 `project-delete` |
| 사용자 지침 | `instructions-update`로 필드 채우기 | 같은 action | 해당 필드 비우기 |

새 Project는 `w-` 이름·`memory:"default"`·`sources:[]`로 shell을 만들고 반환 ID로 지침과
소스를 구성한다. `CREATED_CONFIGURATION_PENDING`은 전체 구성 완료가 아니다.
대화·Source가 있는 프로젝트 전체 삭제는 이 준비기의 지원 범위 밖이다. Business 공용
스킬·플러그인 수정은 기존 전용 manager/connector의 권한과 계약을 따른다.

mutating 요청은 명시적 `commit:true`와 exact account/asset ID/action/before/desired SHA에
결속된 실제 양쪽 백업을 요구한다. 삭제는 전체 복구본과 `confirm:"DELETE:EXACT_ID"`가
필요하다. receipt의 기존 `.operation.json`/`.operation.lock`은 재생 금지 상태다.

준비기는 기록된 거절·불명 후보와 기존 ID가 있는 신규 upload를 구분한다. catalog는 운영
안내이며 호스트의 권한 경계가 아니다. 실제 신원·권한·백업 증명·쓰기 직렬화는 기존
고정 관리기가 다시 집행한다. prepared가 원격 수락이나 사용자 설치의 증거는 아니다.

## 배치와 상태 구분

준비기 정본은 `tools/platform/chatgpt/Prepare-WebManagementRequest.ps1`이다. 소유자가
기존 binding의 exact workspace에 준비기와 후보 bytes를 배치한다. 원본 package 저장소의
`UPLOAD_PENDING.json`을 목록 정본으로 유지하고 workspace catalog에는 source/provenance를
기록한다. 대상·후보가 달라지면 소유자가 같은 목록의 새 snapshot을 갱신한다.

도구 metadata 변경·상주 worker·서비스 재시작·앱 재게시가 필요 없는 파일 준비 단계다.
`LOCAL_STAGED`, `REQUEST_PREPARED`, `DISPATCHING`, 원격 수락, 사용자 설치, GPT 실제 호출을
구분한다. 현재 모델 정책으로 새 코드 실행·검증을 하지 않았다면 검증 미실행으로 보고한다.

## 기존 개인 스킬에 참조 파일 한 개 추가

소스 요청 준비기는 `personal-skill-plan-add-file`(읽기 계획)과
`personal-skill-add-file`(쓰기)을 구분한다. 대상은 본인 소유의 exact skill ID와
`references/<lowercase-slug>.md` 하나다. 폴더 생성·중첩 경로·기존 파일 덮어쓰기는
지원하지 않는다. name/displayName, `bodyFile`과 그 원바이트 SHA, 원래 `backupReceipt`를
같은 workspace에 결속한다. 계획에는 commit/confirm을 넣지 않는다.

기존 manager의 `add-file` 계획이 관측한 SKILL.md·파일 목록의 SHA를 각각
`skill.expectedCurrentSha`와 `skill.expectedTreeSha`로 전달한다. 쓰기는 `commit:true`,
`confirm:"ADD-FILE:EXACT_SKILL_ID:references/EXACT_SLUG.md"`가 필요하다. backup의
operation은 `create`, preimage는 빈 바이트 SHA, desired는 UTF-8 BOM 제거·CRLF→LF한
본문 SHA이며 `desired/references/EXACT_SLUG.md`에 같은 bytes가 있어야 한다.
단순 준비는 외부 통신·manager 실행·원격 변경을 하지 않는다.

provider는 원바이트 SHA를 보존하고, 기존 manager는 identity→현재 트리/본문→backup→
로컬 draft→identity 재확인→일회 mutation→Save 1회→fresh readback 순서를 집행한다.
UNKNOWN이면 같은 operation/receipt로 읽기 조정만 한다. 새 요청·새 receipt·Save 재클릭으로
진행하지 않는다.

고정 host는 기존 companion의 `prepareNamedAddFileRequest(request, owner)`와
`runPrepared`를 재사용한다. request에는 위 동작 필드만 넘기고, owner의 account/config/
identityModule/identityHash/workspaceIdentityHash는 등록된 호스트 권위에서 공급한다.
원격 입력으로 이 권위를 받지 않는다. 기존 dispatcher가 두 action을 실제로 연결하고
그 companion·identity·backup·lease 의존을 같은 immutable closure로 봉인해야 한다.
이 소스 어댑터가 설치된 private manager의 동작을 바꾸지는 않는다.

binding 준비기의 `-AdditionalActions`로 두 action을 명시 제안할 수 있다. 기본값은
기존 source-read/plan-file 두 action 그대로다. 출력은 계속 `DRAFT_NOT_INSTALLABLE`이며
owner allowlist·실행 서비스·등록·계정·경로는 바꾸지 않는다. 실제 설치·게시·로그인·GPT
호출은 각각 별도 근거가 필요하다. 이번 연결의 실제 발신·운영 수용은 미실행이다.
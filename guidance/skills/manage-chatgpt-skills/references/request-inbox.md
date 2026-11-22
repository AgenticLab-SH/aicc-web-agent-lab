# 일반 Chat의 자산 요청 파일

기존 AICC Workspace 등록 별칭을 열고 `web-asset-requests/README.md`를 읽는다. 소유자 저장소의 `skill-packages` 원본을 원격 컨테이너 경로로 실행하지 않는다. 등록 workspace 안에 파일을 넣고 SHA256을 고정한다. 기존 후보 목록의 `remoteId:null`은 원격 부재가 아니다.

`Manage-WebAssetInbox.ps1`은 지침·스킬·플러그인·프로젝트 요청의 로컬 등록·수정·제거를 담당한다. 원격 적용은 기존 start/status와 Plugin Creator를 사용한다. 상주 작업이나 자동 업로드를 만들지 않는다.

```powershell
powershell.exe -NoProfile -File web-asset-requests/Manage-WebAssetInbox.ps1 -WorkspaceRoot REGISTERED_ROOT -Action Capabilities
powershell.exe -NoProfile -File web-asset-requests/Manage-WebAssetInbox.ps1 -WorkspaceRoot REGISTERED_ROOT -Action Put -RequestPath web-asset-requests/input/my-change.json
powershell.exe -NoProfile -File web-asset-requests/Manage-WebAssetInbox.ps1 -WorkspaceRoot REGISTERED_ROOT -Action List
powershell.exe -NoProfile -File web-asset-requests/Manage-WebAssetInbox.ps1 -WorkspaceRoot REGISTERED_ROOT -Action Show -Id my-change
```

요청은 schemaVersion=1, 고정 id, kind(instructions/skill/plugin/project), operation(create/update/delete/options), scope(personal/workspace), target.accountAlias/remoteId, files 배열, options 객체, reason, safetyState를 갖는다. 기존 자산은 exact remoteId가 필요하다. options에 원하는 세부값을 적으며 실제 지원 여부는 Capabilities와 공식 편집기의 관측으로 결정한다. 빈 files도 배열로 명시한다.

수정 Put과 로컬 Remove는 마지막 revision을 ExpectedRevision으로 전달한다. 이전 버전과 파일은 그대로 보존하며 Remove는 로컬 tombstone이다. 원격 삭제를 뜻하지 않는다. HOLD_SECURITY/HOLD_UNCERTAIN 요청은 새 id나 receipt로 재생하지 않고 원거절/원 operation 담당에게 조정한다.

원격 변경 전에는 actual identity/exact ID/현재 원문, [양쪽 원본 백업](asset-lifecycle.md), 같은 receipt와 operation이 필요하다. Prepare-WebManagementRequest.ps1이 지원하는 입력은 준비 결과의 request_path/request_sha256/request_id로 한 번만 start한다. 결과 불명은 원 status를 조회한다. 스킬 전체 ZIP 교체·새 supporting file·기존 프로젝트 memory 변경 등 지원되지 않는 설정을 삭제 재생성으로 대신하지 않는다.

Windows ZIP은 New-PortableAssetZip.ps1의 forward-slash entry로 생성한다. 파일 선택은 등록 workspace의 regular file만 허용하며 원본/다른 writer의 자료를 보존한다. Plugin Creator는 기존 release ID의 update와 exact delete_paths로 파일을 편집한다. 플러그인 본체 삭제는 uninstall과 구분한다.

## 원격 ID와 업로드 영수증

개인 스킬 list는 공식 ‘내가 만든 항목’ 화면이 실제 요청한 owner 목록에서 읽은 exact id/name/version을 함께 반환할 수 있다. 제목만으로 ID를 추정하지 않는다. ID가 없는 행은 inspect로 기존 편집기의 exact ID를 확보한다. personal 스킬의 내용이 Business 공용 스킬 관리라고 해도 그 개인 자산의 scope는 personal이다. 지피티 스킬 ID와 같은 이름의 플러그인 skill을 합치지 않는다.

변경 요청을 만들기 전에 기존 Inbox List/Show를 읽고 같은 대상과 후보를 재사용한다. 등록 성공은 원격 적용이 아니다. 기존 본문과 references를 읽어 Web용 조정 내용을 보존하며 필요한 파일만 변경한다. 전체 ZIP 교체나 없는 supporting file 추가를 본문 갱신으로 포장하지 않는다.

새 mutation은 기존 backup receipt 옆 .transport.jsonl에 실제 응답의 method/status/path와 반환된 식별자 후보만 즉시 기록한다. 응답 본문·로그인 정보는 기록하지 않는다. 반환 ID는 미검증 힌트이며 fresh owner/editor 및 원문 readback 전에는 설치 성공으로 인정하지 않는다. HTTP201 뒤 목록에 없으면 같은 원 operation/receipt를 조정한다. 목록 부재만으로 NOT_CREATED 처리하거나 global writer.lock을 삭제하지 않는다. 이미 발생한 불명 요청에 이 개선을 소급해 원격 결과를 만들어 넣지 않는다.

소스·홈 스킬 배포·관리 플러그인 release·owner-bound 고정 runtime은 별도다. 플러그인 파일 갱신만으로 고정 runtime이 바뀌지 않는다. active/UNKNOWN이 있는 실행 경로의 교체는 기존 운영 계약에 따라 HOLD한다.

## 보조파일 계획을 같은 Inbox 후보에 연결 · source-only

기존 skill/personal/update 후보의 target.remoteId·files·reason을 유지하고 options에 원 filePath/expectedCurrentSha, planRequestId/planSHA256, backupReceipt, 원 apply request_id를 연결한다. Put 갱신은 기존 ExpectedRevision CAS를 쓰며 이전 revision/보안·불명 상태를 보존한다. 새 Inbox나 원격 자산 ID를 만들지 않는다.

지원되는 기존 references Markdown만 personal-skill-plan-file(commit:false)로 fresh owner/editor와 두 목적지 backup을 결속한다. 원 status가 반환한 plan_sha256을 같은 personal-skill-update-body 요청의 skill.planRequestId/planSHA256에 전달하고 한 번만 start한다. 불명은 그 apply request_id의 status와 file_target을 회수한다. 로컬 STAGED/FILE_PLAN_READY는 원격 저장 완료가 아니다.

Prepare-WebManagementRequest.ps1 및 manager/provider source에만 이 연결을 작성했다. 기존 설치본의 action/owner allowlist가 없으면 HOLD하며 이번에 홈/플러그인/runtime을 배포하지 않았다. whole ZIP 교체·없는 파일 생성은 공식 same-ID surface 근거가 없어 여전히 HOLD다.

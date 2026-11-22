# 지피티 자산의 생성·수정·삭제와 중복 없는 백업
## 패키지 종류와 실제 적용 경계

- 로컬 스킬 ZIP 후보: 기존 private package inspector의 skillUploadMetadata/readSkillUpload은 ZIP SHA, 루트 SKILL.md 경로, 각 supporting file의 상대 경로·바이트 수·SHA-256을 반환한다. 이 목록은 원본 누락 판별용이며 원격 버전·설치·호출 근거가 아니다. Project Source read의 RESERVED_NOT_DISPATCHED도 파일 선점일 뿐 원격 다운로드 접수가 아니다.
- ChatGPT 개인 스킬: 현재 fixed personal manager는 exact owner-created skill ID의 기존 SKILL.md 또는 이미 존재하는 references Markdown을 inspect/update-body 한다. 새 references 파일 두 개의 추가나 같은 ID whole-ZIP 교체는 지원 근거가 없다. 기존 ID 6acdb581...의 원 UNKNOWN·보안 거절은 원 operation으로 조정하고 새 skill ID, 계정 또는 업로드로 대신하지 않는다.
- Plugin Creator 플러그인: 현재 연결 도구의 get_plugin_metadata/get_plugin_files로 exact plugin ID와 release를 읽고, 지원되는 update_plugin에는 전체 의도 파일을 포함한 ZIP과 관측된 current_release_id를 expected_release_id로 결속한다. 저장된 release, 설치, 도구 노출, 실제 호출은 따로 확인한다. 개인 스킬 ID나 ZIP을 플러그인 ID로 바꾸지 않는다.
- 공식 API Skills version endpoint는 API Skills의 별도 수명주기다. 이 endpoint의 버전 생성은 ChatGPT 개인 스킬 fixed manager의 같은 ID 전체 패키지 갱신 근거가 아니다.

실행은 source 구현, 설치된 fixed manager와 owner allowlist, 등록 grant, 현재 노출 도구, 원 operation의 실제 호출 결과 순서로 구분한다. 공개 source의 지원 코드나 local package inventory로 설치판 action·원격 저장 성공을 선언하지 않는다. 현재 manager가 지원하지 않는 action은 정확한 owner release와 원 요청 조정 뒤에만 사용한다.

코덱스와 일반 Chat 지피티는 같은 source와 원장을 사용한다. 지피티의 로컬 접근은 **기존 AICC Workspace가 우선**이다. 실제 `list → open → info/read/exec → close`의 capability와 열린 workspace 경계를 지킨다. Web 컨테이너에서 Windows 경로를 실행하지 않는다. AICC exec가 AppContainer라면 호스트 AppData Node·브라우저 CDP·gh가 보이는지 추정하지 않는다. 런타임 부재/격리 거절은 해당 기능의 capability 미확보로 남기고 소유자에게 필요한 지원 기능을 보고한다. RDC를 기본 실행 경로나 보안 거절 뒤 자동 fallback으로 쓰지 않는다. Codex는 같은 승인된 로컬 manager를 직접 쓸 수 있으나 Web에서 거절된 명령을 대신 실행해 Web 성공으로 처리하지 않는다. 이미 거절된 작업은 재시도·도구 변경 전에 원거절을 해소한다. 실행 중 session은 같은 ID로 회수하고 원 요청을 재발신하지 않는다.

Notion은 사용자가 요구한 두 번째 백업 목적지다. 자산 관리 작업을 Notion 자체 관리 작업으로 확대하지 않는다. 작은 새 텍스트 버전은 기존 페이지에 JSON 코드 블록 한 개를 저장하고 실제 fetch bytes를 확인하는 방식을 우선한다. 기존 첨부가 `download_attachment={}`를 반환했다고 첨부→다른 블록 교체를 필수로 만들지 않는다. 원첨부와 미확인 receipt를 보존하고 같은 버전을 재업로드하지 않는다. 원문 저장/재조회·최종 확인·변경 적용은 별도 상태다.

Notion 도구의 빈 객체 `{}`는 파일이 없거나 업로드가 실패했다는 증거가 아니다. 도구가 원문을 반환하는 응답 경로와 실제 첨부 존재를 구분한다. 같은 upload ID의 읽기 결과를 조정하며 새 업로드는 하지 않는다. 로컬 Codex에서 같은 공식 연결로 원문을 회수했다면 실제 응답과 SHA 대조 증거를 공유 원장에 남길 수 있지만, 이를 Web 단독 다운로드 성공으로 보고하지 않는다. 이후 작은 새 버전은 inline JSON과 실제 page fetch를 사용해 Web이 직접 원문을 대조할 수 있게 한다. 같은 버전의 첨부와 inline을 함께 새로 만들지 않는다.
공통 목적지 원칙은 [파일 전달 정본](../../aicc-workspace-operator/references/notion-file-transfer.md#notion-목적지-원칙--공통-정본)을 따른다. 목적지 없이는 기존 성공본을 보존하고 Notion 쓰기를 HOLD한다.
## 백업은 변경의 선행 조건

1. exact 대상의 현재 본문·지침 또는 전체 패키지를 읽고 원하는 파일과 함께 고정한다. 삭제는 전체 복구본이 있어야 하며 대화·자료 손실이 있는 Project 삭제는 해당 손실 승인을 별도로 유지한다.
2. `scripts/WebAssetBackup.ps1 -Action Prepare -ManifestPath <absolute-json>`로 복구 가능한 실제 바이트와 내용 SHA256을 만든다. 변경 전·후 파일에 각각 `before/`, `desired/` 경로를 사용한다. 비밀·로그인·프로필·세션·원문 대화는 포함하지 않는다. 민감 자료의 목적지 접근권한은 먼저 확인한다.
3. 같은 실행기의 `-Action GitHub -ReceiptPath <returned-path>`로 기존 비공개 저장소에 내용 주소 객체를 저장한다. 같은 해시의 원격 바이트가 있으면 재업로드·새 commit을 만들지 않는다. 404 이외의 실패는 부재로 취급하지 않는다.
4. 작은 UTF-8 bundle은 기존 비공개 Notion page의 버전 구역에 compact JSON 원문을 json 코드 블록 하나로 저장할 수 있다. 실제 fetch의 원문에서 해당 코드 블록 bytes를 추출해 SHA256을 대조한다. 이 방식의 NotionDownloadPath는 {source:"notion-page-inline-json",notionPageId:"EXACT_ID",content:"ACTUAL_FETCHED_CODE_BLOCK_BYTES"}이며 NotionPageReadPath에는 원 fetch 응답을 보존한다. 파일 첨부와 inline을 동시에 같은 버전 백업으로 유지하지 않는다. 기존 미검증 첨부를 전환할 때 해당 exact file tag만 JSON 블록으로 교체하고 새 page/upload를 만들지 않는다. 큰 bundle과 첨부 방식은 아래 절차를 유지한다. receipt의 Notion 상태가 VERIFIED면 기존 page/upload 또는 inline 버전을 재사용한다. NOT_STARTED일 때 `BeginNotion -NotionPageId <exact-page-id> -NotionPageReadPath <actual-fresh-fetch-json>`으로 목적지 검사를 통과하고 intent를 1회 기록한 뒤 기존 Notion connector의 create_attachment(content, filename)로 JSON 실제 파일을 올린다. 200 KiB를 넘으면 create_file_upload와 그 도구가 반환한 단회 업로드 URL을 사용한다. upload ID와 create/update page intent를 같은 receipt 옆에 먼저 저장한다. 기존 exact page가 있으면 새 page를 만들지 않는다. 목적지 미지정은 HOLD다. 확인되지 않은 부모·draft·root·parent 생략으로 최상위 페이지를 자동 생성하지 않는다.
5. page에 bundleSHA256과 복구 가능한 JSON 원문 또는 첨부를 저장하고 connector fetch(page), download_attachment(upload ID)의 원결과를 로컬 파일로 보존한다. `ConfirmNotion`에 NotionPageId/NotionFileUploadId/NotionDownloadPath/NotionPageReadPath를 전달한다. 큰 binary는 connector가 반환한 허용 파일 다운로드로 bytes를 비교하며, 현재 작은 JSON 경로의 한계를 성공으로 덮지 않는다.
6. `AssertReady`가 양쪽 VERIFIED일 때만 해당 영수증으로 변경한다. JSON 코드 블록은 실제 bundle 원문 전체가 저장·재조회·해시 일치해야 하며 링크·경로 목록·hash만 있는 Notion page는 원본 백업이 아니다. 외부 저장 하나가 실패하면 변경은 HOLD하고 성공한 한쪽은 재사용한다.

불명 응답은 같은 hash·page/upload·GitHub object·request로 조회해 조정한다. timestamp 디렉터리, 새 page, 새 이름, 다른 계정으로 재생하지 않는다. 객체 한 개/내용 버전, page 또는 기존 page의 버전 첨부 한 개/내용 버전만 유지한다. 로컬 정본과 원격 백업 목적지를 중복 원장으로 만들지 않는다.

## 백업 커밋과 코드 CI

복구 객체는 기존 비공개 저장소의 전용 백업 경로에 유지한다. 그 경로만 바뀐 push/PR은 전체 코드 CI에서 제외하고, 코드 변경이 섞이면 정상 검사한다. 새 목적지를 연결할 때도 백업 파일 하나가 여러 OS의 빌드·검사를 기동하지 않도록 기존 workflow와 필수 체크를 함께 살핀다. 내용 해시가 같은 객체·영수증은 재사용하며 백업 자체나 의존성 보안 검사를 지워 사용량 문제를 감추지 않는다. 공통 판단은 [CI와 예약 실행](../../develop-from-project-spec/references/file-lifecycle.md#ci와-예약-실행)을 따른다. 이 절차는 코덱스 로컬 정본·홈에도 적용되며 원격 지피티 자산 게시와는 별도다.
## Manifest

```json
{
 "schemaVersion":1,
 "assetKey":"skill|REGISTERED_ALIAS|EXACT_ID_OR_NEW_SLUG",
 "operation":"update-body",
 "preimageSHA256":"fresh-before-text-sha256",
 "desiredSHA256":"desired-text-sha256",
 "recoveryComplete":false,
 "privacyReviewed":true,
 "stateRoot":"ABSOLUTE_EXISTING_PRIVATE_DIRECTORY",
 "githubRepository":"EXISTING_OWNER/PRIVATE_REPO",
 "githubBranch":"EXISTING_BRANCH",
 "files":[
  {"path":"before/SKILL.md","source":"ABSOLUTE_BEFORE_FILE","sha256":"fresh-before-text-sha256"},
  {"path":"desired/SKILL.md","source":"ABSOLUTE_DESIRED_FILE","sha256":"desired-text-sha256"}
 ]
}
```

새 asset의 preimage와 삭제의 desired는 빈 바이트의 SHA256을 쓴다. 파일 줄바꿈은 manager가 실제 저장하는 정규화와 맞춘다. full-package 삭제는 원 ZIP도 포함하고 recoveryComplete=true를 사용한다. content address와 stable ID를 유지하며 다른 source를 같은 receipt로 적용하지 않는다.

## 경로별 실제 변경

- 개인 스킬: personal-skill-manager의 `--backup-receipt`에 양쪽 VERIFIED 영수증을 전달한다. list/inspect → ZIP upload, update/update-body, owner exact-ID delete를 기존 옵션으로 실행한다. 참조 Markdown은 file-path까지 결속한다. 새 supporting file은 기존 패키지 편집 기능의 실제 지원 범위를 확인한다.
- 공용 스킬: 기존 workspace manager와 실제 관리 권한을 사용한다. 같은 Business workspace는 한 자산만 유지한다. 개인 복제로 편집 불가를 우회하지 않는다.
- 지침: 전역 사용자 지침은 실제 Settings의 exact 필드, Project 지침은 manage-chatgpt-assets의 exact ID 편집기로 변경한다. 새 지침은 해당 필드를 채우고 삭제는 해당 필드를 비우는 것이다. 기존 개인정보 칸·다른 지침은 보존한다. before/desired 원문을 양쪽 백업한 뒤 같은 preimage 조건으로 저장한다.
- 플러그인: Plugin Management search → Plugin Creator get_plugin_files/get_plugin_metadata → 변경 전 전체 archive 백업 → create_plugin 또는 expected_release_id가 결속된 update_plugin을 사용한다. supporting file 삭제는 delete_paths의 exact file만 사용한다. 기존 App/MCP 연결·audience는 보존한다. 버전 충돌은 최신 release를 회수한다.
- 플러그인 설치 해제: exact 사용자 지정 대상에 공식 uninstall을 사용한다. 설치 해제는 배포 원본 삭제가 아니다. 플러그인 본체 삭제는 exact ID의 지원 UI에서 추가 작업 → 플러그인 삭제 → 대상 이름의 영구 삭제 확인을 사용한다. project-executor의 plugin-delete 입력은 전체 archive 복구본·버전·양쪽 백업을 결속한다. 확인 화면이 늦게 닫혀도 재삭제하지 않고 공식 get_plugin_metadata의 exact-ID NOT_FOUND로 조정한다. uninstall을 본체 삭제 완료로 보고하지 않는다. AICC 연결 자체를 제거해 실행 경로를 끊지 않는다.
- Project: manage-chatgpt-assets와 design-chatgpt-projects를 사용한다. 새 이름은 w-형식, memory는 default다. 기존 Project의 변경 불가 memory는 재생성하지 않고 그대로 보고한다.

변경 결과는 exact ID·전후 hash·외부 저장 receipt·지피티 스킬 로드/호출을 구분한다. 이 절차는 도구 권한을 우회하거나 현재 작업 밖의 자산 삭제 승인을 만들지 않는다.
## 실행 가능 여부의 구분

스킬·플러그인 설치나 코덱스의 직접 적용 성공은 일반 Chat의 AICC 호출 증거가 아니다. 일반 Chat·xhigh의 실제 도구 호출, 기존 AICC connector 응답, 원격 자산 readback을 따로 기록한다. 화면 한도 안내는 일반 Chat의 중단 조건이 아니다. 기존 OCX의 자동 계정 전환·소진 전 차단을 유지한다. MCP 429는 한도 배너와 분리해 기존 터널·Task·MCP의 실제 실패를 좁힌다. [한도와 연결 기준](quota-and-connection.md)을 따른다. 자동 충전·수동 계정 교체·Work 전환으로 대신하지 않는다. 백업과 독립 source 작업은 계속하며 미전송 요청을 실제 전송으로 보고하지 않는다.

## 기존 개인 supporting-file의 계획 결속

source의 personal-skill-plan-file은 기존 references Markdown의 fresh 논리 문서 SHA를 preimageSHA256으로 사용하며, 정규화된 desired 본문 SHA와 두 실제 파일 바이트를 기존 GitHub/Notion VERIFIED bundle에 요구한다. assetKey/operation은 기존 skill|ACCOUNT|EXACT_ID / update-body를 유지한다. 파일 경로는 원 provider의 immutable 계획 결과와 apply 입력의 planRequestId/planSHA256으로 결속한다. 전체 ZIP 최신성이나 새 파일 생성 지원을 만들지 않는다.

apply는 원 backupReceipt 경로와 bundleSHA256을 보존하고 dispatch 직전 같은 before/desired 바이트를 재대조한다. 원 .operation.json/.operation.lock이 있으면 새 백업이나 새 apply를 만들지 않고 기존 request_id의 status/transport/원 operation을 회수한다. 이 기능의 source는 검증 미실행·미설치이며 실제 자산 변경을 이번에 수행하지 않았다.

# manage-chatgpt-personal-skills 선택 절차

이 문서에서 선택한 단계만 읽는다. 명령 예제의 기준 작업 폴더와 인라인 리소스 경로는 상위 스킬 루트다. Markdown 링크는 이 파일 위치를 기준으로 한다.

## Reuse by an explicitly authorized workspace workflow

The personal commands and prohibitions above remain the default. A workspace-skill caller may reuse this companion only for read/Markdown update of an existing preserved resource using the explicit `--editor-binding` and `--identity-module` mode in [the manager contract](../../manage-chatgpt-skills/references/manager-contract.md). That caller must hold the user's existing workspace-edit authorization, preserve the exact ID/owner/package preimage, and audit the live account and workspace. The mode cannot upload, delete, transfer ownership, or replace a whole ZIP. A displayed editor does not prove a successful save; a permission refusal stays HOLD.

## 기존 보조파일의 명시 계획·단회 적용 · source 계약

이번 기능은 **소스만 작성·검증 미실행·미설치**다. 홈 안내, 관리 플러그인 release와 고정 manager/provider runtime은 별도이며, 기존 실행기의 action/owner allowlist가 지원하지 않으면 HOLD한다. 설치된 도구에 이름만 넣어 새 기능을 시험하지 않는다.

기존 Inbox List/Show에서 같은 exact 개인 skill ID·후보·불명 operation을 먼저 인수한다. 이미 지원되는 기존 references/<slug>.md만 대상으로 한다. 새로운 파일이나 whole ZIP을 기존 본문 갱신으로 바꾸어 보내지 않는다.

1. 같은 등록 owner에서 fresh inspect로 full logical file SHA를 얻고 before/desired 실제 바이트를 기존 GitHub·Notion 양쪽에 VERIFIED한다. backup operation은 update-body, assetKey는 기존 skill|ACCOUNT|EXACT_ID다. before 파일과 UTF-8 BOM 제거/CRLF→LF로 정규화한 desired 파일 SHA가 모두 bundle에 있어야 한다. 원 ZIP도 보존하지만 이 파일 계획이 전체 원격 ZIP의 최신성을 증명하지는 않는다.
2. source의 personal-skill-plan-file은 commit:false이며 skill의 name/displayName/skillId/filePath/expectedCurrentSha/bodyFile/bodyFileSHA256과 원 backupReceipt를 받는다. owner-created exact editor와 fresh 파일 SHA를 확인하고 FILE_PLAN_READY / existing-support-file-plan/v1을 반환한다. 새 필드나 save/upload/delete/send는 하지 않는다. 파일을 지원 editor에서 읽지 못하면 HOLD_EXISTING_SUPPORT_FILE_UNPROVEN이며 파일 부재를 추정하지 않는다.
   등록 workspace에서 기존 `Prepare-WebManagementRequest.ps1 -Action Prepare -InputPath <요청 JSON>`로 원 backupReceipt와 후보 바이트를 먼저 고정한다. 같은 요청의 `request_id`로 `aicc_web_management_start/status`를 사용한다. 준비 결과는 원격 계획 실행이나 설치 근거가 아니다.
3. 원 계획 request ID로 status를 읽고 반환된 plan_sha256을 보존한다. personal-skill-update-body에 같은 대상·경로·후보 바이트·backupReceipt와 skill.planRequestId/planSHA256, commit:true를 한 번 전달한다. provider는 같은 binding/workspace/actual identity의 완료된 계획 원결과만 인정한다. manager는 edit 전 fresh preimage와 backup bundle을 다시 대조하고 기존 CodeMirror/save/readback 및 one-use backup operation을 사용한다. 변경 없음은 이미 현재 상태로 반환하며 저장하지 않는다.
4. 원 receipt에 .operation.json 또는 .operation.lock이 있으면 새 apply를 만들지 않는다. 원 apply request_id로 기존 status를 재열고 file_target/원 결과·transport 영수증을 조정한다. status는 저장을 재호출하지 않는다. 시간 초과·UNKNOWN·권한 거절은 새 receipt/새 ID/다른 계정으로 재생하지 않는다.

전체 ZIP 교체는 여전히 미지원이다. 없는 supporting-file 생성은 위 `add-file`(CLI, references/<slug>.md 한 개)로만 소스에 추가되었고, 이 plan-file/update-body 경로와 AICC connector action(`personal-skill-*`)·고정 runtime allowlist에는 아직 없다. 해제 담당은 기존 manager 유지보수/메인 owner이며, 첫 실제 저장의 관측(경로 유지·version·HTTP 응답)과 runtime 교체를 각각 인수해야 한다. delete/re-upload, endpoint/버튼 이름 추측, 설치된 실행본 직접 교체는 하지 않는다.


# 변경된 파일만 지피티에 동기화
## 배포 응답과 Web 동기화의 독립 판정

Codex HOME deployer의 deployed/unchanged는 로컬 target의 결과다. refused_count는 원 report의 refused 배열에 있는 대상·action·reason을 확인한다. legacy manifest의 source root 불일치로 migrate-retire만 거절된 경우 성공 target 배포를 취소하거나 legacy 파일을 강제로 지우지 않는다.

Web sync의 ASSESSMENT_REQUIRED_NO_BINDING은 선택한 이름이 기존 owner manifest의 bindings에 없다는 뜻이다. 원격 자산 부재, 권한 거절 또는 도구 미게시 증거가 아니다. ASSESSMENT_REQUIRED_SOURCE_CHANGED는 현재 source 파일 SHA와 manifest의 approvedSHA256 차이로 manager 호출 전에 멈춘다. 영향도 판단·원 바이트 백업과 승인 SHA를 같은 기존 binding에서 갱신해야 한다. INSPECT_FAILED_NO_WRITE는 기존 manager의 inspect를 요청했으나 원격 preimage를 받지 못한 상태이며, registered_browser_offline이면 등록 프로필의 listener 부재만 의미한다. 로그인·자산·권한 상태를 추정하거나 다른 browser/계정으로 전환하지 않는다.

Sync runner의 actualInvocation은 NOT_REQUESTED, INSPECT_REQUESTED, UPDATE_REQUESTED로 호출 단계만 표시한다. 요청은 성공·저장·설치·호출과 다르다. 원 불명은 같은 manager operation/status와 기존 state.files key에서 조정하고 새 ID로 다시 보내지 않는다.

## 변경 동기화

로컬 source 변경 시 작성자가 `sync`(공통 절차), `adapt`(환경별 조정 필요), `local-only`를 짧은 이유와 함께 판단한다. `adapt`는 승인된 Web용 파일을 준비한 뒤 `sync`로 바꾼다. 모델은 의미 차이만 판단하고 파일 비교·반복 적용·영수증은 코드가 담당한다. 기존 상태·불명 업로드·ID 대응표를 보존한다.

`Sync-LocalToWeb.ps1`은 기존 personal-skill-manager.cjs의 inspect/update-body를 호출한다. 새 API·확장 설치·계정 전환이 없다. 현재 등록된 exact resource ID와 fresh manager preimage를 사용하며, 지원되는 기존 Markdown 파일만 갱신한다. script/asset·새 파일은 PACKAGE_UPDATE_REQUIRED로 남긴다. 같은 workspace 자산은 계정별로 복제하지 않는다.

## 소유자 전용 manifest

JSON schemaVersion=1; manager/config/playwrightModule/identityModule/stateFile은 실제 발견한 절대 경로다. bindings 항목: name, sourceRoot, account, skillId, displayName, assessment, reason, 선택 editorBinding, files:[{path,remoteExists:true,approvedSHA256}]. editorBinding은 기존 manager의 승인된 workspace-editor 계약을 따른다. 경로·계정·ID는 공개 스킬에 하드코딩하지 않는다. files는 실제 등록 파일 목록으로 만들고 의미 판단 때 승인한 로컬 SHA를 approvedSHA256에 결속한다. 이후 본문이 달라지면 ASSESSMENT_REQUIRED_SOURCE_CHANGED로 남기고 새 영향도 판단 없이 게시하지 않는다. 미지원·신규 파일을 기존 파일로 간주하지 않는다.

stateFile 부모는 기존 private 운영 폴더다. 파일별 성공 hash는 로컬 변경 생략에만 사용한다. 캐시 일치는 원격 최신·설치·호출의 증거가 아니다. DISPATCHING/OUTCOME_UNKNOWN는 manager 영수증과 원결과를 조정한 뒤에만 해제한다. 상태 파일 삭제·새 경로로 불명 요청을 재생하지 않는다. lock은 동일 manifest 병렬 발신을 막는다. 중앙은 manifest 하나와 원격 대상별 단일 발신자를 유지한다.

## 기존 sync state의 추적 메타데이터

`state.files`의 기존 schemaVersion=1과 status/cache/불명 재생 방지는 유지한다. 새 실행은 같은 파일 항목의 `traceMetadata`에 기존 manifest의 `expectedBinding`(accountAlias·skillId·filePath·sourceRoot·approvedFileSHA256), 실제 사용한 `backupReceiptRef`, 기존 inspect/manager 결과의 허용된 상태·ID·본문 SHA·ZIP SHA·성공 여부와 manager exit code를 함께 보존한다. 본문·응답 원문·세션·인증 자료는 복사하지 않는다. 저장된 alias와 승인 파일 SHA는 실제 로그인 신원이나 source bundle 증거로 승격하지 않는다.

`observed`는 기존 반환값에 실제 존재하는 identityHash/workspaceIdentityHash, sourceInstance/bundleSha256, packageSha256, consumerId/consumerRevision, receiptPath/operationReceiptPath만 복사하고 `observedFieldOrigins`로 inspect/manager 출처를 남긴다. 반환되지 않은 값은 null과 `NOT_RETURNED_BY_EXISTING_MANAGER`, 잘못된 형식/충돌은 해당 이유를 보존한다. 반환 ID/account가 기대 binding과 다르면 trace의 holds에 차이를 남긴다. 이 추적 표시는 기존 성공/실패 상태를 새 승인이나 완료 판정으로 바꾸지 않는다.

특히 operation 경로는 manager가 명시적으로 반환한 절대 경로만 기록하며 backupReceipt 이름에 `.operation.json` 등을 붙여 추정하지 않는다. `backupReceiptRef`는 이미 사용한 입력 참조이며 새 영수증 생성이 아니다. 백업 JSON의 bundleSHA256·업로드 zipSHA256/packageSha256·개별 파일 SHA를 source bundleSha256로 대체하지 않는다. 현재 manager가 source bundle이나 양쪽 identity를 반환하지 않으면 identityState/sourceBundleState는 UNKNOWN이다. 값이 있어도 RETURNED_METADATA_ONLY이며 fresh 관측·설치·loader/call 검증은 아니다.

새 manager/원격 조회·추가 실행·receipt 생성은 없다. 새 metadata가 없다는 이유로 기존 정상 sync를 막지 않으며 과거 state는 재작성하지 않는다. 설치·소비 추적은 실제 증거를 반환하는 기존 manager owner가 그 필드/참조를 제공한 뒤 잇는다. 이번은 source 계약 보완이며 검증·실행·홈 배포는 미실행이다.

## 실행 연결

기존 로컬 배포기에 `-WebSyncManifest <private-json>`을 전달하면 선택한 SkillNames에 대해 배포 뒤 연계한다. 명시하지 않으면 `AICC_WEB_SKILL_SYNC_MANIFEST`의 기존 운영 manifest를 사용한다. 기존 프로세스도 User 환경값을 읽으며 명시적인 빈 WebSyncManifest는 이번 호출의 원격 연계를 생략한다. `-Plan`은 원격 호출 없이 변경 후보만 낸다. manifest 미설정은 원격 반영 완료가 아니며 담당자가 ASSESSMENT_REQUIRED로 남긴다. 임의 예약·상주 감시를 새로 만들지 않는다.

코덱스 홈 배포와 Web 적용·사용자 설치·지피티 스킬 호출은 별도다. 신규 코드 검증은 현재 모델 정책과 명시 요청만 따른다. 지원되지 않는 항목은 정확한 owner·해제 조건으로 넘긴다.

## 로컬 변경을 지피티에 연결하기

스킬을 바꿀 때마다 지피티 영향도도 함께 판단한다. 공통 절차는 동기화하고, 환경별 차이는 해당 참조에 적응시키며, 로컬 전용 수정은 이유만 남긴다. 판단과 변경 파일 해시만 저장하며 원문을 모델에 반복 입력하지 않는다.

[변경 동기화 계약](change-sync.md)을 따른다. 기존 manager로 exact ID의 지원 파일만 갱신한다. 신규 파일·실행 파일·패키지 구조 변경은 별도 패키지 작업으로 남기며 전체 삭제·재등록으로 대체하지 않는다. source·홈 배포·지피티 적용·설치·호출은 별도 상태다.


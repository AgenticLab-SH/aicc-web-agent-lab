# 스킬 manager 실행 계약

## 필요한 경로만 선택

- 로컬 절차 읽기: 현재 광고된 AICC `aicc_skill_inventory`의 ID로 `aicc_skill_read`를 호출한다. 지피티 스킬 설치의 증거가 아니다.
- 개인 지피티 스킬 자산: `manage-chatgpt-personal-skills/scripts/personal-skill-manager.cjs`의 현재 실제 옵션을 따른다. 등록 세션과 task-owned lease를 쓰고 `list`, `inspect`, `upload`, `update-body`를 해당 지원 범위에서 사용한다.
- Business 공용 자산: manage-chatgpt-workspace-skills와 실제 기존 workspace manager를 쓴다. 같은 workspace를 계정별로 복제하지 않는다.
- 로컬 변경 전파: [change-sync.md](change-sync.md)의 의미 판단·해시 캐시·기존 manager 연계를 따른다.

실제 manager 경로·플래그·도구 노출을 필요한 만큼 읽고 사용한다. 과거 런북의 파일 이름·포트·계정·숫자·특정 대화가 현재 구현이나 권한을 증명하지 않는다. 누락된 파일은 과거 명령으로 추측해 실행하지 않는다.

## 신원·소유권·변경

실제 로그인 account/workspace와 exact resource ID를 결속한다. 이름은 탐색 단서다. 기본 개인 경로는 `내가 만든 항목`의 exact 행을 사용하고 설치된 타인 항목과 구분한다. UI 목록 준비 실패를 빈 목록이나 자산 부재로 처리하지 않는다.

기존 workspace 편집 경로가 이미 지원되면 inspect/update-body에만 editor-binding과 identity-module을 쓸 수 있다. binding schemaVersion=1, policy=EXISTING_WORKSPACE_EDITOR_ONLY, accountAlias, resourceId, name, ownerLabel, 기존 ZIP packagePreimage/packageSHA256, expectedIdentityHash/expectedWorkspaceHash를 결속한다. 실제 로그인은 이동 전후 비교하고 현재 본문 SHA는 fresh inspect로 얻는다. 이 경로는 소유권 변경·권한 확대·전체 ZIP 교체가 아니다.

기존 본문은 exact 현재 SHA를 조건으로 저장한다. UI가 지원하는 기존 SKILL.md·references의 Markdown과 기존 agents/openai.yaml의 표시 메타데이터만 변경하고 비밀·개인 설정·대화 원문을 배포하지 않는다. 새 파일이나 script/asset 변경은 package 작업으로 별도 기록한다. 전체 원격 ZIP 바이트와 본문 일치를 혼동하지 않는다.

## 전송과 회복

원격 변경 전에 대상·preimage·intent를 private 영수증에 보존한다. HTTP 응답, UI 저장 완료, 원격 ID, 설치, 지피티 스킬 호출은 별도다. 불명 결과는 원래 ID/attempt를 조정하며 새 경로·다른 계정·재업로드로 재생하지 않는다. 403/security 거절과 일반 로딩·CDP 시간초과를 구분한다. 권한 거절은 우회하지 않는다.

확정 실패는 원인을 좁히고 조건이 달라진 뒤 해당 동작만 재시도한다. 같은 화면 준비 실패가 반복되면 목록·편집기·연결 중 실패 경계를 짧게 남기고 전체 항목을 똑같이 순회하지 않는다. 브라우저 팝업은 실제 snapshot으로 확인한 좁은 제어만 처리하며 프로필 초기화·사용자 탭 복원/종료를 대신하지 않는다.

작업의 exact lease만 반환한다. source, 홈 배포, AICC 읽기, 원격 등록·본문 적용, 사용자 설치, 실제 호출을 분리한다. 현재 모델 정책과 명시 요청이 허용하는 검증만 하며 미실행은 그대로 쓴다.

## 과거 장애 근거

반복 문제의 관련 증거가 필요할 때만 [과거 manager 기록](manager-history.md)을 읽는다. 그 기록은 당시 관측이며 현재 실행 절차·권한·완료 판정의 정본이 아니다. 새 사례는 capture-operational-knowledge의 기존 관련 사례에 필요한 차이만 남긴다.
## 관리와 대화 전달 구분

지피티에 질문·검토·ZIP 제작을 맡기는 일은 지피티 스킬 등록이 아니다. `use-web-gpt`의 기존 전송·회수 도구를 쓰고, 자산 등록·설치·원격 본문 수정은 이 manager 계약으로만 처리한다. 꺼진 기존 등록 전용 브라우저는 상시 승인된 broker 기동 절차로 준비하며 다시 승인을 묻지 않는다. 전달 결과가 나중에 준비되는 작업은 접수와 답변 완료를 분리해 인계한다.

## 개인 보조파일 계획과 원 operation 인수 · source-only

기존 개인 참조 Markdown에는 personal-skill-plan-file → 원 status의 plan_sha256 → personal-skill-update-body + skill.planRequestId/planSHA256의 명시 결속을 추가했다. 같은 owner binding/workspace/실제 identity·exact skill ID·경로·fresh body SHA·후보 원바이트 SHA·원 backupReceipt를 비교한다. 계획도 before/desired 실제 바이트의 두 목적지 VERIFIED가 필요하다. 원 ZIP 보존과 전체 ZIP 현재성은 별개다.

기존 provider operation record/result와 backup one-use operation을 재사용하며 별도 큐·원장을 만들지 않는다. UNKNOWN은 원 apply request_id로만 status를 조회하고 file_target의 원 계획/대상 정보를 회수한다. 이것이 원 Save 재호출이나 자동 retry를 허용하지 않는다.

새 파일 추가/전체 ZIP 교체를 지원하는 공식 same-ID surface는 아직 확보되지 않았다. 기존 reference 편집을 그 기능으로 표시하지 않는다. source 작성과 실제 runtime capability 광고/owner allowlist·홈 안내·plugin release는 별도이며 이번 변경은 검증 미실행·미배포다.

## 고정 manager owner-binding의 설치 전 산출물

source-read/plan-file 요청이 source에 준비됐어도 설치된 manager allowlist와 같다고 표시하지 않는다. owner-local 준비가 필요하면 기존 제품 경로의 `tools/platform/workspace-mcp/Prepare-AiccWebManagementBinding.ps1`과 [설치 전 계약](../../../../docs/runbooks/workspace-web-management.md#source-readplan-file의-설치-전-owner-binding-준비)을 따른다. 기존 binding·manager 후보의 exact SHA, identity·operationDirectory·거절 목록을 보존한 초안만 만든다. `DRAFT_NOT_INSTALLABLE`은 정상 등록 후보가 아니며 runtime closure/백업/READY/CAS/정상 종료/설치·게시 수용을 대신하지 않는다. 원불명 Source 다운로드와 같은 ID의 신규 보조파일 추가 미지원도 그대로다. 설치되지 않은 action을 일반 Chat에서 시험하거나 offline 브라우저를 준비기의 일부로 기동하지 않는다.

## 설치와 버전 흐름

1. 변경 전에 exact 스킬 폴더와 필요한 참조만 파악한다. 패키지는 비밀·원문 대화·capability·개인 설정을 제외하고 단일 스킬 폴더, 파일 manifest와 ZIP SHA-256으로 고정한다. 현재 manager의 지원 파일·용량 제한을 따른다.
2. 최신 private coordination 등록으로 대상 슬롯을 찾고 실제 로그인 account/workspace/관리 권한을 확인한다. 과거 포트 역할, 계정 순서나 요금제 표시를 identity로 쓰지 않는다. pending/disabled/reserved 또는 identity unknown이면 HOLD한다.
3. 기존 source-backed manager의 로컬 plan은 원격 조회·설치·호출 증거가 아니다. 원격 확인이나 업로드는 해당 동작의 승인과 현재 정책이 허용하는 시점에만 task-owned CDP lease와 공식 UI로 수행한다.
4. 이름은 탐색 단서다. owner/workspace/불변 ID와 관찰한 버전·날짜·release receipt로 current/stale/duplicate/retired/unknown을 판단한다. 이름만 같다고 skip 또는 overwrite하지 않는다. 로컬 hash나 이름의 존재만으로 원격 ZIP의 바이트 일치를 증명하지 않는다.
5. 신규 등록은 원격 부재와 이전 uncertain/pending upload가 없음을 확인한 뒤 승인된 버전 ZIP을 1회 제출한다. intent를 먼저 남긴다. 응답이 불확실하면 exact 이전 receipt를 조정하며 재전송하지 않는다.
6. 기존 항목 업데이트·폐기는 exact 불변 ID, 현재 승인, preimage·backup·rollback, 참조 관계와 영향 범위 및 공식 UI 지원을 갖춘 뒤 수행한다. 폐기는 참조가 0임을 확인한다. 같은 이름의 다른 owner 자산과 공용 AICC 연결을 보호한다. ID/버전을 얻을 수 없으면 HOLD한다.
7. 원격 등록, 사용자 설치, 일반 Chat의 지피티 스킬 로드 신호와 완료 응답을 따로 기록한다. 플랫폼이 실제 사용자 설치를 요구하면 해당 한 단계만 알린다. invocation 0회만으로 미사용·폐기를 판정하지 않는다.


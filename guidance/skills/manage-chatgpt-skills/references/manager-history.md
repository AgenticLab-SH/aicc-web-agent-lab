# 과거 관측 보관

아래는 분리 당시 원문이다. 현재 절차·명령·계정·권한·검증 순서로 재사용하지 않는다. 현재 계약은 manager-contract.md이며 이 파일은 관련 장애 근거가 필요할 때만 읽는다.

---

# 지피티 스킬 관리 구현 계약

기존 private Codex–ChatGPT Web manager를 재사용한다. 특정 과거 branch나 설치 경로를 현재 정본으로 고정하지 않는다. source 소유자가 제공한 등록 위치와 현재 지원 인수만 사용하며 이 공개 저장소에 개인 경로·계정 별칭·workspace ID를 넣지 않는다.

스킬과 플러그인 관리에는 기존 코드 자동화를 우선한다. CUA나 일반 Chrome 확장의 수작업 설치를 별도 배포 경로로 만들지 않는다. 기존 manager가 필요한 기능을 지원하지 않으면 그 기능만 구현 준비 또는 HOLD로 남긴다. 지침 작성·홈 배포·ZIP 준비·원격 적용·실제 호출을 각각 기록한다.

기존 구성요소:
- 과거 scripts/chatgpt-skill-bundle.mjs와 scripts/chatgpt-native-skill-manager.mjs는 현재 private checkout에서 발견되지 않았다. 이 이름을 현재 실행 명령으로 쓰지 않는다. 기존 source skill 폴더의 참조를 포함해 ZIP을 준비하며 준비는 원격 적용 증거가 아니다.
- guidance/skills/manage-chatgpt-personal-skills/scripts/personal-skill-manager.cjs: 현재 개인 owner-created 목록·inspect·단회 업로드·Markdown 수정·exact 삭제. 호출자는 기존 owner config와 Playwright 모듈을 명시하고 PowerShell은 등록 입력 또는 PATH로 해석한다. 개인 명령을 workspace 삭제로 확대하지 않는다.
- scripts/chatgpt-workspace-skill-sync.mjs: 등록된 task-owned CDP lease와 관리자 Skills UI의 1회 업로드.
- scripts/chatgpt-skill-upload-package.mjs: Markdown 또는 ZIP 내부의 유일한 SKILL.md에서 slug·패키지 SHA를 읽는다. ZIP 경로·확장 해제 크기·본문 중복을 거부하며 참조파일을 포함한 실제 패키지를 사용한다.
- docs/chatgpt-native-skills-sync.md: 해당 manager의 운영 자료.

이 목록은 실행 권한이나 현재 배포 상태의 증거가 아니다. 해당 구현을 필요한 부분만 먼저 읽는다. 지원하지 않는 업데이트·ID 조회·비활성 슬롯 인수를 추측해 호출하지 않는다. PowerShell 실행 파일 override가 필요하면 실제 확인한 절대 PowerShell 경로를 해당 호출에만 적용하며 전역 설정을 변경하지 않는다.

2026-10-16 ZIP 입력을 허용하고도 이름을 읽지 못하던 결함을 수정하고 관련 회귀시험 4개를 통과했다. 과거 원격 파일 불러오기 실패와 인과가 증명된 것은 아니다. 등록 CDP offline preflight는 업로드 전에 중단됐다. 정확한 등록 세션이 돌아오면 원래 원격 항목·불명 업로드부터 조정하고, 같은 이름을 버전 일치로 처리하거나 다른 계정·브라우저로 자동 우회하지 않는다.

## 로컬 reader 계약

실제 이름은 open-AICC의 components/workspace-mcp/tool-manifest.mjs와 input-schemas.mjs에서 확인한다.
- aicc_skill_inventory/aicc_skill_read: workspace_id와 lease 필요. inventory의 id를 skill_id로 전달하며 SKILL.md 전체부터 읽는다. 서버에 등록된 skillRoots만 대상이다.
- aicc_workspace_list, aicc_workspace_open, aicc_workspace_info, aicc_workspace_search, aicc_workspace_read, aicc_workspace_read_many, aicc_workspace_close: 등록 workspace의 상대 경로 읽기. read_many 최대 20개. 파일 reader에 local-source와 같은 redaction이 있다고 가정하지 않는다.
- aicc_local_source_open_read, aicc_local_source_list, aicc_local_source_search, aicc_local_source_read, aicc_local_source_close: 로컬 UI가 발급한 exact-root grant_ref, correlation_id와 반환된 source_id/read_capability로 승인된 범위만 읽는다. 텍스트는 bounded/redacted, binary/archive/database는 metadata-only다.
- aicc_codex_session_search, aicc_codex_session_info: codex-sessions 전용 grant의 메타데이터.
- aicc_codex_session_read_excerpt: 별도 1회 approval_ref가 exact source/session UUID/correlation/TTL/줄·turn·bytes에 결합된다. prompt/tool/command output과 비밀은 가리고 assistant text도 별도 허용이 필요하다. 원문 JSONL 공유 기능이 아니다.

reader 세부 절차는 기존 aicc-workspace-operator를 사용한다. 도구 미노출·grant 부족은 HOLD이며 웹 컨테이너를 Windows로 취급하거나 파일 직접 읽기로 우회하지 않는다.

## 원격 상태와 버전

- plan: 로컬 준비만 의미하며 원격 자산 존재·설치·호출을 주장하지 않는다.
- verify: 실제 관리 UI 조회가 승인되고 정책이 허용할 때만 실행한다. 이름만 보이고 원격 버전 근거가 없으면 HOLD_EXISTING_UNKNOWN_VERSION.
- apply: 신규 이름 부재와 이전 attempt 없음이 확인된 승인 범위에서 1회 제출한다. 먼저 attempt를 보존한다. 응답 불명은 HOLD_UNCERTAIN_UPLOAD이며 재전송하지 않는다.
- 이후 이름이 보이는 상태는 REMOTE_ADMIN_VISIBLE일 뿐 원격 bytes 일치, USER_INSTALLED 또는 SKILL_INVOKED가 아니다.

불변 ID, owner/workspace와 버전 증거가 없으면 이름만으로 skip·갱신·삭제하지 않는다. 구형 sync가 name-only skip만 지원하면 그 기능의 한계를 보고하고 업데이트를 HOLD한다. 로컬 hash는 remote bytes의 증거가 아니다.

Business 공용 연결을 계정별 복제하거나 Personal 연결을 필수화하지 않는다. 일반 Chat에서 plugin-based 읽기와 지피티 스킬 로드 신호를 구분한다. 실제 UI에 없는 기능이나 Work 전환으로 호출을 증명하지 않는다.

검증은 공통 지침과 사용자 요청 범위를 따르며 모델 이름만으로 생략하지 않는다. 패키지 검사·원격 적용·최종 실제 사용점검은 각각 미실행 상태를 유지할 수 있다. token 파일, browser profile, 무관한 대화와 전체 Codex 홈을 기본 탐색하지 않는다.

## 관리자 목록의 로딩과 페이지 경계

실제 관리자 화면은 처음에 표 머리글만 반환하고 나중에 3페이지 목록을 표시했다. 페이지 번호와 행 갱신도 동시에 끝나지 않았다. 기존 manager에 로딩 완료 대기, 소유 탭 안의 페이지 버튼 스크롤, 번호·항목 집합 전이 대기와 모든 페이지의 exact 이름 수집을 추가했다. 보완 뒤 실제 3페이지·54개 항목 조회가 성공했다. 불명 페이지·목록 변경·전환 실패는 업로드 전에 멈춘다. 같은 이름만 보이는 항목의 버전은 계속 HOLD_EXISTING_UNKNOWN_VERSION이다.

commit은 기존 owner-only 폴더를 가리키는 `--attempt-dir`와 패키지1개가 필요하다. workspace/account/스킬 이름에 결속한 영속 영수증을 전송 전에 만들고 기존 영수증이 있으면 재전송하지 않는다. 관측한 HTTP 응답은 UI 완료 대기 전에 HTTP_RESPONSE_OBSERVED_PENDING_UI로 보존하고 완료 화면까지 확인된 경우만 ACK_UPLOAD_UI_SUCCESS_PENDING_ID로 기록한다. 원격 ID와 실제 호출은 별도다. HTTP 거절·응답 불명·후속 읽기 실패는 기존 영수증을 조정하기 전 재전송하지 않는다. 다른 버전·경로·계정으로 영수증을 우회하지 않는다.

별도 Playwright handshake 실패와 이후 Chrome endpoint 소실의 원인은 미확정이다. 사용자 재시도 지시 후 같은 등록 프로필 연결을 복구하고 이전 exact 소유 대상의 공식 반환을 완료했다. 새 프로필·계정 전환·로그인 초기화는 없었다. 스킬 원격 적용·실제 호출과 프로젝트 생성은 각 작업 영수증의 현재 결과를 따른다.
신규 업로드의 실제 응답 경로는 /backend-api/hazelnuts/uploads/create였고 이름은 나중에 표시명으로 바뀔 수 있었다. 응답·완료 화면이 불명이어도 같은 항목을 다시 올리지 않는다. 기존 owner 목록과 editor의 불변 ID·slug·논리 본문을 읽어 조정한다. UI 정규화한 경계 개행을 제외한 본문 일치는 참조 파일 전체나 사용자별 스킬 호출의 증거가 아니다.

## 48개 후보 대조와 공용·개인 경계

현재 private checkout에는 위 과거 스킬 관리기와 bundle 문서가 없을 수 있다. 실제 파일이 없으면 과거 명령을 실행하거나 새 명령을 추측하지 않는다. 현재 존재하는 workspace-skill-sync.mjs, skill-upload-package.mjs와 개인 스킬의 companion manager만 해당 지원 범위에서 사용한다.

기존 ZIP 판독 모듈의 reconcileSkillCandidates는 원본 대응표·후보 해시·완전한 공용 이름 목록·직접 소유한 ID/본문 관측·기존 attempt를 입력받아 읽기 전용 변경 계획을 만든다. 한 후보로 합칠 여러 다른 source 이름과 같은 이름의 여러 원격 행을 구분한다. 동명 중복은 HOLD_AMBIGUOUS_REMOTE_NAME이며 visibleInBody=true로 단일 항목이나 동일 버전으로 취급하지 않는다. 이름이 하나라도 원격 전체 파일·owner/version이 없으면 HOLD_EXISTING_UNKNOWN_VERSION이다.

개인 화면의 설치됨·내가 만든 항목과 관리자 목록은 다른 관측이다. 직접 소유한 본문SHA를 회수해도 공용 자산 전체 교체 권한이나 참조파일 버전의 증명이 아니다. 4개 개명·3개 기능 이관 제안도 원본 slug와 ID를 보존한 변경 계획이며 신규 이름으로 우회 업로드하지 않는다. 이미 통과한 ZIP 검사는 반복하지 않고 최신 정본 대비 바뀐 본문·참조만 대조한다. 원본53개와 후보48개는 보존한다.

## 전체 ZIP 내보내기와 기존 파일 갱신

private workspace-skill-sync의 exportWorkspaceSkillPage는 exact 관리자 URL·현재 페이지 이름 집합을 대조한 뒤 기존 상세 창의 다운로드 동작을 사용한다. UI가 실제 요청한 hazelnut 경로에서 불변 ID를 결속하고, 화면 소유자 표시는 opaque owner ID와 구분한다. 파일 버전은 내려받은 ZIP SHA와 전체 파일 목록으로 기록한다. signed URL과 인증정보는 기록하지 않는다. 페이지마다 영속 보존하고 이미 확보한 exact ID를 중복 다운로드하지 않는다.

0바이트 다운로드와 failure=null은 정상 ZIP 또는 빈 스킬의 증거가 아니다. 상세 본문·파일 트리·ID·소유자 표시는 회수할 수 있어도 전체 preimage와 버전은 미확인으로 남긴다. 관리자 메뉴에 편집이 없으면 소유권 변경·삭제·재업로드로 갱신 경로를 대신 만들지 않는다. 동명 복수 행의 exact ID와 서로 다른 소유자 표시를 보존한다.

직접 소유한 editor는 기존 SKILL 본문과 기존 references Markdown을 exact ID·파일 경로·fresh 논리 본문 SHA로 갱신할 수 있다. 전체 ZIP preimage와 파일별 시도를 먼저 보존하고 저장 후 같은 파일의 논리 본문을 대조한다. 저장한 파일의 결과는 원격 패키지 전체 최신 일치나 일반 Chat의 독립 스킬 호출 증거가 아니다. 저장 전 preimage 충돌은 무변경 거절로 기록하고 원문 차이를 회수한다. 응답 불명은 재전송하지 않는다.
## 승인된 기존 공용 ID의 편집

관리자 목록에서 보존한 exact ID를 공식 `/skills/editor/<ID>` 화면으로 열 수 있으면 개인 목록에 없다는 이유만으로 편집 미지원이라고 단정하지 않는다. 편집기 표시와 저장 성공은 별도다. 기존 companion manager의 `inspect` 또는 `update-body`에만 `--editor-binding`과 `--identity-module`을 명시해 이 경로를 사용할 수 있다. 기본 개인 경로의 내가 만든 항목 제한은 유지한다.

binding은 schemaVersion=1, policy=EXISTING_WORKSPACE_EDITOR_ONLY와 등록 accountAlias, resourceId, 원본 name, ownerLabel, packagePreimage 절대 경로·packageSHA256, expectedIdentityHash·expectedWorkspaceHash를 포함한다. 실제 로그인과 workspace를 이동 전후 대조하고 보존한 ZIP을 결속한다. 공개 지침에 실제 신원값·비밀을 넣지 않는다. 현재 본문 SHA는 매번 별도로 읽는다. 기존 ID/slug·편집 가능한 본문·fresh SHA가 모두 맞을 때 승인된 누락 절만 추가한다. 권한 거절·429·불명 저장은 HOLD이며 계정 변경·소유권 변경·삭제·재업로드로 대신하지 않는다. 이 선택 경로는 전체 ZIP 교체나 관리자 권한 확대를 지원하지 않는다.

## 승인된 전체 교체의 적용 순서

지피티=ChatGPT Web 일반 Chat, 코덱스=로컬 Codex CLI와 Desktop. manager slug·ID·attempt는 용어 정리로 바꾸지 않는다. 전체 재등록 승인도 관리자 소유자 표시를 현재 소유권 근거로 바꾸지 않는다. fresh owner/workspace·ID·관측 버전/전체 ZIP SHA·설치·파일별 참조·preimage/rollback을 대상별로 결속한다. 현재 list/inspect/export로 채울 수 있는 근거를 먼저 확보하고 타인/공용/소유 불명·불명 전송만 해당 항목 단위로 분리한다.

의존 참조를 새 정본으로 이관한 뒤 지원 manager의 exact 삭제·단회 등록을 처리한다. 삭제 뒤 새 ID·설치를 별도 이관하며 옛 ID/공유 링크의 정확한 복원을 보장하지 않는다. 원본/현재 소유/지원 삭제·등록을 확보하지 못한 대상은 삭제하지 않는다. Chrome 확장 수작업 설치·다른 계정/route로 대신하지 않는다.

원격 global/custom/project 지침은 기존 자산 manager의 exact 사용자 소유·preimage·지원 저장 계약을 따른다. SCREEN과 제외 프로젝트는 내용 읽기부터 제외한다. 공통 지침으로 프로젝트 고유 목적·자료·접근권한을 지우지 않는다. 등록·설치·호출과 source/home 반영을 분리한다.

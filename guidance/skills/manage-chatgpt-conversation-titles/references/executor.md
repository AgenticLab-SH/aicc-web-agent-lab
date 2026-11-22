# 기존 private adapter 실행 계약

기존 AICC에 소유자 결속 `aicc_web_management_start/status`가 실제 노출돼 있으면 `title-inventory/read/rename`으로 같은 adapter를 사용한다. 입력은 schemaVersion1/action/title이며 title 객체에 아래 동작별 필드와 explicitUserRequest를 넣는다. 계정·신원·호스트 설정·실행 경로·journal은 호스트가 고정한다. rename은 commit:true와 실제 양쪽 백업 receipt를 결속하며 제목 전후 바이트만 백업하고 대화 본문은 올리지 않는다. JSON과 SHA를 등록 workspace에 고정하고 고유 request ID로 한 번 start한 뒤 같은 status를 회수한다. 이 명명된 도구가 없는 환경에서는 아래 직접 실행 계약을 따른다.

inventory의 conversationIds는 1..20개를 중복 제거해 해당 대화만 조회한다. ID가 없는 제목·날짜 검색은 요청 예산이 있는 계정 조회이며 exhaustive=false인 결과를 전체 목록이라고 하지 않는다. HTTP429의 안전한 경로·Retry-After 초와 자동 재요청 없음 상태를 보존한다. 조회 429를 터널 재시작·계정 전환으로 처리하지 않는다.

현재 등록된 private adapter root의 `scripts/chatgpt-conversation-titles.mjs --request ABS_JSON --result ABS_JSON`를 **Node**로 호출한다. AICC는 열린 등록 workspace의 명령 capability를 먼저 확인한다. 명령 격리·등록 runtime 경로는 보존하며 런타임이 보이지 않으면 AppContainer 밖 실행으로 바꾸지 않는다.

공통 입력: schemaVersion=1, explicitUserRequest(실제 요청 요약), config(기존 archive config의 절대 경로), account(기존 enabled alias), identityHash, workspaceIdentityHash, action.

- inventory: filters={createdFrom?,createdThrough?,updatedFrom?,updatedThrough?,titleContains?,conversationIds?}. YYYY-MM-DD는 KST 일 경계다. created와 updated 범위를 섞지 않는다. 하나 이상의 명시 selector를 요구한다. 기존 인증된 inventory를 재사용하며 모든 페이지 여부와 오류를 보고한다.
- read: conversationId, outputDirectory. 기존 importer로 정확한 대화를 읽기 전용 저장한다. 반환 manifest와 conversation.md를 실제로 읽은 뒤 제목을 정한다. 첨부 실패나 일부 문맥은 감추지 않는다.
- rename: conversationId, expectedTitle, desiredTitle, commit=true, journalPath(새 절대 파일), contentEvidence={method:"native-current-chat"|"local-import",conversationId,readScope,sourcePath?,sha256?}. local-import는 실제 conversation.md의 hash가 필요하며 현재 대화 문맥은 읽은 범위를 기록한다. 지피티 대화의 응답/읽기 기록을 근거로 작성하고 메타데이터만으로 본문을 읽었다고 하지 않는다.

같은 대화에 재시도하지 않는다. journal이 있으면 exact 원결과/현재 제목부터 읽어 조정한다. Codex가 실행한 결과를 Web 직접 실행이라고 보고하지 않는다. 기간/제목 조건만으로 일괄 개명하지 않으며 선택된 각 대화의 내용을 읽은 후 exact ID별 rename 입력을 만든다.

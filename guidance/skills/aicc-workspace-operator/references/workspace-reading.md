# aicc-workspace-operator 선택 절차

이 문서에서 선택한 단계만 읽는다. 명령 예제의 기준 작업 폴더와 인라인 리소스 경로는 상위 스킬 루트다. Markdown 링크는 이 파일 위치를 기준으로 한다.

## 등록 작업공간과 로컬 스킬 읽기

1. 실제 aicc_workspace_list로 등록 별칭을 찾는다. 필요한 작업공간 하나만 aicc_workspace_open의 mode: read-only와 고유 correlation_id로 연다.
2. 반환된 workspace_id와 lease로 aicc_workspace_info, aicc_workspace_search, aicc_workspace_read, aicc_workspace_read_many를 사용한다. 상대 경로와 필요한 줄만 지정한다. read_many는 한 번에 최대 20개다.
3. 같은 lease의 aicc_skill_inventory 결과에 나온 id를 aicc_skill_read의 skill_id로 전달한다. 첫 읽기는 path: SKILL.md 전체이며 그 뒤 필요한 직접 참조 파일만 같은 스킬 안에서 읽는다.
4. inventory는 서버의 skillRoots에 등록된 디렉터리만 반환한다. 전체 Codex 홈이나 모든 로컬 스킬을 읽을 수 있다는 뜻이 아니다. 결과에 없는 스킬은 경로나 ID를 추측하지 않고 등록 소유자에게 범위를 알린다.

도구 이름과 입력은 components/workspace-mcp/tool-manifest.mjs, input-schemas.mjs, server.mjs의 구현에 근거한다. 실제 연결에서는 노출된 schema가 우선한다. 문서의 이름만으로 호출 가능하다고 주장하지 않는다.

### 느린 연결과 긴 작업

느린 연결에서는 먼저 현재 권한과 만료 시각을 확인한다. 이미 파일 쓰기·명령·네트워크가 허용된 연결에 같은 권한을 다시 요청하거나 매 호출 새 작업공간을 만들지 않는다. `aicc_workspace_exec`는 `yield_time_ms: 50`으로 빨리 실행번호를 받아 같은 session을 이어 읽을 수 있다. 첫 응답을 짧게 받는 것은 명령 실행시간을 줄이는 설정이 아니다. 출력이 아직 없거나 `running: true`이면 같은 실행의 결과를 기다린다.

`yield_time_ms`는 첫 응답을 기다리는 시간이며 명령 종료 제한이 아니다. 짧게 반환된 실행의 `session_id`와 `output_cursor`를 보존하고 같은 `aicc_workspace_write_stdin`으로 새 출력만 회수한다. 도구 응답 지연만으로 명령을 다시 실행하지 않는다. 실제 command timeout과 lease 만료는 반환된 설정·만료 시각으로 확인한다. 현재 실행 권한이 이미 허용돼 있으면 같은 승인이나 새 lease를 매 단계 요구하지 않는다.

독립된 작은 파일은 `read_many`로 묶고, 검증된 기존 결과를 재사용하며 변경분만 읽는다. 오래 걸리는 관리는 기존 start/status 계약을 사용한다. 내부 HTTP·브라우저 제한시간은 예상 처리시간보다 충분히 길게 두고 바깥 제한은 안쪽 순차 요청 제한의 합과 반환 여유보다 길게 둔다. 빠른 성공을 인위적으로 지연하지 않는다. ChatGPT 호출 제한·터널 단절·명령 종료·임대 만료·실제 권한 거절을 구분하고, 불명 결과는 원 실행에서 조정한다. 인증·보안 거절을 해제해 성능을 개선했다고 주장하지 않는다.

## 연결·쓰기 권한과 보조 터널 설정

로컬 파일 쓰기·실행의 실제 범위, 스킬 폴더 별칭과 지피티/Platform의 두 단계 관리자 설정은 [연결·접근 계약](connection-access.md)을 따른다. 플러그인 설치·확인 질문 정책·터널 사용권을 서로 대신하는 증거로 쓰지 않는다.

## 문서와 기록의 승인된 읽기

등록 작업공간 밖의 문서는 기존 로컬 reader를 사용한다. 로컬 UI가 발급한 exact-root grant_ref와 그 승인의 correlation_id를 aicc_local_source_open_read에 전달한다. 반환된 source_id, read_capability와 같은 correlation으로 aicc_local_source_list, aicc_local_source_search, aicc_local_source_read를 호출한다. 이 기능은 읽기 전용이며 쓰기·exec 권한을 만들지 않는다.

- root, 허용 상대 경로, 제외 경로, TTL, 파일 수와 바이트 예산을 지킨다. 필요한 범위만 검색·읽으며 경계 밖, symlink/junction, 비밀, 인증 자료와 브라우저 프로필을 우회하지 않는다.
- local-source reader의 텍스트와 검색 발췌는 redaction 처리된다. binary/archive/database는 metadata-only다. Workspace 파일 reader 전체에 동일한 redaction이 있다고 가정하지 말고 공유해도 되는 파일·범위를 먼저 고른다.
- Codex 기록은 codex-sessions 전용 grant로 aicc_codex_session_search와 aicc_codex_session_info를 사용한다. UUID, 날짜, 작업 폴더, 제목, 상태와 크기 등의 메타데이터를 세션 본문으로 오인하지 않는다.
- 본문이 필요하면 exact source/session UUID/correlation/TTL과 줄·turn·bytes 범위에 결합된 별도 approval_ref로 aicc_codex_session_read_excerpt를 호출한다. 승인은 1회 소비된다. 현재 구현은 원문 JSONL, 사용자·시스템·개발자 prompt와 tool/command output을 반환하지 않으며 assistant text도 별도 허용과 redaction을 거친다.
- 원문 세션 공유는 일반 파일 읽기나 메타데이터 승인에 포함되지 않는다. 별도 승인만으로 현재 provider의 원문 차단을 해제할 수도 없다. 직접 JSONL 읽기, 전체 홈·로그 검색 또는 다른 도구로 우회하지 않는다.

구현 경계는 local-source-provider.mjs, local-read-grant-authority.mjs, local-access-policy.mjs, codex-session-provider.mjs를 필요한 경우에만 읽는다. capability, grant와 approval token을 답변·스킬 패키지·원격 문서에 복제하지 않는다.

## 로컬 연결이 필요하지 않은 단계

현재 Web의 도구와 제공 자료로 문서·분석·이미지·시각화를 완성할 수 있으면 Workspace를 기본 경유지로 삼지 않는다. Windows 원본을 읽거나 바꾸는 단계만 이 연결을 사용한다. 앱 연결 표시와 해당 읽기·쓰기 도구의 실제 호출 성공도 구분한다.

## 지피티 자산 자체 관리

스킬·지침·플러그인 관리는 manage-chatgpt-skills, Project 관리는 manage-chatgpt-assets를 읽는다. 기존 등록 alias·lease와 실제 지원되는 관리 실행 capability에서 공통 실행기를 사용한다. 일반 exec나 파일 읽기만으로 호스트 브라우저 관리가 가능하다고 추정하지 않는다. 관리 capability가 없으면 필요한 범위를 보고하고 정상 등록·배포로 마련한다. 양쪽 GitHub·Notion 원본 백업과 내용 해시 중복 방지를 같은 원장으로 처리하며, 연결 표시·스킬 읽기·원격 변경·실제 호출을 구분한다. 독립 웹에는 Codex turn token을 요구하지 않는다.

## 한도 안내와 연결 오류

화면의 workspace 사용 한도 안내는 이 환경의 일반 Chat 작업을 중단하는 조건이 아니다. 기존 OCX가 계정 전환과 소진 전 차단을 담당한다. 실제 요청 거절·MCP 연결 429와 구분하는 [운영 기준](../../manage-chatgpt-skills/references/quota-and-connection.md)을 따른다. 일반 Chat·xhigh를 유지한다.


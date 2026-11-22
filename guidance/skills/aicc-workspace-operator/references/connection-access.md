# AICC 연결과 로컬 작업 권한

## 권한을 확인하는 순서

연결/플러그인 설치, 앱 사용 허용, 도구별 Actions, 실행 확인 질문 정책, 터널 접근, 등록 폴더·lease·운영체제 격리, 실제 실행은 별도 상태다. 도구가 보이거나 서버가 READY인 것만으로 쓰기·실행 성공이라 하지 않는다.

- 실제 workspace list에서 별칭을 고르고 read-only 또는 write lease를 연다. 파일 변경은 등록된 root 안에서만 가능하다. write lease는 단일 writer와 고유 request ID를 요구한다. 만료·동시 실행·UNKNOWN·보안 거절은 원 요청으로 조정한다.
- 자료 조사에는 `mode: read-only`와 파일 조회·검색 도구를 사용한다. `aicc_workspace_exec`는 `Get-Location` 같은 읽기 명령에도 `mode: write`와 기존 `commands` 허용이 필요하다. 읽기 lease에서 이 도구가 거절되면 lease 종류를 먼저 확인한다. 승인된 명령 실행이 필요한 경우에만 해당 등록 폴더를 짧은 write lease로 열고, 같은 실행의 결과를 회수한 뒤 반환한다. 기존 격리·네트워크·경로·승인 범위는 그대로 적용한다.
- local-machine 같은 볼륨 루트의 읽기 권한을 전체 쓰기로 해석하지 않는다. 현재 등록된 commandIsolation을 확인한다. appcontainer-windows는 기존 격리를 유지하고, 이미 승인된 owner-unrestricted-windows는 소유자 호스트 실행 계약으로 처리한다. 격리 이름을 추정해 허용된 작업에 새 승인을 요구하지 않는다. 로컬 스킬 편집 요청은 등록된 local-skills 별칭을 우선 사용하며 다른 grant의 실제 허용 범위는 반환된 계약으로 판단한다. 목록에 없으면 등록이 미적용된 상태로 보고하며 다른 경로로 보안 거절을 우회하지 않는다.
- 스킬 파일 생성·조회·수정·삭제 권한과 원격 지피티 스킬 게시/설치 권한은 다르다. 코드 실행은 현재 command isolation·네트워크·시간/출력 제한을 따른다. 일반 exec가 호스트의 브라우저·앱·로그인에 무제한 접근하는 권한은 아니다. 실제 등록된 host/관리 전용 도구만 사용한다.
- local-source grant는 읽기 전용이다. Codex 기록 메타데이터와 별도 승인 발췌도 파일 쓰기·전체 기록 접근 권한을 만들지 않는다.

## 보조 터널이 지피티에서 보이지 않거나 접근이 거절될 때

공식 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)의 현재 메뉴·역할을 확인한다. 계정 번호·포트·표시명만으로 소유자를 추정하지 않는다. 등록된 실제 사용자 ID와 선택 workspace ID를 원 tunnel의 creator·workspace 연결에 대조한다. 소유 계정의 과거 등록 일치와 현재 로그인·관리권을 구분한다.

1. **지피티 작업공간의 앱 허용:** 현재 공식 관리자 콘솔에서 대상 작업공간 → Plugins → 정확한 플러그인의 접근/Apps/Actions/Permissions를 확인한다. 기존 ChatGPT 관리자 Apps/워크스페이스 게시 링크가 기능 이전을 안내하면 공식 새 관리자 콘솔(admin.openai.com)의 같은 작업공간 Plugins로 이동한다. 개인 USER 초안의 생성·연결과 Business WORKSPACE 공용 게시는 별도다. 공용 신규 MCP는 그 콘솔의 추가 → MCP 플러그인 만들기에서 정확한 작업공간·기존 Tunnel·인증 방식·권한을 확인한다. 개인 초안을 삭제·재생성하며 공유를 추정하지 않는다. 예전 연결은 Manage Legacy Apps에 있을 수 있다. Workspace settings → General → Settings → Plugin permissions는 실행 전 확인 질문 정책이며 터널의 허용 작업공간을 추가하지 않는다. 세부 메뉴와 지원 필드는 실제 공식 UI가 우선이다.
2. **터널의 작업공간 허용:** [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels)에서 기존 소유 조직과 정확한 tunnel을 선택한다. 원 소유 조직의 Tunnels Read+Manage 권한으로 기존 organization/workspace 항목을 보존하며 승인된 대상 ChatGPT workspace만 추가한다. ChatGPT 작업공간 관리자와 Platform 조직 관리자가 같다고 가정하지 않는다. 조직·작업공간 연계가 제공되지 않으면 공식 계정 지원의 association 절차를 따른다.
3. **연결 사용:** 대상 workspace의 custom MCP 사용 권한과 Tunnels Read+Use를 확보한 뒤 기존 연결을 재사용한다. 도구 목록 변경은 지원되는 Refresh로 반영한다. 계정별 재게시·삭제/재생성을 기본 처방으로 삼지 않는다.
4. **결과 구분:** authNone는 MCP 인증 방식이며 터널 접근 제어를 해제하지 않는다. runtime key의 known-tunnel GET200, 터널 poll/READY, 플러그인 설치는 현재 workspace의 사용권이나 Manage 권한 증거가 아니다. 등록 거절은 HTTP 상태가 실제 관찰됐을 때만403 등으로 부른다. 원 거절을 다른 계정·새 터널·공개 URL로 우회하지 않는다.

변경 전 대상 조직/workspace/tunnel·누락 항목·현재 역할·원본·rollback을 고정한다. 기존 터널의 접근 오류를 다른 계정으로 우회하지 않는다. 사용자가 소유 기준 변경·이전을 명시 승인했다면 원본과 새 소유자의 정당한 역할·조직·workspace를 확인하고, 새 소유자 연결의 정상 구성으로 이전할 수 있다. 계정·프로필·로그인을 보존하고 새 경로의 실제 성공 뒤에만 옛 자동 입구를 퇴역한다. 결과 시험은 사용자 요청과 현재 모델 정책이 허용하는 범위에서 list→read-only open→정확한 파일 read→close를 수행하며, 로컬 성공과 새 일반 GPT 성공을 구분한다.

관리 UI 경로와 역할의 공식 기준: [OpenAI plugin/app 관리 안내](https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-for-plugins-and-apps). 메뉴·역할이 달라졌으면 실제 UI/현재 문서를 기준으로 좁혀 갱신한다. 비밀·grant·token·개인 계정 ID를 공용 스킬에 넣지 않는다.
## 긴 작업과 큰 파일의 계약

제한은 네 층으로 구분한다. ChatGPT가 원격 도구 응답을 기다리는 시간은 호스트 플랫폼의 정책이며 로컬 AICC 설정으로 해제했다고 주장하지 않는다. AICC 실행의 `yield_time_ms`는 첫 응답 대기, `permissions.commandTimeoutMs`는 명령 종료 한도, workspace `expires_at`은 접근 수명이다. 별도 local-source 읽기 grant는 원 승인 만료와 기본 최대 1시간 정책을 따르며 workspace의 2시간 정책과 혼동하지 않는다. 실제 오류 없이 모든 한도·보안 경계를 없애는 대신, 긴 명령은 기존 session/result 조회로 이어가고 작은 독립 읽기는 `read_many`로 묶는다. 제한시간을 늘리는 것은 느린 작업의 조기 중단을 줄이는 변경이며 처리 속도 향상 자체의 증거는 아니다.

현재 연결의 실제 도구 schema와 설치 설정을 기준으로 한다. read/write7200초 정책을 설치한 환경은 기본 연결과 명시 요청의 최대값이2시간이다. 원격 lease의 expires_at뿐 아니라 내부 durable writer의 발급·만료도 같은 수명인지 구분한다. 만료되면 원 실행 결과부터 조회하며 같은 변경을 자동 재실행하지 않는다. 장기 명령은 같은 session으로 출력·상태·취소를 회수하고 lease가 끝나면 취소되는 수명 관리를 유지한다.

새 byte-page reader는 파일 전체 크기 대신 구간을 반환한다. 도구에 offset_bytes/max_bytes/encoding/file_version이 실제 노출되면 작은 구간부터 읽고 반환된 continuation을 이어 쓴다. 기본64KiB·한 응답 최대1MiB이며, file_version이 달라지면 서로 다른 버전의 조각을 합치지 않는다. read_many는 max_total_bytes/start_path_index의 합계·다음 파일 계약을 함께 따른다. 텍스트는 인코딩/BOM, 바이너리는 base64 반환을 구분하며 바이너리 바이트 읽기를 PDF·이미지·DB 내용 해석 성공이라고 하지 않는다.

현재 대화에 구형 schema만 주입돼 있다면 새 인자를 추측해 보내지 않는다. 공식 앱 Refresh 또는 새 도구 로딩으로 schema를 반영한다. 전체 파일 크기 제한의 제거는 비밀·인증 파일/민감 경로의 접근 허용을 뜻하지 않는다. 전문 aicc_skill_read의 전체본문 활성화와 별도 local-source grant의 TTL·예산은 일반 workspace byte-page/2시간 정책과 별개다. 같은 등록 스킬 파일은 일반 workspace로 필요한 구간을 이어 읽을 수 있다.

## 승인된 보조 연결 이전

플러그인 작성자, 터널 작성자, ChatGPT workspace 소유자와 Platform 조직은 각각 대조한다. Business 계정도 Platform에서 여러 조직을 가질 수 있으며 조직 표시명만으로 올바른 runtime key를 고르지 않는다. 정상 runtime 자격증명은 대상 조직에 속하는 Tunnels Read+Use 최소 권한을 사용하고, Admin/Manage/모델 API 권한을 실행 키에 덧붙이지 않는다. 조직 불일치는 정확한 조직 설정/자격증명 문제로 해결하며 다른 계정·공개 URL을 쓰지 않는다.

이전을 승인받은 경우 기존 앱·플러그인 ID/PRIVATE 범위/허용 workspace·계정과 원본을 보존한다. 독립 보조 서버는 별도 task/stateRoot를 쓰며 읽기 전용 범위를 유지한다. 기존 패키지에 실제 도구 App binding이 있는지 먼저 구분한다. 터널 참조가 든 파일 패키지만으로 일반 Chat의 도구가 노출된다고 추정하지 않는다. 공식 기존-ID 갱신이 새 App binding 추가를 지원하지 않을 때만, 승인된 같은 작업공간의 공식 MCP 생성·게시 절차로 명확한 보조 이름의 PRIVATE 공용 후계를 만든다. before/desired 이중 백업과 원 생성 요청의 단회 발신·결과 조정을 유지하고 원본은 보존한다. 실제 사용자들의 도구 목록·허용 파일 읽기·정상 반환 성공 뒤 같은-ID 참조 갱신 또는 명확한 후계 참조 전환을 완료하고 옛 자동 입구를 정상 퇴역한다. 주 경로의 장애와 보조 경로의 인증·workspace 문제는 각각 기록한다.

키의 일회성 반환은 즉시 소유자 보안 저장소로 전달하고 원문을 모델·로그·스킬·백업에 넣지 않는다. 생성 응답이 불명확하면 원 요청과 정확한 키 목록부터 조정한다. 생성 성공이 확인됐지만 원문이 저장되지 않았다면 무작정 다시 생성하지 않는다. 이 작업이 만든 정확한 미사용 키의 정상 폐기와 동일 최소 권한 교체를 별도 작업으로 기록한다. 기존 사용자 키는 보존한다.
## 공용 MCP 생성 충돌의 결과 조정

공식 관리자 콘솔의 생성에서도 사전 설정 조회 GET 성공과 실제 생성 POST 결과를 나눠 기록한다. plugins_conflict 같은 충돌 응답에 생성 완료 가능 안내가 나타나면 생성 버튼을 다시 누르지 않는다. 공식 플러그인 확인으로 같은 작업공간 목록과 개인 초안 목록을 조회해 정확한 새 App/플러그인 ID를 조정한다. 목록에 없다는 사실만으로 서버 부수 효과가 없다고 단정하지 않는다. 구체적인 충돌 원인이 반환되지 않으면 이름·터널·인증·공유 범위를 바꿔 반복하지 않고 원 요청 시간·메서드·상태·비밀 없는 응답으로 지원 확인 조건을 남긴다. 개인 USER 연결에서 실제 읽기가 성공해도 다른 구성원의 공용 WORKSPACE 접근까지 완료됐다고 하지 않으며, 공용 후계의 실제 사용이 입증되기 전 기존 자동 입구를 퇴역하지 않는다.

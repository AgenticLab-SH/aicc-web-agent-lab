# aicc-workspace-operator 선택 절차

이 문서에서 선택한 단계만 읽는다. 명령 예제의 기준 작업 폴더와 인라인 리소스 경로는 상위 스킬 루트다. Markdown 링크는 이 파일 위치를 기준으로 한다.

## Codex·웹 대화 연결

Codex 안에서 Web GPT 모델을 사용할 때만 실제 발급된 turn token을 codex_bind_turn으로 교환해 현재 하네스 도구를 쓴다. 독립 ChatGPT Web에는 그 token이 없으며 만들거나 다른 대화에서 빌리지 않는다. 독립 웹은 지속 인증된 Workspace 도구를 사용한다. Codex 작업이 필요하면 실제 노출된 dispatcher로 정확한 thread와 작업 폴더를 연결한다. 주소 링크나 큐 등록만으로 전달됐다고 보고하지 않는다.

## Windows 호스트 실행과 격리 실행의 선택

로컬 접근은 기존 AICC Workspace를 우선한다. 등록된 좁은 작업공간의 lease와 실제 노출된 읽기·파일 편집·명령 capability를 사용한다. 원격 Web 컨테이너와 사용자 Windows, AICC 파일 reader와 격리된 exec 프로세스는 서로 다른 경계다. 일반 Chat에 Codex turn token이나 Work 전환을 요구하지 않는다.

AppContainer는 AICC가 띄운 명령 프로세스에 적용되는 Windows 권한 경계이며 PC 전체나 Codex 자체를 격리하는 설정이 아니다. 등록 폴더 파일 읽기 성공만으로 호스트 Node·브라우저 제어·AppData 쓰기 성공을 추정하지 않는다. node 명령을 찾지 못한 결과는 PATH/런타임 발견 문제와 권한 거절을 구분한다. AppData 전체의 write lease 거절은 특정 하위 runtime의 실행 거절과 동일한 증거가 아니다. 실제 거절을 다른 root·복사본·권한 완화로 우회하지 않는다.

RDC를 기본 실행 경로나 자동 fallback으로 지시하지 않는다. 브라우저 자산 관리가 필요한데 현재 AICC capability가 부족하면 실제로 없는 기능과 필요한 범위를 명시하고, 지원되는 관리 전용 실행 기능 또는 명시적으로 승인된 정상 권한 구성으로 해결한다. 무제한 Windows 실행 모드가 구현돼 있더라도 현재 격리 설정을 몰래 해제하거나 이미 거절된 작업을 재시도하는 수단으로 사용하지 않는다. 새 실행 권한의 범위·원본 설정·복귀 방법을 검토 가능하게 준비하고 필요한 정식 승인을 따른다.

Notion 백업의 바이트 대조/영수증 기록, Project 생성·수정·삭제, 호스트 도구 안전 검사는 별도 단계다. 백업 확인 명령이 거절되면 해당 호출·오류와 실제 수행 여부를 보존한다. 원인을 추정해 위험 명령으로 단정하거나 Notion 저장 실패로 바꾸지 않는다. 진행 중 session과 불명 변경은 같은 요청 ID의 결과부터 회수하며 재발신하지 않는다. 실제 결과와 사용자의 승인 범위를 따르고 [자산 관리 계약](../../manage-chatgpt-skills/references/asset-lifecycle.md)을 적용한다.

## 승인된 자산 관리 전용 도구

실제로 `aicc_web_management_start/status`가 노출되고 소유 설정이 결속된 환경에서는 해당 도구를 사용한다. 이는 계정·실행 파일·허용 동작이 고정된 관리 경로다. 일반 exec의 AppContainer를 해제하는 기능이 아니다. 등록 workspace에서 요청 JSON·정확 SHA·고유 request ID와 실제 양쪽 백업 영수증을 준비하고 start를 한 번 호출한 뒤 같은 status를 회수한다. 계정·호스트 경로·실행 코드는 원격 입력에 넣지 않는다. 제공되지 않은 동작을 추정하지 않는다.

등록 workspace의 `tools/platform/chatgpt/Prepare-WebManagementRequest.ps1`로 기존 catalog와 요청 파일을 결속한다. `project-source-read`는 다운로드가 있는 읽기라 반환된 `read-<요청 SHA 앞 40자>`를 원 operation ID로 유지한다. `personal-skill-plan-file`은 원 백업과 기존 파일의 full SHA를 결속하는 읽기 계획이며, 그 status의 `plan_sha256`과 원 plan request ID를 같은 파일의 `personal-skill-update-body`에 전달한다. 시작 전 실패, `DISPATCHING`, 원격 거절, 결과 불명은 서로 다른 상태다. 시작된 요청은 같은 ID의 status로 조정하며 새 ID로 재생하지 않는다.

개인 스킬은 list/inspect/upload/update/update-body/delete, 제목은 명시 요청의 inventory/read/rename을 지원하는 배포가 있다. Project·개인 지침·플러그인 삭제는 같은 이름 붙은 관리 경로의 실제 action 허용 범위를 따른다. 원래 보안 거절 대상·hash는 이 경로에서도 차단된다. UNKNOWN이면 원 요청과 실제 결과를 조정하고 새 ID로 같은 변경을 반복하지 않는다.

## 요청한 생성 파일을 Notion에 저장

사용자가 생성 파일을 Notion에 넣으라고 요청했을 때 [파일 전달 절차](notion-file-transfer.md)를 읽는다. 웹 생성 컨테이너와 Windows를 구분하고, 실제 파일 회수 → 기존 AICC의 로컬 업로드 → 공식 Notion 첨부를 이어간다. 일반 Chat·xhigh와 기존 연결을 유지한다. 생성만 요청했다면 자동으로 Notion에 올리지 않는다. 같은 목적지와 SHA256의 파일은 기존 업로드·첨부를 재사용한다. 단회 티켓을 로그·백업·답변에 넣지 않는다.

Notion에 쓰기 전 [공통 목적지 원칙](notion-file-transfer.md#notion-목적지-원칙--공통-정본)을 따른다. 목적지 미지정은 HOLD이며 draft/root/parent 생략 최상위 자동 생성은 금지한다. 해당 작업의 명시적 최상위 생성 요청만 예외다.

## Native·OCX Codex CLI에 독립 업무 맡기기

Desktop 연결·Windows 터미널 명령·일반 Chat의 Workspace 도구는 별개다. 일반 exec의
AiccWorkspace 드라이브에서 호스트 aicc 실행을 가정하지 않는다. 실제 전용
`aicc_codex_cli_start/status`가 노출되고 owner binding이 승인된 환경에서만 등록 Git root의
write lease, route(native/ocx), model, reasoning_effort, UTF-8 prompt 파일/SHA와 지속할
operation_id를 전달한다. request_id는 각 도구 호출의 replay 방지용이며 operation_id와 다르다.
같은 operation_id로 상태·세션·turn.started·turn.completed·최종 결과를 회수한다.
DISPATCHING/ready/PID만으로 작업 접수·완료를 주장하지 않는다. 불명 결과·보안 거절은
새 ID·다른 경로로 재전송하지 않는다. 도구가 없으면 연결 담당에게 등록/게시 누락을 보고한다.
일반 exec 격리 해제·Native 자동 fallback·Codex turn token 대여를 해결책으로 쓰지 않는다.
상세 계약은 AICC 정본 `docs/runbooks/workspace-codex-cli.md`를 따른다. 소스 작성과 실제 도구
등록·설치·사용은 별도다.


# manage-codex-model-routes 선택 절차

이 문서에서 선택한 단계만 읽는다. 명령 예제의 기준 작업 폴더와 인라인 리소스 경로는 상위 스킬 루트다. Markdown 링크는 이 파일 위치를 기준으로 한다.

## Windows Kiro 대화 시작·재개 (사용자 선택 경로)
사용자가 사용 종료한 Kiro는 과거 resources 등록이나 인계 기록만으로 다시 선택하지 않는다. owner-local 사용 종료 표지가 있으면 아래 실행·재개·지시 등록·깨우기는 부작용 전에 `RETIRED_BY_USER`로 끝난다. 표지는 새 명시적 재사용 지시 없이 삭제하거나 우회하지 않는다. 스킬 배포·resources 등록을 현재 연결이나 실제 실행으로 보고하지 않는다.

Kiro 로컬 요청에는 [일반 PowerShell 실행기](../scripts/Open-KiroSession.ps1)를 사용한다. Codex unified_exec tty로 Kiro TUI를 열지 않는다. Store PowerShell 실행 별칭은 PTY CreateProcessW 오류5를 낼 수 있으므로 현재 PowerShell 프로세스의 실제 이미지로 일반 창을 연다. 명시적 보안 거절은 이 절차로 우회하지 않는다.

- 사용자 요청의 작업 폴더·agent·모델·effort·프롬프트 파일을 지정한다. `kiro`는 IDE일 수 있으므로 설치된 터미널 `kiro-cli.exe`를 명시한다.
- 새 대화: `Open-KiroSession.ps1 -WorkingDirectory '<root>' -Agent '<agent>' -PromptFile '<prompt.md>'`. 승인된 자율 작업에 trust-all-tools/trust-workspace를 적용한다. OS/조직/사용자 deny와 작업 범위는 유지한다.
- 기존 대화: 같은 인수 폴더와 agent를 사용하고 `-SessionId '<exact ID>'`를 추가한다. `--resume` 최근대화 추측, 새대화로 원불명 재전송, 같은 세션 이중 실행은 금지한다.
- 여러 대화는 root별 작성자를 나누고 공통 문서 writer를 하나로 지정한다. 각자 ACK/PROGRESS에 세션·범위·첫 작업·결과를 기록한다. 창/PID 생성과 모델 접수·도구 착수는 별개다.
- 사용자가 실행 완료 확인을 요청하면 해당 세션 metadata와 최초 응답/ACK만 확인한다. 제품 테스트를 끼워 넣지 않는다. 실제 실행 확인이 없으면 PREPARED/WINDOW_STARTED로 보고한다.
- 새 대화·기존 대화 모두 지시는 대화형 첫 메시지로 들어가고, 창은 Windows Terminal의 `AICC-Kiro` 창에 탭으로 추가된다.
- 대기 중인 기존 대화를 다음 지시로 다시 열 때는 [Resume-KiroSessionWithPrompt.ps1](../scripts/Resume-KiroSessionWithPrompt.ps1)을 쓴다. 마지막 차례가 끝났는지 확인하고 그 대화의 대기 탭만 닫은 뒤 같은 세션 ID로 연다. 차례가 진행 중이면 HOLD_ACTIVE_TURN으로 멈춘다. 관리자 탭은 `-Elevated`(launch-admin-powershell의 UAC 없는 Request-ElevatedKiro 경로)로 연다.
- 차례가 진행 중인 대화에는 탭을 바꾸지 않고 [Send-KiroTurnEndInstruction.ps1](../scripts/Send-KiroTurnEndInstruction.ps1)(또는 Resume의 `-QueueIfActive`)로 지시를 맡긴다. 그 대화 에이전트의 공식 Stop hook([kiro-stop-mailbox.mjs](../scripts/kiro-stop-mailbox.mjs))이 이번 차례가 끝나는 순간 같은 세션·같은 탭에서 1회만 이어서 처리하게 한다(대화당 대기 1건, 만료·영수증 있음). 이미 대기(idle) 중인 대화는 Stop이 오지 않으므로 기존 탭 교체를 쓴다. 키 입력 주입·포커스 조작은 쓰지 않는다.
- 장시간 관제의 정체·비정상 종료 복구는 예약 작업이 부르는 [Wake-KiroSupervisor.ps1](../scripts/Wake-KiroSupervisor.ps1)이 맡는다. 진행 중 판정은 세션 상태와 잠금 프로세스로 하며, 긴 차례를 대기로 보지 않는다.
- 여러 그룹 관제(S0·G1~Gn)의 구성·아침 보고·되돌리기는 개인 스킬 `run-kiro-supervised-groups`를 따른다.
- Kiro 구성은 공식 V3 문서의 agent resources(skill://), steering, permissions, CLI settings를 사용한다. Codex 홈을 참조하며 인증·세션 DB를 복제하지 않는다. 설정 변경은 실행 전, 관리형 스킬은 guidance 정본→선택 배포로 반영한다.


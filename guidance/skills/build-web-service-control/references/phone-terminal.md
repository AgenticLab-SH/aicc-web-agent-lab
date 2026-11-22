# Termius / Windows psmux 전화 접속

현재 설치 진입점은 C:\demo\owner\.codex\ops\phone-terminal-20261028\Select-PhoneTerminal.ps1, 운영 정본은 같은 폴더의 TMUX-SETUP.md, 상태는 CURRENT.json이다. 변경 전 이 파일과 해당 프로필만 읽고 현재 writer를 조정한다. public/private G1 모델 경로의 작성권은 별도다.

사용자가 폰 터미널 메뉴·닫힌 터미널 복원·재부팅 후 접속을 요청할 때 사용한다.
- 기존 Termius/Tailscale SSH를 재사용한다. 접속 메뉴는 1 활성, 2 닫힌 기록, 3 PowerShell. 방향키/Enter와 j/k/숫자를 제공하며 긴 붙여넣기나 Ctrl+B를 요구하지 않는다.
- 범위는 aicc-phone의 관측된 psmux 패널이다. PC의 모든 독립 터미널/탭을 attach할 수 있다고 주장하지 않는다. 제목, 마지막 연 시각, 코덱스/일반/미확인을 표시한다. 마지막 접속 시각과 모델 응답 시각은 다르다.
- 프로세스 트리와 exact 대화 결속을 함께 사용한다. pane_current_command는 도구 실행 중 바뀌므로 그것만으로 코덱스 여부를 판정하지 않는다. 새 Codex PID/생성시각은 이전 대화 ID를 자동 상속하지 않는다.
- 활성은 attach만 한다. 닫힌 일반 shell은 폴더만 복원하고 과거 임의 명령을 재실행하지 않는다. Codex는 exact rollout의 ID/provider/model을 읽고 설치 지원 aicc codex ocx resume ID를 추가 프롬프트 없이 호출한다. ID 미확인·열기 UNKNOWN은 보류하고 Native/다른 계정/새 대화로 대체하지 않는다. 기존 writer 잠금과 admission/97%/auto_review를 유지한다.
- 관측기는 60초 간격으로 메타데이터만 저장한다. session_index는 제목 용도이며 전체 대화 탐색·프롬프트 수집·모델 호출을 하지 않는다. 프로세스/목록 읽기 실패를 종료로 취급하지 않는다. 원자 저장과 파일 잠금으로 SSH/PC 동시 접근을 조정한다.
- sshd/Tailscale은 Windows 서비스 자동 시작을 재사용한다. 사용자 Startup의 AICC Phone Terminal History.vbs는 로그인 후 창 없는 기록기만 실행한다. SSH 프로필은 접속 시 메뉴를 표시한다. PC 부팅과 Windows 로그인, 메뉴 표시와 모델 재개를 구분한다. 재부팅 시 모델 작업 자동 재전송은 하지 않는다.
- 원본 preimage와 operation receipt를 보존한다. 변경에 맞는 실행 확인·테스트를 수행하고 미실행 범위를 구분한다. 재부팅은 검증이라는 이유만으로 실행하지 않는다.
- Windows PowerShell 5.1의 File.Replace 세 번째 인수에 $null을 넘기면 빈 경로로 바인딩되어 실패할 수 있다. 이 기록 저장기는 명시적 .previous 백업 경로를 사용한다. 검증을 명시 요청받으면 별도 소유 mux 셸에서 활성 연결/입력, 종료 후 복원/작업 폴더, PowerShell 복귀를 각각 관측한다. 기존 G1을 종료하거나 시험 입력을 보내지 않는다.

- 메뉴는 실제 Codex 대화 제목을 첫 줄, mux 이름/종류를 둘째 줄, 마지막 연 시각을 셋째 줄로 표시한다. 열린 터미널은 모델 작업 중과 다르다. i로 전체 제목을 본다. PS7.5+ ConvertFrom-Json은 DateKind String으로 ISO 생성시각을 보존해 PS5.1 기록과 비교하며, 제목 연결은 exact PID/생성시각/대화ID로만 복원한다.

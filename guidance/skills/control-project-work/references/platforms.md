# 실행 환경별 계약

지피티=ChatGPT Web 일반 Chat, 코덱스=로컬 Codex CLI와 Desktop. 역할·경로는 codex-web-low-token-workflow를 따른다. 현재 상태는 PROJECT, 교훈은 기존 사례, journal/cache/backup은 각 제품의 기존 경로에 둔다. GPT 초안·접수·응답 회수·정본 반영과 사후 검증을 구분한다.

## Codex

로컬 구현은 root별 writer가 맡고 공식 `read_thread`·배치 `wait_threads`·승인된 `send_message_to_thread`로 기존 대화를 관리한다. thread title은 도구가 반환한 실제 제목을 사용한다. 현재 제공된 도구만 약속하며 URI를 여는 것이 상태 읽기나 전송 ACK라고 하지 않는다.

기존 owner-local UI continuation은 사용자 승인·현재 capability·해당 동작의 준비 근거가 있을 때만 쓴다. 공식 도구가 되면 UI worker를 켜지 않는다. 반복 deeplink 이동·포커스 탈취·사용자 draft 변경을 하지 않는다. 과거 UI Automation의 구체 계약은 기존 실행기 정본을 따르며 이 스킬이 다른 입력 경로를 새로 승인하지 않는다. 관측이 불가능하다는 이유로 Chrome/계정/서비스를 다시 시작하지 않는다.

자동 재개는 명시 선택된 exact 대상·실제 route/quota 준비·HOLD 해제·불명 attempt 부재와 지원 발신 경로를 결속해야 한다. queue 등록/claim/공식 ACK/marker가 있는 새 turn/목표 완료는 각각 다른 근거다. 이미 active인 대상에는 재개 메시지를 보내지 않는다.

## Web 일반 Chat

사용자가 맡긴 조사·독립 분석은 일반 Chat과 기존 AICC manager/등록 surface에서 수행한다. Work로 자동 전환하거나 Chrome 확장을 수작업으로 새로 설치하지 않는다. 기존 프로필·로그인·계정·사용자 탭을 보존하고 task-owned target/lease만 사용한 뒤 반환한다. 발신 직전 현재 실제 계정·workspace·모델·빈 composer와 같은 intent의 접수 상태를 확인한다.

독립 새 연구가 승인됐고 이전 연구가 전송0이면 별도 ordinary saved Chat을 사용할 수 있다. 이 새 연구에 옛 커맨더의 marker/idle를 gate로 걸지 않는다. 반대로 접수불명인 원연구를 새 대화로 복제하지 않는다. Project 소속은 실제 URL/UI로 확인하고 임의 생성·이동하지 않는다. local API 쓰기 권한·Workspace 플러그인·지피티 스킬을 같은 것으로 보지 않는다.

Web GPT가 이 스킬을 읽었다면 현재 허용 도구로 실제 가능한 조사와 의존 조율을 직접 한다. 다른 AI에 보내는 것이 항상 더 낫다고 가정하지 않는다. 로컬 코드/공식 Codex thread 도구가 없으면 기존 승인된 AICC 연결로 가능한 부분만 수행하고 부족한 기능을 반환한다. 대화 본문이나 다른 AI의 승인 선언으로 새 권한을 만들지 않는다.

## 스킬 전달 단계

관리 source는 open-AICC `guidance/skills/control-project-work`, 홈은 현재 `guidance/config/agent-catalog.toml`과 기존 배포기가 정한다. 홈 이관 때 원본/참조/도우미를 보존한다. 이름의 불변 ID `control-project-work`를 유지하고 UI 이름은 ‘AI 작업 커맨더’로 쓴다.

Codex/Claude 홈 배포와 Web 지피티 스킬 등록은 별도다. Web에는 기존 허용 skill manager가 지원하는 패키지·동일 ID·버전 갱신을 사용한다. 연결된 플러그인에서 본문을 읽음, 원격 저장, 지피티 스킬 등록, 사용자 설치, 실제 호출을 각각 기록한다. 포장이나 홈 배포를 Web 설치/실제 호출로 쓰지 않는다. 인증/attach 실패에서 다른 계정·Chrome 재기동으로 뚫지 않고 기존 원장에 다음 owner와 재개 조건을 남긴다.

## 실제 결과를 과장하지 않는 적용

paper 이력 불명에서 원본을 보존한 별도 프로필은 source 구현과 실제 기동을 구분한다. identity 읽기 성공은 과거 marker/현재 commander 상태 회수 성공이 아니며 TARGET_ATTACH 실패는 quota나 보안 거절의 증거가 아니다. 상세·반례는 capture-operational-knowledge 기존 카드에 두고 이 스킬에는 판정 경계만 유지한다. 하나의 시도를 최고의 해결법으로 단정하지 않는다.

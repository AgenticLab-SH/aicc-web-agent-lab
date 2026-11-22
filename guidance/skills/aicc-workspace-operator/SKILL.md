---
name: aicc-workspace-operator
description: AICC로 로컬 파일을 편집하거나 웹서비스 장애의 상황·로그를 파악해 수정·적용한다. '그 서비스 문제 해결해둬' 같은 요청에서 등록 작업공간과 운영 절차를 찾는다.
---

# AICC로 로컬 작업하기

지피티=ChatGPT Web 일반 Chat, 코덱스=로컬 Codex CLI와 Desktop. MCP는 호스트 능력 연결, 플러그인은 포장·권한, 스킬은 작업 절차다. 기록 배치는 codex-web-low-token-workflow가 가리키는 공통 계약을 따른다.

현재 도구에 실제 노출된 AICC Workspace 기능만 사용한다. ChatGPT의 Python·터미널·첨부 파일은 사용자 Windows와 별개다. 로컬 경로나 셸 명령을 웹 컨테이너에 직접 실행하지 않는다.

## 일반 Chat의 기존 공용 연결

Work로 전환하지 않고 일반 Chat의 AICC 플러그인 도구를 사용한다. Business 계정 1·2가 같은 공용 워크스페이스 연결을 사용하면 기존 AICC 연결을 재사용한다. 계정별 Tunnel 재게시나 Personal 연결을 필수로 요구하지 않는다. 실제 로그인, Business workspace와 grant는 별도로 확인한다. 도구가 노출되지 않으면 연결 소유자에게 부족한 capability를 보고하며 다른 계정·surface로 우회하지 않는다.

플러그인은 도구 접근, 스킬은 작업 절차다. 로컬 본문을 읽고 적용한 것은 플러그인 기반 활용이다. ChatGPT의 지피티 스킬 로드 신호, 요청과 완료 응답이 있을 때만 지피티 스킬 호출로 기록한다. 본문 전달, 연결 표시와 설치는 서로 다른 상태다.

## 등록 작업공간과 로컬 스킬 읽기

이 단계는 [상세 절차](references/workspace-reading.md)의 같은 절을 읽고 수행한다.

## 서비스 문제를 일반적인 말로 요청받았을 때

“FBTT 주말 경기가 안 나와. 상황 파악해서 AICC로 접속해 그 서비스 문제 해결해둬”처럼 서비스 장애의 조사·수정을 맡기면 [서비스 장애 처리](references/service-repair.md)를 따른다. 사용자가 workspace 별칭·서버 명령·로그 경로를 알 필요는 없다. 현재 대화의 실제 AICC 도구로 서비스와 운영 경로를 찾아 직접 처리한다.

## 연결·쓰기 권한과 보조 터널 설정

이 단계는 [상세 절차](references/workspace-reading.md)의 같은 절을 읽고 수행한다.

## 문서와 기록의 승인된 읽기

이 단계는 [상세 절차](references/workspace-reading.md)의 같은 절을 읽고 수행한다.

## 승인 범위의 변경

사용자의 구현 요청과 같은 작업의 사전 승인은 요청 범위의 일반 파일 수정·검사·Git 작업을 허용하되 현재 모델 정책과 명시적 금지 범위가 우선한다. 이미 승인된 변경을 다시 묻지 않는다. 실제 앱의 write 권한, 작업공간 lease, request ID와 호스트 승인 정책은 계속 따른다. 플랫폼 승인창이나 보안 거부를 우회하지 않는다.

변경 전 관련 파일과 기존 수정을 파악한다. 소유 범위별 writer 한 명만 두고 다른 작성자의 수정은 유지한다. 실제로 노출된 aicc_workspace_apply_patch 또는 aicc_workspace_exec를 사용한다. 실행 session은 aicc_workspace_write_stdin으로 같은 session을 기다리며 명령을 중복 실행하지 않는다. 불확실한 write는 원래 request ID 결과부터 확인하고 재전송하지 않는다.

완료에 필요한 테스트·빌드·실행 확인·실제 앱 사용점검을 변경 영향과 사용자 요청 범위에 맞춰 수행한다. 모델 이름만으로 검증을 생략하지 않으며 통과한 검사는 새 근거 없이 반복하지 않는다. 소스 수정, 검사, 홈 배포와 실제 앱 호출은 별도 상태이며 미실행은 그대로 보고한다.

## Codex·웹 대화 연결

이 단계는 [상세 절차](references/host-and-assets.md)의 같은 절을 읽고 수행한다.

## 마무리와 안전

이 작업의 workspace lease는 aicc_workspace_close, local read capability는 aicc_local_source_close로 반환한다. 이 작업의 실행 session만 처리한다. 브라우저 작업이 승인되면 같은 등록 계정·workspace의 소유 target만 쓰고 회수한다. 사용자 탭, 프로필, 로그인, 대화와 다른 작업의 lease를 닫지 않는다.

디스크 초기화·포맷·파티션 제거·원시 디스크 덮어쓰기와 작업공간·홈·시스템 루트의 광범위 삭제를 실행하지 않는다. Windows 삭제·이동은 승인된 절대 경로와 PowerShell LiteralPath를 쓴다. 새 결제·새 공개 대상·복구 어려운 삭제·새 권한 확대는 별도 범위다. 비밀·인증·세션 원문·브라우저 프로필을 결과나 원격 문서에 복제하지 않는다.

## 로컬 연결이 필요하지 않은 단계

이 단계는 [상세 절차](references/workspace-reading.md)의 같은 절을 읽고 수행한다.

## 지피티 자산 자체 관리

이 단계는 [상세 절차](references/workspace-reading.md)의 같은 절을 읽고 수행한다.

## 한도 안내와 연결 오류

이 단계는 [상세 절차](references/workspace-reading.md)의 같은 절을 읽고 수행한다.

## Windows 호스트 실행과 격리 실행의 선택

이 단계는 [상세 절차](references/host-and-assets.md)의 같은 절을 읽고 수행한다.

## 승인된 자산 관리 전용 도구

이 단계는 [상세 절차](references/host-and-assets.md)의 같은 절을 읽고 수행한다.

## 요청한 생성 파일을 Notion에 저장

이 단계는 [상세 절차](references/host-and-assets.md)의 같은 절을 읽고 수행한다.

## Native·OCX Codex CLI에 독립 업무 맡기기

이 단계는 [상세 절차](references/host-and-assets.md)의 같은 절을 읽고 수행한다.


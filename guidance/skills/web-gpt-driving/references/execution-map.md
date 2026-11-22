# 지피티 전송·회수 및 자산 관리 도구 지도

경로는 저장소 기준이다. 실제 설치 위치·등록 계정·workspace·owner·포트는 해당 호스트의 private coordination과 프로젝트 정본에서 찾는다. 이 목록은 현재 설치나 사용 권한의 증거가 아니다.

| 작업 | 기존 구현·절차 | 경계 |
| --- | --- | --- |
| 지피티 대화 전송·응답 회수 도구 | private scripts/chatgpt-registered-review-turn.mjs, chatgpt:send-and-collect | 새 작업용 탭 생성·prompt 전송·저장 응답 회수. 새 일반 Chat·기존 turn0에서 복원 초안을 정리하며 기존 사용자 탭·저장 대화는 보존. OCX 계정 전환·상시 감시와 구분 |
| Project·GPT 목록과 변경 | manage-chatgpt-assets 및 기존 private adapter | stable ID, 현재 identity, 사용자 승인 범위 |
| 공용 스킬 ZIP 등록 | private scripts/chatgpt-workspace-skill-sync.mjs | name-only 비교는 기존 항목 업데이트 근거가 아님 |
| 개인 스킬 목록·본문 변경 | manage-chatgpt-personal-skills의 scripts/personal-skill-manager.cjs | exact ID와 description/body preimage를 구분 |
| 패키지·원격 버전 관리 | manage-chatgpt-skills/references/manager-contract.md | source/home/지피티 등록/사용자 설치/호출을 분리 |
| 선택 Web 대화 감시 | web-jjonku-monitor와 private supervisor | capabilities, opt-in URL, response-scoped attempt, 기본 OFF |
| PC·폰 큐와 계정 제어 | src/mobile-control.mjs, public/mobile.html, 기존 continuity helper | preview와 일회 confirm, 불명 요청 보존 |
| Desktop 자동 전달 | 공식 앱이 제공하는 지원 경로 | Windows 지원 transport가 없으면 큐 설정만 가능 |

공용 스킬 sync의 현재 소스 인수는 `--account-alias`, `--workspace-alias`, `--owner-id`, 반복 가능한 `--skill`, 선택 `--lease-helper`, 변경용 `--commit`이다. 내부 런타임이 Bun을 사용하므로 실행 파일도 소유자가 등록한 런타임을 따른다. `--verify-account-alias`는 별도 사용점검이며 현재 모델 정책이 금지한 사후 검사를 위해 실행하지 않는다. 새 업데이트·삭제·대상 조회 명령을 추측하지 않는다.

로컬 연결 화면은 소유 PC의 기존 loopback 주소로 연다. 폰은 이미 승인한 HTTPS 주소와 PC에서 한 번 발급한 링크를 쓴다. PC에서도 폰 인증을 다시 받아야 한다고 안내하지 않는다. 현재 주소와 Desktop HOLD는 프로젝트 정본에서 읽는다.

기존 private scripts/chatgpt-pro-response-monitor.mjs의 ownedConversationStateExpression/classifyOwnedConversationState는 승인된 소유 대화의 URL·프로젝트ID·저장 marker와 현재 생성·빈 composer·완료 제어를 읽어 상태와 중복전송 금지를 반환한다. 원문을 원장에 복제하지 않으며 렌더 wrapper를 안정 ID로 승격하지 않는다. 이 읽기 전용 판정은 새 메시지 권한·Stop 권한·작업 전체 완료를 반환하지 않는다. 실제 선택·발신 소유권과 lease는 호출자가 먼저 결속한다.

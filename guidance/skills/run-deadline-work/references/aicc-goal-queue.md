# AICC goal·queue 연결

이 PC에서는 목표 표시와 실행 수단을 나눠 사용한다. 경로는 현재 등록 값으로 확인하며 release나 account를 고정 상수로 새로 만들지 않는다.

| 기능 | 현재 정본/지원 | 증명하지 않는 것 |
|---|---|---|
| 트레이/웹 추적 목표 | `~/.ai-control-center/control-plane/master-goals.json`, AICC goals service | Codex 내장 goal 활성·native 부모 권위·stop epoch |
| 현재 대화 큐 | `control-plane/codex-continuity/registrations.json`의 등록 helper와 protocol/SHA | 실제 발신·새 turn·quota 회복 |
| Codex 내장 goal | 실제 제공 `get_goal`/`create_goal`/`update_goal` | AICC 원장 자동 갱신·호스트 재부팅 후 무인 실행 |
| 단회 전달 | 기존 helper `QueueMessage` 또는 공식 thread 도구 | 무인 재개 전체 연쇄·전체 목표 완료 |

## 목표에 현재 작업 연결

### 현재 터미널에서 직접 재개

사용자가 같은 goal 재개를 지시했고 모델 도구에 resume가 없으면 현재 Codex TUI의
`/goal resume`을 우선 사용한다. `codex goal resume` 셸 명령과 다르다.

1. 기존 open-mux-terminal의 Inspect/current로 exact thread UUID·Namespace·전체 target과 살아 있는 프로세스를 함께 확인한다. psmux 조회·캡처·입력에는 반환된 Namespace를 -L로 전달한다. 기본 namespace에서 no server가 나왔다는 이유만으로 원 pane 소실이나 재생성 필요로 판정하지 않는다.
   현재 입력 초안이 있으면 보존하고, 사용자 입력이나 다른 작업자의 입력을 지우지 않는다.
2. 기존 `/goal` 화면 또는 상태줄에서 지원 명령과 stalled/paused 상태를 확인한다.
   터미널 입력을 한 번에 넣고 Enter와 분리한다. mux는 `send-keys -l '/goal resume'`로
   입력한 후 capture에서 정확한 `/goal resume`과 slash 명령 인식을 확인한다.
   조각 입력이나 Tab 완성은 공백이 중복되거나 `/goal`만 실행될 수 있다.
3. 확인 후 Enter 한 번을 보낸다. 일반 모델 메시지로 접수됐다면 재전송하지 말고 원접수를 조정한다.
   `get_goal` 또는 공식 `/goal` readback에서 같은 목표의 active 상태와 기존 사용 이력 보존을 확인한다.
   목표 생성·clear·내부 저장소 편집·현재 Codex 재실행은 하지 않는다.

현재 실행 중인 자기 대화에 이 명령을 적용하는 것은 사용자 goal 상태 변경이다.
자기 자신에게 후속 모델 메시지를 보내는 방식으로 지속 실행을 흉내 내지 않는다.
active 확인은 실제 quota 리셋 후 무인 복귀나 재부팅 후 자동 작업 재개의 증거와 별개다.

사용자가 같은 내장 goal 재개를 명시했는데 모델 도구에 resume가 없으면 설치된 공식
App Server 계약부터 확인한다. 지원되는 `thread/goal/set`의 `origin=user`,
`status=active`와 objective/tokenBudget 생략은 기존 목표·사용 이력을 보존한다.
실행은 기존 [continuity runbook](../../../../docs/runbooks/codex-continuity-maintenance.md)의
`resume-user-goal.mjs` preview/apply를 따른다. pinned manifest/동일 owner daemon·
loaded exact thread/root·snapshot·사용자 지시 ref가 필요하며 내부 저장소를 편집하지 않는다.
`usageLimited` 자동복귀·Native 부모 소비 권위는 별도다. socket/ACL 거절이나
불명 응답을 다른 transport로 우회하지 않고, goal ACTIVE와 실제 작업 완료를 구분한다.

내장 goal은 실제 도구를 통해 읽고 변경한다. AICC 추적 원장에는 동일 exact thread/root와 기존 execution 현재 위치를 연결한 한 항목을 재사용한다. 추적 원장 편집이 현재 owner의 승인 범위이고 지원 쓰기 경로가 있을 때만 수정한다. 원본 백업·기존 공유 잠금·최신값 읽기·원자 교체·다른 항목 보존을 따른다. JSON의 체크박스는 owner 체크이며 목표 완료가 아니다. 기존 native 부모 권위 요구를 추적 원장으로 대체하지 않는다.

연결 필드는 기한, 현재 단계, 마지막 실제 진전, 다음 구체 동작, 원인별 미완료, 실제 큐 선택/전달 단계, 내장 goal 실제 관측, 취소 여부다. 원래 목표 ID·기록을 지우거나 옛 UNKNOWN을 새 run으로 재생하지 않는다.

## 현재 대화 큐 선택

registry에서 helperPath/protocolVersion/helperSha256과 exact thread의 enabled·hold·attempt·queueAttempt를 읽는다. 등록 파일이 실제 SHA와 일치하는 기존 helper를 사용한다. 미결 attempt가 있으면 먼저 조정하며 새 operation을 만들지 않는다.

사용자가 이번 run에 큐 사용을 요청했고 취소 범위와 충돌하지 않을 때만 해당 exact 대화를 Register/Enable한다. Enable의 `noRequestDispatched=true`를 실제 재개로 보고하지 않는다. 활성 대화는 바로 계속 작업하며 자기 메시지를 넣지 않는다. 해제는 같은 helper `Disable -ThreadId <exact UUID>`로 현재 run만 한다.

## 다른 대화에 실제 전달이 필요한 경우

상세는 기존 `build-web-service-control/references/codex-queue.md`와 `references/aicc.md`를 필요한 부분만 읽는다. 실제 사람의 대상·내용 승인, exact recipient와 단일 sender를 확보한다. 단회 queue operation/본문 hash/원접수 영수증을 보존한다. 현재 설치 계약의 fresh OCX·idle·HOLD 조건을 요구하는 자동재개에는 `DesktopClaim → 공식 전송 → DesktopAck → marker/새 turn Observe`를 그대로 적용한다. 수동 QueueMessage 영수증을 자동재개의 ACK로 바꾸지 않는다.

지원 sender 없는 로컬 worker는 큐를 보존한다. 공식 도구를 쓰는 별도 sender 없이 등록·Enable만으로 무인 복귀를 주장하지 않는다. 반복 모델 예약·두 번째 worker·exec resume로 현재 writer 탈취·자기 메시지로 이 빈칸을 메우지 않는다.

## 실제 적용 보고

정확 대화, 내장 goal 상태, AICC 추적 goal ID, 큐 선택, 실제 발신 횟수, 기한과 다음 동작을 기존 PROJECT/execution에 남긴다. 큐가 켜졌어도 무인 전달이 미입증이면 그렇게 적는다. 기한 도달은 clock으로 판정하고 Disable 후 미완료를 인계한다.

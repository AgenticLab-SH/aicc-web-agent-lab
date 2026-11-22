# Codex Desktop 종료·재시작

사용자가 현재 작업에서 exact 종료 또는 재시작을 명시적으로 승인한 경우에만 적용한다.

1. 현재 OS의 Desktop 앱 identity와 main PID를 고정하고, 모든 로컬 Codex rollout의 마지막 lifecycle event를
   확인한다. 미완료 task나 `UNKNOWN`이 하나라도 있으면 기다리거나 `HOLD`한다.
2. 17841 세 counter와 OCX active turn을 같은 PID에서 5회 연속 0으로 확인하고 Native·17842
   rescue를 먼저 검증한다.
3. owner-only 외부 터미널에서 product-owned one-shot worker 하나만 실행한다. exact task,
   operation, Desktop PID, worker PID, TTL과 callback hash를 묶는다. Windows에서는 예약 작업·서비스,
   macOS에서는 LaunchAgent를 새로 만들지 않으며 cron, 반복 heartbeat, 키 입력, 강제 종료, 재시작 loop도 금지한다.
4. 현재 task 완료 뒤 OS의 정상 종료 API를 한 번 호출한다. Windows는 앱의 정상 창 닫기,
   macOS는 bundle 정상 종료를 사용하며 old PID 소멸을 성공 기준으로 삼는다.
5. 재시작 요청이면 old PID 소멸 뒤 2초 이상 기다리고 Windows는 등록 앱 identity, macOS는 bundle ID로 한 번만 연다. 새 main PID와
   기존 17841·17842·10100 service PID, Native rescue, route/catalog를 확인한다.
6. 확인창, 예약 작업 경고, app refusal이 나타나면 대신 누르거나 강제 종료하지 않고 `HOLD`한다.

재실행 없는 종료는 cold workflow `quit-codex-desktop-safely`를 찾는다. 현재 task를 자동 재개해야
하면 기존 terminal callback runbook을 사용하며, callback의 exact turn이 확인되기 전 새 turn을
재발행하지 않는다.

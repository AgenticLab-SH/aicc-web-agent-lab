---
name: quit-codex-desktop-safely
description: 사용자 종료 요청 시 작업·경로 idle을 확인해 Codex Desktop을 닫는다. 진행 작업 강제 종료 금지.
---

# Codex Desktop 안전 종료

현재 요청을 포함한 로컬 Codex 작업이 끝난 뒤 AICC 단발 worker로 Codex Desktop만 정상 종료한다.
즉시 유휴이면 확인창 없이 끝나며, 예약 작업 경고가 나타나면 정확히 식별된 `종료` 버튼만 한 번 누른다.

## 실행 계약

1. 현재 bundle ID `com.openai.codex`의 main PID를 읽고 하나인지 확인한다.
2. `aicc codex-desktop status --json`으로 작업을 분류한다. 현재 대화가 active인 것은 정상이며,
   단발 worker가 이 응답의 `task_complete` 뒤까지 기다리게 한다. UNKNOWN을 idle로 간주하지 않는다.
3. 17841 세 active counter, 10100 active turn, 17842와 Native rescue를 확인한다. 실패한 read는
   0이 아니라 UNKNOWN이다.
4. 사용자의 이번 요청이 종료 승인임을 확인하고 다음 명령 하나만 실행한다.

```bash
aicc codex-desktop quit-once \
  --expected-pid <exact-main-pid> \
  --expected-thread <current-task-uuid> \
  --confirm-one-shot
```

명령은 owner-only runtime에 `KeepAlive=false` worker 하나를 만들고 현재 응답 뒤 유휴 상태를 기다린다.
같은 목적의 worker가 이미 실행 중이면 새 worker를 만들지 않는다.

## 종료 분기

- 작업·예약 경고가 없으면 정상 종료 요청 뒤 old PID가 사라지는 즉시 PASS한다.
- 경고가 있으면 exact PID의 작은 accessibility dialog/sheet만 읽는다. `예약된 작업` 또는
  `scheduled task` 문구와 이름이 `종료`/`Quit`인 버튼이 정확히 하나일 때만 한 번 누른다.
- dialog identity, 접근성 권한 또는 버튼 수가 불명확하면 아무것도 누르지 않고 HOLD한다.
- 정상 종료 요청의 advisory 반환값이 아니라 old PID 소멸로 성공을 판정한다.
- 종료 뒤 앱을 다시 열지 않는다. 10100·17841·17842·Native rescue의 기존 PID와 health를 확인한다.

## 결과와 정리

- PASS/HOLD를 owner-only `result.json`과 `final-message.md`에 남기고 로그를 보존한다.
- terminal 뒤 exact launchd label만 bootout한다. 종료 성공 시 Codex Desktop이 꺼져 있으므로
  현재 대화에서 후속 응답을 기대하거나 입력창을 자동 조작하지 않는다.
- 사용자가 재실행까지 요청했다면 이 스킬 대신 `manage-codex-model-routes`의
  `aicc codex-desktop restart-once` 계약을 사용한다.

## 금지

- 좌표 클릭, `Command-Q` 키 입력, Computer Use 우회, `kill`/`SIGTERM`/`SIGKILL`, 강제 종료를 쓰지 않는다.
- 활성·UNKNOWN 작업을 종료하거나 idle을 만들기 위해 task, provider, account, browser를 바꾸지 않는다.
- restart 명령으로 종료를 흉내 내거나, 앱을 다시 열거나, 반복 worker·무한 `KeepAlive`를 만들지 않는다.
- Codex Web GPT 앱, OCX, Chrome, Whale 또는 다른 앱을 함께 종료하지 않는다.

# Codex Desktop 앱 제어 자동화

상태: 2026-09-26 Windows 실기 검증 완료.

## 목적

ChatGPT/Codex packaged Desktop의 기존 대화를 정확히 찾아 메시지를 이어 보내고,
Desktop usage gate 또는 writer 충돌이 있을 때 동일 thread를 안전하게 OCX로 이어간다.

## 기본 원칙

- Windows에서는 CUA Driver의 UIA snapshot을 먼저 사용한다.
- 클릭/입력은 background-first로 시도하고 `background_unavailable`일 때만 foreground로 승격한다.
- 좌표보다 fresh `element_token`을 우선한다.
- thread 이름만 보고 새 대화를 만들지 않는다. 기존 exact thread를 재사용한다.
- `reset`, `clean`, 강제 process kill, 전역 route rewrite로 문제를 우회하지 않는다.
- Native, OCX, WebGPT의 failure domain은 분리한다.
- 계정 pool 회전이나 quota 가장은 사용하지 않는다.

## 정상 quota일 때의 앱 제어 순서

1. `list_apps` / `list_windows`로 packaged ChatGPT/Codex 창을 특정한다.
2. `get_window_state`로 현재 thread와 sidebar의 대화 이름을 확인한다.
3. exact chat button을 `element_token`으로 background invoke한다.
4. fresh snapshot에서 Document label이 목표 thread인지 다시 확인한다.
5. composer `Edit`를 특정하고 메시지를 입력한다.6. `보내기`가 존재하고 사용 가능할 때만 앱에서 전송한다.
7. 전송 뒤 fresh snapshot과 thread event를 통해 실제 user turn / agent turn 시작을 확인한다.

## usage gate 진단

Desktop에 `워크스페이스의 크레딧을 모두 사용했습니다`가 표시되면
UI의 send control이 사라질 수 있다. 이 상태를 숨은 클릭이나 patch로 우회하지 않는다.

라이브 검증 결과:

- `aicc codex status --json`의 OCX `ready=true`는 OCX data route가 살아 있다는 뜻이다.
- 이것만으로 현재 Desktop writer가 OCX를 사용한다는 뜻은 아니다.
- 실제 thread의 `thread_settings_applied.model_provider_id`를 확인해야 한다.
- Desktop writer가 `openai`이면 Native usage gate를 그대로 받는다.
- `aicc codex ocx queue ...`는 active Desktop writer의 provider를 OCX로 전환하지 않는다.
- 따라서 queue가 성공해도 Native credit gate에서 turn이 실패할 수 있다.

## 같은 thread를 OCX로 이어가는 검증된 fallback

1. 목표 thread의 exact session UUID를 owner-local Codex state에서 read-only로 확인한다.
2. Desktop이 active writer이면 동일 thread `resume`은 `already has an active writer`로 fail-closed한다.
3. `Alt+F4`만 쓰지 않는다. 실기에서 창만 숨고 app-server와 writer가 남았다.
4. 앱을 다시 표시한 뒤 `파일 -> ChatGPT 종료 (Ctrl+Q)`를 UIA로 invoke한다.
5. `ChatGPT.exe`와 Desktop-owned `codex.exe app-server`가 종료됐는지 post-read한다.6. 목표 Git 저장소의 trusted root에서 아래처럼 exact thread를 재개한다.

```powershell
aicc codex ocx --route-model gpt-5.6-sol exec resume <THREAD_ID> '이어서 작업해줘' --json
```

7. 다음 evidence가 모두 보여야 성공으로 판정한다.
   - `thread.started`
   - `thread_settings_applied.model_provider_id = opencodex`
   - `thread_settings_applied.model = gpt-5.6-sol`
   - `task_started`
   - reasoning / agent message
   - 실제 tool call 또는 후속 작업 evidence
8. `usage_limit_exceeded` 또는 `workspace_owner_credits_depleted`가 다시 나타나면 OCX 전환 실패로 본다.
9. OCX turn이 끝난 뒤 packaged app을 AUMID로 다시 열고 동일 thread의 결과를 확인한다.

## 2026-09-26 실기 결과

- 대상: 기존 `SKCT 고급 모드 오류 점검` thread.
- 앱 UI에서 exact thread 탐색과 composer 제어: PASS.
- active Desktop writer에 OCX queue 주입: user turn 기록은 됐지만 Native credit gate로 실패.
- `Alt+F4`만으로 writer 해제: FAIL.
- `파일 -> ChatGPT 종료` 후 exact thread OCX resume: PASS.
- resume 후 provider `opencodex`, model `gpt-5.6-sol`: PASS.
- reasoning, agent message, tool call, tool output 발생: PASS.
- 전역 default route는 이 절차에서 변경하지 않았다.

## 다음 자동화

AICC에 `codex-thread-send` 같은 bounded action을 만들 때 이 절차를 정본으로 사용한다.
정상 quota는 앱 UI 전송을 우선하고, usage gate가 증명된 경우에만 exact-thread OCX resume fallback을 사용한다.
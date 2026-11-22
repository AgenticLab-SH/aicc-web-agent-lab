# Codex 앱 제어 자동화

상태: 2026-09-26 실제 Windows Codex Desktop + OCX handoff에서 검증된 운영 절차.

## 목적

Codex Desktop의 특정 기존 대화를 정확히 선택하고, UI가 정상 전송 가능한 경우에는 앱 자체를 제어하며, ChatGPT workspace usage gate 등으로 전송이 닫힌 경우에는 제품 gate를 우회하지 않고 같은 thread의 single-writer ownership을 안전하게 OCX로 넘겨 작업을 계속한다.

## 검증된 핵심 패턴

1. CUA Driver로 Codex Desktop의 정확한 창을 식별한다.
2. fresh get_window_state에서 목표 대화 이름과 현재 Document label을 함께 확인한다.
3. UI 조작은 background-first로 한다. element token은 fresh snapshot에서 얻은 것만 사용한다.
4. composer와 send 상태를 fresh-read한다. 사용량/크레딧 gate가 보이면 강제 DOM 호출이나 제품 패치로 우회하지 않는다.
5. aicc codex status --json과 OCX loopback health/readiness로 OCX data path가 실제 ready인지 별도로 확인한다.
6. 같은 thread에 Desktop writer가 살아 있는 동안 다른 writer로 resume하지 않는다. thread-store conflict는 정상적인 single-writer 보호다.
7. exact turn이 idle임을 확인한 뒤 Desktop을 완전히 종료해야 할 때는 Alt+F4에 의존하지 않는다. 실제 검증에서는 파일 -> ChatGPT 종료 메뉴를 UIA로 invoke해야 app-server writer까지 해제됐다.
8. Desktop process/app-server가 사라졌음을 post-read한 후 같은 thread를 OCX로 resume한다.

Command pattern:
aicc codex ocx --route-model <ROUTE_MODEL> exec resume <THREAD_ID> "<MESSAGE>" --json

9. rollout/event evidence에서 다음을 확인해야 성공이다.
   - thread_id가 목표 thread와 일치
   - thread_settings_applied.model_provider_id == opencodex
   - model이 선택한 OCX route model과 일치
   - cwd가 목표 repository와 일치
   - 새 user message가 같은 thread에 기록됨
10. OCX writer가 동작 중일 때 동일 thread를 Desktop에서 다시 writer로 열지 않는다.
11. OCX turn이 끝난 뒤 Desktop을 다시 열 필요가 있으면 packaged app은 AppUserModelID/Shell activation으로 시작한다. WindowsApps의 ChatGPT.exe를 경로로 직접 실행하지 않는다.

## CUA 입력 사다리

- read: list_apps/list_windows -> get_window_state
- action: fresh element_token + background delivery
- verify: fresh get_window_state
- background_unavailable이 반환된 exact action만 foreground로 승격
- Electron/Chromium text surface에서 foreground가 필요할 수 있으나, 앱 메뉴/UIA Invoke가 가능한 경우 background path를 우선한다.
- 좌표 클릭은 semantic/UIA target이 없을 때만 fallback한다.

## 이번 검증에서 확인된 실패 패턴

- Alt+F4: 창을 숨기거나 닫아도 Desktop/app-server writer가 남을 수 있어 ownership handoff 증거가 아니다.
- active Desktop writer 상태에서 OCX exec resume: already has an active writer로 fail-closed.
- active Desktop writer에 queue: 메시지는 같은 thread에 들어가지만 현재 writer의 route로 실행된다. 따라서 Native/ChatGPT usage gate가 소진된 상태에서는 OCX 전환이 되지 않는다.
- UI send gate가 닫힌 상태에서 send control 강제 실행: 사용하지 않는다.
- direct packaged executable launch: package identity 오류 위험이 있으므로 금지한다.

## 자동화 구현 시 필수 postcondition

성공 판정은 "클릭/명령이 에러 없이 끝남"이 아니라 아래 네 증거를 모두 요구한다.

1. exact target thread
2. exact writer ownership
3. exact provider/route
4. 새 turn의 실제 실행 또는 완료 event

민감정보(토큰, 쿠키, 계정 식별자)는 로그나 tracked 문서에 저장하지 않는다. 실제 thread ID도 자동화 문서에는 예시 placeholder만 사용한다.

## 재사용 방향

향후 앱 제어 자동화는 이 절차를 AICC의 guarded CUA + Work Ledger + Resource Lease와 결합한다. UI 선택은 CUA가 담당하고, writer ownership과 route handoff는 AICC가 담당하도록 역할을 분리한다. 동일 앱/대화에 대한 병렬 writer는 Resource Lease로 fail-closed해야 한다.

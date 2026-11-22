# 관제 실행 설계

실행 정본은 기존 `<opsDirectory>/SUPERVISOR/wake-config.json`이다. `wake-state.json`, 깨우기 로그와 PROGRESS는 각 주체의 기록으로 읽기만 한다. 기존 Kiro 행은 역사적으로 판독하며 새 기본 runner는 Codex다. 새 목록은 `s0=null`, `taskName=null`로 준비한다.

## 서비스와 UI

- `src/supervised-runs/state.mjs`: 기존 schema 정규화·exact session 형식·원문 지문.
- `runners.mjs`: 과거 Kiro 읽기, Codex 프로세스 관측. Codex 차례 상태는 프로세스 목록만으로 확정하지 않는다.
- `service.mjs`: 상태·계획·기록과 이름 있는 변경 `start`, `add-group`, `end-group`, `close-tab`, `wake-group`.
- CLI `aicc supervise`, 모바일 세션·CSRF·same-origin 내부 `/api/mobile/supervise*`, 기존 WinForms 패널이 같은 서비스를 사용한다. 새 대시보드·scheduler·모델 agent는 없다.

그룹은 `name`, `runner`, `sessionId`, `workingDirectory`, `progressFile`, 선택 `wakeCallbackId`를 가진다. `wakeCallbackId`는 기존 CodexTaskCallbackService의 owner-local binding을 참조한다. 임의 callback 생성·prompt 실행을 대신하지 않는다.

## 변경과 복구

미리보기는 현재 정본 지문·5분 유효기간·action·인자·CLI/로컬/폰 scope·exact 웹 session을 묶는다. 확인은 같은 scope에서만 허용하고 preview 파일의 원자적 rename으로 한 번만 소비한다. O_EXCL writer lock과 직전 지문 대조를 통과해야 변경한다. 이미 존재하는 lock은 삭제하거나 우회하지 않는다.

`start`는 create-only 정본 한 파일만 쓴다. 그룹 등록·종료는 원 필드와 endedGroups를 보존해 원자적으로 바꾼다. 실패 시 자기 사전 원문으로만 복구한다. Codex 직접 exec/resume 지시 실행과 강제 프로세스 종료는 거절한다. 과거 Kiro 탭 처리는 기존 active 판정을 지킨다.

`wake-group`은 등록 callback의 task/root와 결과 hash를 확인한다. 기존 callback의 `complete(waitForTerminal=false)`가 exact idle·binary·manifest·result·delivery fence를 집행하고 같은 thread에 한 번 제출한다. 전송 후 되돌리기나 UNKNOWN 재발신은 없다. source 결과, 접수, turn ID, terminal turn, 목표 완료를 별도로 표시한다. surface 제한은 preview뿐 아니라 confirm에서도 적용한다.

## 확인 범위

검사는 fake runner·격리 상태에서 수행하며 실제 계정·route·OCX·Kiro/S0를 바꾸지 않는다. 실제 설치/실사용은 [제품 상태](PRODUCT.md)의 적용 조건을 따른다. 릴리스 게시 전에는 Windows OS gate가 필요하다.
# 관제 실행

기존 트레이와 PC·휴대폰 화면에서 관제 실행과 그룹 상태를 읽고, 같은 원장의 등록·종료를 관리한다. G3 통합 대시보드를 새로 만드는 기능은 아니다.

## 현재 사용 경로

- `aicc supervise status|logs`는 기존 `SUPERVISOR/wake-config.json`과 PROGRESS 꼬리를 읽는다.
- `plan` → `start`는 새 목록만 준비한다. Kiro/S0 프로세스·예약 깨우기를 다시 켜지 않는다.
- `add-group`은 등록, `end-group`은 목록 종료다. 등록은 작업 실행이 아니며, 종료는 진행 중 차례나 다른 주체가 등록한 callback을 취소하지 않는다.
- `wake-group`은 그룹의 기존 `wakeCallbackId`에 연결된 exact Codex 대화에 결과를 한 번 전달한다. 새 대화·임의 prompt·계정 전환을 만들지 않는다.
- 화면은 `/supervise.html`, 트레이 메뉴는 `관제 실행 · 그룹 상태`다. PC 로컬 연결에서 callback 깨우기를 미리보고 확인한다. 휴대폰에서는 읽기와 목록 종료·지원되는 과거 탭 닫기만 허용한다.
- Codex 종료는 기존 mux에서 정상 종료한다. 프로세스·창 부재나 존재만으로 차례 대기·완료를 판정하거나 저장된 지시를 재전송하지 않는다.

## Codex callback 연결

기존 [Terminal callback 절차](../../docs/runbooks/codex-terminal-task-callback.md)로 승인된 exact 대화·프로젝트·작업 결과에 callback을 먼저 등록한다. 그룹 등록 JSON에 같은 `sessionId`, `workingDirectory`, `wakeCallbackId`를 넣는다. callback이 없으면 화면에 HOLD 사유를 표시한다.

`wake-group` 입력은 `{ "run": "실행 이름", "name": "그룹 이름" }`다. CLI·PC 웹·트레이 모두 미리보기 뒤 일회 확인을 사용한다. 서비스는 callback의 대화와 프로젝트가 그룹과 같은지 확인하고 결과 SHA-256을 고정한다. 기존 callback 구현이 authoritative idle, 결과·binary·manifest, 단일 writer와 UNKNOWN/no-replay를 검사한다. `turn_started`는 차례 시작 접수이며 목표 완료가 아니다. 재조회는 같은 callback 영수증을 읽는다.

## 계정과 연결

시작 선호 번호는 실제 배정 계정의 증거가 아니다. 자동/우선 모드는 설치된 OCX가 담당한다. 이전 차례 완료, 이동 가능한 기록, 새 적격 계정이 확인된 다음 미전송 요청에서 같은 대화를 이어갈 수 있다. 활성·UNKNOWN·파일/서버 종속 참조는 보호한다. 엄격 고정도 97% 보호를 지키며 다른 계정·Native 우회를 만들지 않는다.

## 통합·적용 상태

S-UI 4커밋과 S-TRAY 155d977을 기존 dirty 위에 기능별로 통합했다. S-TRAY 설치분은 유지했다. Codex callback 연결과 모바일 확인 토큰의 surface·session 결속을 추가했다. 실제 source CLI 읽기는 성공했다.

통합 트레이 Prepare 빌드는 성공했다. 실제 트레이 교체·서버 재시작·callback 실전송·UI 실화면·폰 I/O는 미확인이다. 현재 제어 경로를 끊는 적용은 독립 복구와 fresh exact-idle 이후 해당 소유자가 수행한다. Aside 미실행으로 브라우저 QA는 NOT_RUN이다. 상세 로컬 검사 근거는 제품 writer의 Git private 작업 기록에 보존한다.
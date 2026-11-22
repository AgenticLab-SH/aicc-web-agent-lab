# 구현·운영 계획

## 구성

- AICC 설정/API: `src/web-jjonku-monitor-config.mjs`와 `/api/web-jjonku-monitor/config`
- 설정 저장: owner-local `control-plane/web-jjonku-monitor.json`
- 실행 영수증: `control-plane/web-jjonku-monitor-state.json`
- 사용자 화면: 기존 monitoring 화면의 반응형 설정 폼
- Codex 실행 규칙: `guidance/skills/web-jjonku-monitor/`
- 실행 간격: Codex heartbeat 5분 1개, AICC 설정 간격에 맞춰 실제 확인 여부를 결정

## 검증 순서

1. 사용자 제공 탭 그룹과 정확한 일곱 대화 ID를 확인한다.
2. 잘못된 기존 heartbeat를 삭제하고 중복 예약이 없는지 확인한다.
3. AICC 설정 schema/API/화면을 GPT 그룹 대화 기준으로 바꾼다.
4. Codex skill, 영수증, 설치본을 같은 기준으로 맞춘다.
5. API 저장·재읽기, roster 검증, UI 반응형, skill validator를 확인한다.
6. 확인 가능한 분리 창에 한해 새 heartbeat 하나를 활성화하고 첫 일곱 대화 영수증을 검증한다.

## 되돌리기

기존 설정과 영수증은 새 identity 증거로 사용하지 않으며 덮어쓰지 않는다. 설정/API 오류 시 기존 파일을 보존하고 감시를 끈다. 예약 중복이나 브라우저 제어 장애가 반복되면 새 heartbeat를 삭제한다. Oracle 등 다른 예약은 이 기능 범위에 넣지 않는다.

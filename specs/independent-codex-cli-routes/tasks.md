# Independent Codex CLI routes tasks

- [x] T-001 — intent/spec 확정. 연결: FR-001~FR-006.
- [x] T-002 — `src/codex-cli-routes.mjs`, `src/cli.mjs` 소유: process별 Native/OCX 실행, route별 모델 선택과 fail-closed preflight 구현. 연결: FR-001~FR-007, SC-001~SC-002.
- [x] T-003 — `src/catalog.mjs` 소유: TUI에 Native와 OCX Codex 실행을 별도 항목으로 노출. 연결: FR-001, SC-003.
- [x] T-004 — focused tests와 문서 소유: route·fallback·override·config 불변 검증과 쉬운 사용법 기록. 연결: FR-002~FR-006, SC-001~SC-004.
- [x] T-005 — 사용자 적용·검증 승인에 따라 owner-local live activation과 Native/OCX canary 완료.


## 2026-10-20 추가 요청 — 현재 root 소유

- [x] T-006: FR-008 route effort·local readiness·공통 preflight 구현/설치, 실제 두 경로 medium 응답 확인.
- [x] T-007: FR-009~012 start/status, exact binding·UTF-8·operation·lease/Job lifecycle·manifest 구현. 요청된 dispatcher/Workspace/runtime 시험 통과.
- [x] T-008: 정본 runbook/두 스킬 및 홈 배포 완료.
- [x] T-009: exact host 권한·원본·독립 복구·idle/CAS를 결속해 선택 파일 설치. 기존 동일 앱57 enabled 도구 계약 검증, 추가 publish 불필요.
- [x] T-010: 사용자 명시 검증으로 관련 시험과 최종 설치본 일반 Chat Native/OCX E2E 통과. COMPLETED/exit0/한글 SHA 일치/lease0 확인. 전체 공통 gate 범위 밖4건은 별도 유지.
- [x] T-011: 트레이 우클릭·도구 탭의 Native/OCX 선택, Git 폴더·모델·effort 실행 창, 고정 managed CLI 실행기, 사용자 설명·스킬 작성·홈 배포.
- [x] T-012: 앞선 명시적 검증 요청의 같은 Native/OCX 흐름 안에서 빌드·설치, exact 새 프로세스 관측, 실행기 실제 전달/거절 시험2개, OCX/Native × dark/light 창 상태/렌더 시험 완료. 기존 트레이 시험은20pass/7fail/5skip이며 이번 메뉴 차이를 제거한 fixture에서도 동일 UI6건 실패가 남는다. 다른1건은 이번에 변경하지 않은 Tunnel owner 계약이다. 전체 PASS로 표시하지 않는다. 새 트레이에서 실제 모델 요청/수동 메뉴 클릭 E2E는 별도 미실행이며 앞선 두 경로 실추론과 구분한다.

2026-10-20: 관리형 CLI/Workspace 설치, 기존 App 도구 갱신, 실제 일반 Chat Native/OCX COMPLETED 확인. Job stdout 오염 수정과 nested alias binding을 적용했고 최종 설치본 일반 Chat E2E도 통과했다. source 전체 Windows gate의 공통 guidance/skill 범위 밖 4건은 별도 남으며 전체 PASS로 표시하지 않는다. 원 comm 재전송·모델 서비스 재시작0.

- [x] T-013: 트레이 내부 CLI 탭·OCX/Native 드롭다운으로 통합. 우클릭/도구 바로가기와 탭 입력 보존, DPI 글자 폭 적용. traybf3668efde6f5cb2 빌드·설치 및 exact 실행 관측, 내부 탭/입력5case·최종 전체 창 렌더 PASS. 이번 탭에서 실제 모델 요청 재검증 미실행. 영수증 verification/tray-cli-internal-tab/FINAL.json.

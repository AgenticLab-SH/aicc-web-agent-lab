# Independent Codex CLI routes intent

- ID: INT-INDEPENDENT-CODEX-CLI-ROUTES
- Status: accepted
- Owner: product owner
- Target: open-AICC Windows terminal TUI and CLI
- Supersedes: none

## Problem

Windows에서 OCX가 Codex의 단일 입구가 되면 OCX 장애가 Native Codex까지 멈추게 한다. 기존 문서는 두 경로의 독립성을 요구하지만 AICC 터미널 메뉴는 이를 명확히 구분하지 않고 Windows 전용 실행 검증도 빠져 있다.

## Evidence

- `context/PROJECT.md`와 `docs/agent-operations.md`는 Native 기본 경로와 선택형 OCX 경로를 별도 실패 영역으로 규정한다.
- 현재 TUI의 Codex 항목은 단순 `codex`이고 OCX 항목은 OCX 관리 도구라서 Codex CLI의 두 경로를 직접 고를 수 없다.
- 기존 route launcher 테스트는 Windows에서 POSIX wrapper 검증을 건너뛴다.

## Desired outcome

사용자는 같은 작업 폴더에서 Direct Native Codex CLI 또는 OCX 전용 Codex CLI를 명시적으로 선택해 열 수 있다. 어느 한 경로의 장애도 다른 경로의 자동 선택이나 중단 원인이 되지 않는다.

## Affected users and systems

- Users: Windows에서 AICC TUI와 터미널을 사용하는 로컬 소유자
- Systems: open-AICC CLI, TUI catalog, 공식 Codex CLI, 선택형 OCX 10100

## Constraints

- 전역 Codex 설정, 계정, Desktop, OCX 서비스와 integration을 자동 변경하지 않는다.
- OCX 장애 시 Native로 fallback하지 않는다.
- 실제 OCX 연결과 live canary는 이번 변경에 포함하지 않는다.
- GPT-5.5와 Fast/priority 모델 경로를 추가하지 않는다.

## Out of scope

- Codex Desktop UI에 provider selector 추가
- OCX 설치, 시작, 계정 전환, 인증, AICC integration 활성화
- Web GPT 17841/17842 경로 변경

## Success signals

- `aicc codex native`와 `aicc codex ocx`가 별도 명령으로 존재한다.
- AICC TUI가 두 명령을 이름과 장애 경계까지 구분해 표시한다.
- fixture에서 Native와 OCX endpoint가 다르고 전역 config가 불변임을 검증한다.
- OCX preflight 실패 시 공식 Codex 실행 파일이 호출되지 않는다.

## Open questions

None

## Decision

- Accepted by the product owner on 2026-09-08: implement and verify offline through final review, while keeping live OCX connection on HOLD.


## 2026-10-20 일반 Chat 접근 확장

사용자 요청: Desktop은 OCX를 유지하고 CLI는 Native와 OCX를 각각 지피티가 선택하여
사용할 수 있어야 한다. 기존 일반 Workspace exec의 격리 때문에 터미널 명령을 전달하는
것만으로 이 결과가 충족되지 않는다. 기존 두 route를 재사용하여 별도 기능을 준비한다.
원 실패 업무 재전송·격리 해제·계정/로그인/서비스 변경은 범위 밖이다. 이번 요청으로 소스
수정·가역 준비를 진행한다. 새 host 실행 권한의 exact binding·설치/게시 적용은 검토 가능한
후보에 대한 권한 승인과 기존 maintenance gate를 별도로 유지한다. live 검증을 자동 실행하지 않는다.
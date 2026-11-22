# Intent-driven development intent

- ID: INT-2026-09-intent-workflow
- Status: delivered
- Owner: AICC repository owner
- Target: AICC canonical guidance and the managed Codex home
- Supersedes: none

## Problem

AICC의 기존 프로젝트 명세 스킬은 구현 전 `SPEC.md` 작성을 요구하지만, 사용자가 왜 이 변화를 원하는지와 어떤 경계를 승인했는지를 별도 정본으로 남기지 않는다. 큰 변경에서 문제 정의와 구현 계획이 섞이고, 여러 저장소나 에이전트가 참여하면 목표가 복제되거나 달라질 수 있다.

## Evidence

- Anthropic의 AI-Native SDLC 가이드는 먼저 의도에 문제, 이유, 제약, 관련 사용자와 시스템, 열린 질문을 기록하고 승인된 의도에서 명세와 계획을 파생하도록 안내한다.
- AICC의 `develop-from-project-spec` 스킬은 `SPEC.md`, 계획, 작업, 검증의 연결은 제공하지만 독립적인 `intent.md` 수명주기와 검증은 제공하지 않았다.
- 사용자는 조사와 설계 후 AICC 및 Codex 홈에 이 흐름을 적용하라고 명시했다.

## Desired outcome

큰 변경은 하나의 짧고 승인된 `intent.md`에서 시작한다. 에이전트와 사용자는 무엇과 왜를 구현 방법과 구분하며, 명세·계획·작업·검증이 같은 의도를 추적한다. 작은 수정은 추가 문서 없이 빠르게 처리한다.

## Affected users and systems

- Users: AICC 저장소 소유자와 Codex에서 기능을 설계·구현하는 에이전트
- Systems: `C:\demo\open-AICC`의 guidance 정본, 검증 테스트, 관리형 `C:\demo\owner\.agents\skills`

## Constraints

- `guidance/`만 관리형 지침과 스킬의 정본이다.
- Codex 홈은 생성·배포 대상이며 직접 유지보수하는 정본이 아니다.
- 기존 사용자 수정, Claude 대상 목록, 별도 승인 경계는 바꾸지 않는다.
- 모든 intent를 자동으로 문맥에 넣거나 과거 작업을 소급 변환하지 않는다.

## Out of scope

- Claude 홈 배포와 Claude Code 자체 기능 변경
- 기존 기능 전체에 대한 intent 문서 소급 생성
- 승인 없이 외부 게시, 계정, 결제, 데이터 또는 권한 변경

## Success signals

- 활성 Codex 스킬이 큰 변경과 작은 수정의 intent 필요 여부를 구분한다.
- 정본 템플릿과 검사기가 intent 상태, 필수 내용, 저장소 내부 경로를 검증한다.
- 기능 spec은 정확히 하나의 source intent를 가리킬 수 있다.
- AICC 정본과 Codex 홈의 배포 파일 해시가 일치하고 guidance check가 통과한다.

## Open questions

None

## Decision

- 2026-09-06: 저장소 소유자가 조사·설계된 intent 흐름을 AICC와 Codex 홈에 적용하도록 명시하여 accepted로 결정했다.
- 2026-09-06: 공식 skill root 배포, 관련 검사와 전체 Windows 게이트를 통과해 delivered로 결정했다.

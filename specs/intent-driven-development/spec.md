# Intent-driven development specification

## Authority and document roles

- Owner/lifecycle/last reviewed: AICC repository owner, active, 2026-09-06
- Source intent: specs/intent-driven-development/intent.md
- This specification: intent 수명주기, 문서 역할, 검증, Codex 배포의 관찰 가능한 계약
- Related authoritative documents: root `SPEC.md`는 전체 제품 계약, `guidance/`는 관리형 지침과 스킬 정본, `context/PROJECT.md`는 현재/HOLD/다음 행동만 담당한다.
- Supersedes: none

## Outcome

Codex는 큰 변경을 구현하기 전에 하나의 승인된 intent를 확인하고, 그 intent에서 검증 가능한 명세와 실행 계획을 파생한다. 작은 수정은 불필요한 문서 생성 없이 기존 명세나 테스트로 처리한다.

## User value

- User/problem: 저장소 소유자는 여러 에이전트와 저장소 사이에서 목표와 구현 방법이 섞이거나 복제되는 일을 피해야 한다.
- Value promise: 무엇을 왜 만드는지 먼저 합의하고, 이후 요구사항과 구현 증거를 같은 목표에 연결한다.
- Success signal: 정본 스킬, 템플릿, 검사기, 테스트와 Codex 홈 배포본이 같은 계약을 제공한다.

## Scope

### In

- AICC 정본 `develop-from-project-spec` 스킬에 intent 선별, 승인, 문서 역할, 검증 흐름 추가
- `specs/<change>/intent.md` 템플릿과 정적 검사기
- 기능 spec과 source intent 연결 검사
- Codex 활성 스킬 목록과 관리형 홈 배포

### Out

- Claude 활성 스킬 목록과 홈 배포
- 모든 기존 프로젝트 또는 과거 변경의 문서 변환
- 애플리케이션 런타임 기능이나 외부 서비스 변경

### Later

- 반복 사용 결과가 쌓인 뒤 intent 상태를 표시하는 AICC UI가 필요하면 별도 intent로 검토한다.

## Requirements

- **FR-001** — 스킬은 새 기능, 교차 영역, 모호함, 위험, 다중 작성자 작업에는 intent를 만들고 작고 명확하며 되돌리기 쉬운 수정에는 생략하도록 구분해야 한다.
- **FR-002** — intent는 `draft`, `accepted`, `rejected`, `delivered`, `superseded` 중 하나의 상태와 문제, 근거, 결과, 사용자·시스템, 제약, 제외, 성공 신호, 열린 질문, 결정을 포함해야 한다.
- **FR-003** — 큰 구현은 소유자가 구체적인 intent를 검토할 수 있게 된 뒤 수락해야 한다. intent 초안 전에 한 포괄적 구현 요청은 초안과 되돌릴 수 있는 준비를 허용하지만 생성된 문서를 사후 수락한 것으로 보지 않는다.
- **FR-004** — 교차 저장소 작업은 하나의 조정 저장소만 intent 정본으로 선택하고 다른 저장소는 링크만 사용해야 한다.
- **FR-005** — 검사기는 저장소 밖 경로, 잘못된 상태, 누락된 내용, feature spec의 잘못된 source intent 연결을 실패시켜야 한다.
- **FR-006** — Codex 대상은 이 스킬을 활성 관리 대상으로 배포하고 AICC 정본과 홈 복사본의 파일 내용이 일치해야 한다.
- **FR-007** — 기존 사용자 수정과 Claude 대상 목록은 변경하지 않아야 한다.

## Scenarios

- **S-001 / large change:** 새 교차 영역 기능을 요청하면 Codex는 `specs/<change>/intent.md`를 작성·수락하고 연결된 spec과 계획을 만든 뒤 구현한다.
- **S-002 / small fix:** 기대 결과와 테스트가 명확한 작은 로컬 수정이면 Codex는 별도 intent를 만들지 않고 기존 명세 또는 테스트에 연결한다.
- **S-003 / invalid intent:** intent 상태나 필수 구역이 잘못되면 검사기는 비정상 종료하고 구체적인 실패 이유를 출력한다.
- **S-004 / cross-repository:** 여러 저장소가 참여해도 하나의 intent만 정본으로 유지하고 나머지는 그 경로를 참조한다.

## Quality and boundaries

- Accessibility/responsive/performance/compatibility: Markdown과 Python 3 표준 라이브러리만 사용하며 Windows PowerShell 배포 흐름에서 동작한다.
- Security/privacy/data: 검사기는 지정한 Git root 밖의 intent와 spec을 읽지 않는다. 문서에 비밀과 대화 원문을 저장하지 않는다.
- Recovery/external actions: 배포는 기존 AICC guidance plan/deploy/check 흐름을 사용하고 다른 활성 스킬이나 Claude 홈을 건드리지 않는다.

## Dependencies and risks

- Dependency/assumption: `guidance/`와 `agent-catalog.toml`이 관리형 스킬 정본이라는 계약은 guidance 테스트와 배포 도구로 확인한다.
- Risk/recovery: Codex 홈의 기존 비관리 스킬을 관리형 복사본으로 교체하므로 배포 전 계획을 확인하고 정본 Git diff와 배포 manifest로 변경 범위를 추적한다.

## UNKNOWN and HOLD

- None. 기존 `manage-naver-jobs-server` 설명 길이 위반을 고쳤고 전체 Windows 게이트가 통과했다.

## Acceptance evidence

| ID | Success criterion | Evidence |
| --- | --- | --- |
| **SC-001** | FR-001~FR-005의 문서·검사 계약이 정상/실패 fixture에서 통과한다. | `node --test test/develop-from-project-spec-skill.test.mjs` |
| **SC-002** | 실제 intent와 feature spec이 서로 연결된 상태로 검사된다. | `python guidance/skills/develop-from-project-spec/scripts/check_intent.py . specs/intent-driven-development/intent.md` 및 `python guidance/skills/develop-from-project-spec/scripts/check_project_spec.py . --spec specs/intent-driven-development/spec.md --intent specs/intent-driven-development/intent.md` |
| **SC-003** | Codex 홈 배포가 정본과 일치하고 관리형 guidance 상태가 정상이다. | 부분 배포 후 source/home SHA-256 비교와 `aicc guidance check --target codex` |
| **SC-004** | 저장소의 Windows 검증 게이트가 통과한다. | `npm run verify:windows` |

## Implementation outline

- Existing stack and boundaries to preserve: TOML catalog, Markdown skill 패키지, Python 표준 라이브러리 검사기, Node test, PowerShell guidance 배포 도구를 유지한다.
- Intended touchpoints: `guidance/config/agent-catalog.toml`, `guidance/skills/develop-from-project-spec/`, `test/develop-from-project-spec-skill.test.mjs`, `package.json`, `specs/intent-driven-development/`.
- Key decisions and rationale: intent는 큰 변경에만 사용하고 feature spec과 같은 폴더에 둔다. 전체 프로젝트 intent 자동 주입과 문서 복제를 금지해 문맥과 정본 충돌을 줄인다.
- Rollout/recovery: Codex 대상의 해당 스킬만 plan 후 배포한다. 문제 발생 시 정본 변경을 되돌리고 같은 제한 배포를 다시 실행한다.

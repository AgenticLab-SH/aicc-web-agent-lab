# <Project> 프로젝트 길잡이

상태: 프로젝트 전체 목적·구조·정본 라우팅 계약

이 문서는 세부 내용을 복제하지 않고 사람과 에이전트가 질문별 정본을 찾게 한다.

## 1. 목적과 비대상

- 목적: <이 프로젝트가 제공하는 결과>
- 비대상: <소유하지 않거나 분리하는 범위>
- 핵심 원칙: <한 문장>

## 2. 구조와 소유권

| 범위 | 정본 위치 | 소유하는 것 | 소유하지 않는 것 |
| --- | --- | --- | --- |
| <component> | `<path>` | <responsibility> | <boundary> |

## 3. 문서 지도

| 질문 | 정본 | 상태 유형 |
| --- | --- | --- |
| 지금 무엇이 되는가 | `<current-state>` | current snapshot |
| 어디로 가는가 | `<target-architecture>` | target |
| 왜 결정했는가 | `<adr>` | decision |
| 무엇을 다음에 하는가 | `<plan/progress>` | execution |
| 어떻게 운영·복구하는가 | `<runbook>` | operation |
| 무엇으로 증명하는가 | `<evidence>` | evidence |

## 4. 필드별 정본

| 필드 | 권위자 | mirror | write path | 충돌 정책 |
| --- | --- | --- | --- | --- |
| <field> | <source> | <mirror> | <path/API> | <policy> |

## 5. 변경·검증 계약

- 변경 전: <identity, dirty state, precondition, backup>
- 변경: <one failure domain and rollback unit>
- 검증: <source, test, runtime, user-visible>
- 실패: <HOLD/UNKNOWN, retry budget, rollback>

## 6. 에이전트 시작 절차

1. 가장 가까운 `AGENTS.md`, Git root와 dirty state를 확인한다.
2. 이 문서에서 대상 owner와 필요한 세부 정본만 고른다.
3. current와 target, field authority를 분리한다.
4. 변경한 계층을 검증하고 PASS/HOLD/UNKNOWN을 분리해 보고한다.

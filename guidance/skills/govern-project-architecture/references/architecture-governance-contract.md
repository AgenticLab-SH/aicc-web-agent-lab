# 프로젝트 아키텍처·문서 거버넌스 계약

## 목적

프로젝트 문서는 구현을 대신하는 보고서가 아니라 변경과 운영을 안전하게 만드는 탐색·권한 체계다.
좋은 구조는 사람과 에이전트가 같은 사실을 중복 생성하지 않고, 현재와 목표를 혼동하지 않으며,
변경 전 영향과 변경 후 증거를 찾게 한다.

## 세 가지 정합성

| 종류 | 질문 | 실패 예 |
| --- | --- | --- |
| 의미 정합성 | 같은 용어·상태·owner를 같은 뜻으로 쓰는가 | “완료”가 문서마다 source PASS 또는 live PASS를 다르게 뜻함 |
| 구조 정합성 | path, repo, package, runtime과 링크가 실제 경계와 맞는가 | 상위 workspace를 Git root로 설명하거나 생성본을 정본으로 지정 |
| 운영 정합성 | 문서의 명령·gate·복구가 실제 동작하는가 | listener 존재만으로 health PASS, stale command를 runbook에 유지 |

세 축 가운데 하나라도 확인하지 못하면 전체 정합성 PASS라고 하지 않는다.

## 문서 유형별 권한

| 유형 | 변경 빈도 | 권위 범위 | 금지 |
| --- | --- | --- | --- |
| Project Guide | 낮음 | 목적, 범위, 구조, owner, routing | live 상태·긴 이력 누적 |
| Current State | 높음 | 관측 시각이 있는 현재 판정 | 목표를 완료로 선언 |
| Target Architecture | 낮음 | 목표 구조와 원칙 | 실행 checkpoint 기록 |
| ADR | 사건별 | 결정, 근거, 대안, 대체 조건 | 매일 상태 로그 |
| Plan/Progress | 중간~높음 | 순서, dependency, gate, resume | 구조 결정의 유일 근거 |
| Domain Guide | 중간 | 한 component/interface의 설계 | 전체 프로젝트 owner 재정의 |
| Runbook | 운영 변경 시 | 명령, precondition, verify, rollback | 배경 설명 복제 |
| Evidence | 실행별 | 관측·test·hash·rollback 원본 | onboarding prose, secret |
| Private Ledger | 요청/결정별 | 사용자 문맥, 시도, HOLD | 공개 package, raw credential |

## 계층화 원칙

상위 문서는 “무엇과 어디”를, 하위 문서는 “어떻게”를 소유한다. 상위 문서가 상세 절차를 복제하면
두 정본이 생긴다. 하위 문서가 전체 프로젝트 목적을 다시 정의하면 scope 충돌이 생긴다.

링크는 권한 위임이다. 상위 문서에는 대상 문서의 상태 유형을 함께 표시해 current, target, plan을
혼동하지 않게 한다.

## Software/IT 구조 검사

### Context와 경계

- 사용자·외부 시스템·신뢰 경계
- control plane, data plane, management/interaction plane
- component, process, repository, package, deployment unit
- 장애가 함께 나는 failure domain과 독립 복구 경로

### 데이터와 인터페이스

- entity ID와 lifecycle
- field-level source of truth와 mirror
- API/protocol/schema/version owner
- sync 방향, conflict policy, idempotency와 eventual consistency
- secret, privacy, retention, deletion과 audit boundary

### 운영과 품질

- startup, liveness, readiness, active work와 drain
- observability, alert owner, retry budget와 quarantine
- backup, rollback, disaster recovery와 restoration proof
- 성능·용량·비용·가용성·보안 요구
- source test, integration, installed runtime, user-visible 검증의 분리

모든 프로젝트에 모든 절을 문서화할 필요는 없다. 실제 risk와 change coupling이 있는 항목만 남긴다.

## 필드 권한 예시

| 필드 | 권위자 | mirror | 충돌 처리 |
| --- | --- | --- | --- |
| source revision | Git | release manifest | exact hash가 다르면 drift |
| runtime health | owning service | dashboard | fresh observation 우선 |
| lifecycle/priority | planning system | local catalog | version mismatch면 write HOLD |
| deploy state | deployment provider | docs/dashboard | provider post-read 없으면 UNKNOWN |
| credential | secret/native store | availability flag only | 값 복제 금지 |
| agent instruction | nearest canonical AGENTS/guidance | generated home | 정본에서 재생성 |

## 변경 영향 규칙

한 사실이 바뀌면 그 사실을 소유하는 문서만 고치고, 상위 index는 link나 한 줄 상태가 실제로
영향받을 때만 수정한다.

- 구조 결정: ADR → target/project guide 영향 확인
- 구현 경로: source → domain guide/manifest 영향 확인
- live 상태: evidence → current/progress 영향 확인
- 운영 절차: tested command → runbook
- agent 반복 규칙: AGENTS 또는 skill; deterministic enforcement는 validator/hook

## Agent 적합성

- 첫 화면에서 purpose, owner, current, target, next action의 정본을 찾을 수 있어야 한다.
- path, provider, account, port를 문맥으로 추측하지 않고 registry/live evidence로 확인한다.
- 모든 문서를 읽는 대신 task별 route를 따른다.
- status vocabulary는 최소한 `PASS`, `PARTIAL`, `HOLD`, `BLOCKED`, `UNKNOWN`을 구분한다.
- 에이전트가 만든 문서도 source diff, link, command, runtime과 독립적으로 검증한다.
- active writer나 dirty worktree가 있으면 정합화를 이유로 정리·이동·reset하지 않는다.

## 충분 조건

다음 질문에 짧고 일관되게 답할 수 있으면 문서 체계는 충분하다.

1. 이 프로젝트는 무엇을 위해 존재하며 무엇을 소유하지 않는가?
2. 전체 구조와 독립 저장소·runtime·외부 시스템 경계는 어디인가?
3. 현재 사실, 목표, 결정, 실행 순서, 근거는 각각 어디에 있는가?
4. 같은 필드가 충돌할 때 무엇을 믿고 누가 수정하는가?
5. 변경 전 안전 조건과 변경 후 검증·rollback은 어디에 있는가?
6. 새 에이전트가 완료된 일을 반복하지 않고 정확한 checkpoint에서 시작할 수 있는가?

이 답을 위해 새 문서가 필요하지 않다면 만들지 않는다.

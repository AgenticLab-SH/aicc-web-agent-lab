---
name: govern-project-architecture
description: 프로젝트 목적·경계·소유자·목표 구조·문서·에이전트 진입을 정렬한다. 일반 기능 개발 제외.
---

# 프로젝트 아키텍처 정합화

목적·구조·정본·문서를 연결해 사람과 에이전트가 같은 소유자와 근거를 찾게 한다.

여러 프로젝트·경로의 문서 정렬·통합을 요청받으면
[문서 정렬·갱신 절차](references/document-ordering.md)를 읽는다.
기존 문서 표준과 원장을 재사용하고, 일반 오타 수정에는 이 절차를 적용하지 않는다.

## 시작 계약

1. 현재 경로, Git root, child repository, dirty state와 가장 가까운 `AGENTS.md`를 확인한다.
2. 기존 `README`, 문서 index, architecture/current-state/ADR/plan/runbook, manifest와 knowledge/evidence
   폴더를 먼저 찾는다. 생성된 파일이나 runtime cache를 정본으로 승격하지 않는다.
3. 사용자가 요청한 결과, 비대상, 변경 가능한 저장소, 검증과 rollback을 짧게 고정한다.
4. 여러 저장소나 인증·배포·DB·외부 SaaS 변경이 포함되면 대상·검증·복구 경계를 짧게 고정한다.
5. 장기·multi-writer 구현까지 요청됐다면 이 스킬로 문서·권한 계약을 확정한 뒤
   `run-evidence-gated-ai-development`에 넘긴다.

구조를 새로 정하거나 대규모로 정합화할 때는
[`references/architecture-governance-contract.md`](references/architecture-governance-contract.md)를
읽는다. 기존 문서가 이 계약을 이미 만족하면 새 파일을 만들지 않는다.

## 1. 현재 지도를 만든다

다음 네 지도를 분리해 기록한다.

| 지도 | 확인할 것 |
| --- | --- |
| Source | Git root, child repo, generated copy, package/release owner |
| Runtime | process, service, port, provider, deployed version, live evidence |
| Record | docs, plans, ADR, manifest, knowledge ledger, evidence, backup |
| Authority | 필드별 정본, 승인자, 외부 system, 인증·secret owner |

폴더 이름이나 README 주장만으로 소유권을 정하지 않는다. 가능한 경우 Git, manifest, 실행 명령과 live
관측을 대조한다. 확인하지 못한 사실은 `UNKNOWN`이다.

## 2. 현재와 목표를 분리한다

- current: 지금 설치·실행·검증된 사실과 관측 시각
- target: 도달하려는 구조와 비협상 원칙
- decision: 채택·기각·대체한 선택과 근거
- plan: target에 도달하는 순서, dependency, gate와 rollback
- evidence: 완료 주장을 검증하는 원본

target 문서의 항목을 current PASS로 해석하지 않는다. 과거 evidence를 현재 runtime 증거로 재사용할
때는 version, hash, owner와 영향 범위가 같은지 확인한다.

## 3. 필드별 정본을 정한다

하나의 시스템을 모든 정보의 master로 만들지 않는다. 예를 들어 Git은 코드와 revision, Notion은
lifecycle과 priority, runtime은 health, secret store는 credential을 각각 소유할 수 있다.

각 핵심 필드에 대해 다음을 표로 만든다.

```text
field | authoritative source | mirrors | write path | verification | conflict policy
```

두 정본이 같은 필드를 소유하지 않게 한다. 불가피하면 precedence, merge 규칙과 충돌 상태를 명시한다.

## 4. 최소 문서 계층을 선택한다

기존 파일명이 달라도 역할이 같으면 재사용한다.

1. `AGENTS.md`: 항상 자동 주입할 짧은 작업 규칙, 정본 경로, 안전 경계, 핵심 검증만 둔다.
2. Project Guide: 목적, 범위, 전체 구조, 소유권, 문서 지도와 충돌 해결을 둔다.
3. Documentation Map: 사람이 질문별 상세 문서를 찾는 얇은 index다.
4. Current State: 관측 시각이 있는 현재 snapshot이다.
5. Target Architecture: 목표 구조와 비협상 원칙이다.
6. ADR/Decision Log: 채택·기각된 중요한 결정과 대체 조건이다.
7. Domain Guides/Runbooks: 구성요소 설계와 실제 운영 절차다.
8. Plan/Progress: 실행 순서, gate와 checkpoint다.
9. Evidence: 테스트·runtime·rollback 원본이다.
10. Private Knowledge Ledger: 사용자 요청·결정·시도·HOLD이며 공개 산출물에서 제외한다.

Project Guide가 없고 기존 문서로 역할을 충족할 수 없을 때만
[`assets/PROJECT-GUIDE.template.md`](assets/PROJECT-GUIDE.template.md)를 복사해 프로젝트에 맞게 줄인다.

## 5. 에이전트 경로를 얇게 만든다

- 모든 작업에 필요한 규칙만 가장 가까운 `AGENTS.md`에 둔다.
- 긴 배경과 절차는 Project Guide나 세부 문서에 두고 `AGENTS.md`는 링크한다.
- 상위 규칙을 하위 `AGENTS.md`에 반복하지 않는다. 하위 파일은 실제 override만 가진다.
- root guide는 상세 내용을 복제하지 않고 질문→정본 routing과 authority만 소유한다.
- 문서가 길어질수록 한 agent가 무조건 전부 읽게 하지 않고 task별 reading route를 제공한다.

## 6. 최소 변경으로 정합화한다

1. 중복 문서보다 기존 정본 지정과 링크 수정을 우선한다.
2. rename/move가 링크, history, active writer에 미치는 영향을 확인한다. 위험하면 새 index와 호환 링크를
   먼저 두고 이동은 별도 batch로 남긴다.
3. dirty target file은 덮지 않는다. 새 파일 또는 겹치지 않는 작은 patch를 선택하고 사용자 변경을
   별도로 보존한다.
4. 코드 경로와 문서 주장이 다르면 권위 있는 구현을 먼저 검증하고 문서를 갱신한다. 의도된 target이
   아직 미구현이면 current와 target을 둘 다 보존한다.
5. secret, session, account DB, browser profile, raw personal data를 문서나 evidence에 넣지 않는다.

## 검토·검증과 결과

구조 정리를 마감할 때 [IT 실무 검토·검증·결과 형식](references/verification-and-results.md)을 읽는다. 현재/목표와 각 근거 단계를 분리하고 링크·고유 내용·dirty 보존을 확인한다.

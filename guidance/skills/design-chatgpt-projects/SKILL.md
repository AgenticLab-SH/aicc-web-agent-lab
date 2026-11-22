---
name: design-chatgpt-projects
description: 원격 생성 전 ChatGPT Projects를 설계·검토한다. 원격 변경은 하지 않는다.
---

# ChatGPT Project 설계

ChatGPT Project를 만들기 전에 반복 업무의 경계와 내부 구성을 설계하고 사람이 검토할 수 있는
후보안으로 만든다. 원격 생성·수정·공유·삭제와 registry 적용은 이 스킬의 범위가 아니다.

제품 기능을 단정하기 전에 OpenAI 공식 문서에서 현재의 Project 구성요소, memory, sharing, 파일 제한과
workspace 정책을 확인한다. 안정적인 설계 개념과 변할 수 있는 UI·plan 제한을 구분한다.

## Project를 먼저 정의한다

ChatGPT Project는 같은 목적의 여러 대화가 공통 Instructions, sources와 memory 경계 안에서 누적되는
장기 작업공간이다. 단순 폴더, 주제 태그, 한 번 쓰는 대화, 로컬 코드 저장소, 모든 사람에게 배포하는
Custom GPT와 같지 않다.

Project의 목적은 "무엇에 관해 말하는가"보다 다음 네 가지를 안정적으로 공유하는 데 있다.

1. 반복되는 결과와 완료 기준
2. 같은 응답 규칙과 품질 gate
3. 함께 참조해도 안전한 source와 대화 history
4. 같은 보존·공유·privacy 경계

정확한 구성 모델과 다른 ChatGPT 자산과의 차이는
[`references/concept-and-composition.md`](references/concept-and-composition.md)를 읽는다.

## 설계 절차

1. 사용자의 반복 업무를 결과물, 입력, 작업 방식, 검증, 민감도와 협업자로 나눈다.
2. 같은 Instructions와 source를 자연스럽게 공유하는 업무를 하나의 후보로 묶는다.
3. 다른 사실 정본, 대화 맥락, 접근권한 또는 품질 기준이 필요한 업무는 분리한다.
4. 각 후보에 이름, 논리 ID, 목적, 담당/비담당, 작업 모드, Instructions, source lifecycle,
   memory, sharing, canary와 registry 상태를 정의한다.
5. 로컬 지침·skill·plugin·connector가 있으면 행동 규칙, 공유-safe 지식, runtime 도구 중 어디에
   속하는지 분류하고 Project에서 존재하지 않는 도구를 쓸 수 있다고 가정하지 않는다.
6. 실제 사용자 요청 3개와 경계 밖 요청 2개로 후보를 dry-run한다.
7. 중복, 과대 범위, source 오염, 개인정보와 권리 문제를 검토한 뒤 포트폴리오를 제시한다.

분리·통합 기준과 검토표가 필요하면
[`references/portfolio-review.md`](references/portfolio-review.md)를 읽는다.
로컬 지침·skill·plugin·connector를 Project에 융합해 달라는 요청이면
[`references/local-capability-integration.md`](references/local-capability-integration.md)를 읽는다.

## 논리 ID와 이름

- 이름은 사용자가 작업을 시작할 때 고르는 목적을 짧게 표현한다.
- 논리 ID는 원격 stable ID와 분리된 영구 registry key다. `P01`, `PRJ-CAREER-WRITING`처럼
  중립적이고 설명 가능한 형식을 쓴다.
- `R`, `NEW`, `V4` 같은 redesign·migration 표시는 durable ID로 쓰지 않는다. 꼭 필요하면
  `legacyId`나 migration note로만 보존한다.
- 이름이 같아도 workspace가 다르면 physical Project는 다를 수 있다. logical Project 하나가
  shared binding과 replica binding 여러 개를 가질 수 있다.

## 최소 후보 산출물

각 Project를 다음 순서로 설명한다.

```text
이름 / 논리 ID
한 줄 목적
주요 사용 장면
담당하지 않는 일
Instructions의 핵심 동작과 품질 gate
BASE / ACTIVE / ARCHIVE / REJECT source
memory와 sharing 경계
개인정보·권리 disposition
retrieval canary와 합격 기준
분리·통합 판단
로컬 capability와 connector의 반영 방식
```

Instructions에는 역할 문구보다 목적, 사실 정본, 시작 절차, 출력 형식, 검증, 금지 행동과 handoff를
구체적으로 쓴다. sources는 많음이 아니라 관련성, 최신성, provenance, 권리와 retrieval 품질로 고른다.
대화에서 나온 결정이나 초안은 검토 없이 영구 source로 승격하지 않는다.

후보가 `portfolio-manifest.json`과 `source-set-plan.json` 계약을 사용하면
`scripts/validate_candidate.py --candidate <candidate-dir>`로 durable logical ID, topology, selector metadata,
Instructions 제한과 source hash를 read-only 검증한다. 이 검사는 원격 상태 검증을 대신하지 않는다.

## 승인과 handoff

- 후보 검토 중에는 ChatGPT 원격 자산이나 Notion lifecycle을 변경하지 않는다.
- 개인정보, credential-like literal, 제3자 자료의 업로드 권리, cross-workspace 배포가 불명확하면
  `HOLD`로 남긴다.
- 사용자가 포트폴리오와 source disposition을 승인한 뒤에만 `$manage-chatgpt-assets`로 넘겨
  discover, create, post-read, retrieval canary, share, register 순으로 적용한다.
- Custom GPT가 더 적합하다고 판단해도 이 스킬에서 만들지 않는다. 재사용 가능한 정적 전문가와
  조직 전체 배포가 핵심인지 별도 후보로 제안한다.

## 결과 형식

```text
Project 개념:
추천 포트폴리오:
각 Project 내부 구성:
KEEP / ADJUST / SPLIT / MERGE / DROP:
개인정보·권리 HOLD:
논리/physical topology:
원격 적용 전 승인 항목:
```

## 프로젝트 표시 이름

지피티(ChatGPT Web) 프로젝트는 `w-`, 로컬 코덱스(CLI·Desktop) 프로젝트는 `l-`을 앞에 붙인다. 예: `w-유튜브 스크립트 정리`, `l-trading-automation`. 이미 맞는 접두사가 있으면 유지하고 반대 접두사 하나는 교체하며 중첩하지 않는다. 이는 표시 이름 규칙이며 경로·저장소·논리 ID·원격 ID·route alias를 바꾸지 않는다.

대상별 stable ID·현재 이름·원하는 이름으로 명칭 변경 계획을 만들고 중복 이름을 먼저 해소한다. 이름만 바꿀 때 지침·소스·대화를 다시 작성하지 않는다. 제외 대상과 타인 소유 대상은 보존한다. 코덱스 프로젝트와 대화 제목을 혼동하지 않으며 지원되는 프로젝트 이름 변경 기능이 없으면 경로 변경이나 내부 DB 편집으로 대신하지 않는다.

## 현재 사용자 기본값

Web 새 프로젝트 이름은 `w-프로젝트 명`, memory는 `default`다. 기본 메모리는 Project 전용으로 자동 대체하지 않는다. Instructions는 목적·포함/제외·사실 정본·시작·출력·handoff를 담고 source는 BASE/ACTIVE/ARCHIVE/REJECT로 설계한다. 실제 생성·수정·삭제는 기존 manage-chatgpt-assets가 수행하며 양쪽 GitHub·Notion 백업은 manage-chatgpt-skills의 공통 asset lifecycle을 따른다.
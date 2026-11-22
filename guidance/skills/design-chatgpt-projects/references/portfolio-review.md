# ChatGPT Project 포트폴리오 검토

## 먼저 묶고 나누는 기준

다음이 모두 비슷하면 하나의 Project로 묶을 수 있다.

- 반복 산출물과 성공 기준
- Instructions의 작업 절차와 출력 형식
- 자주 함께 조회할 BASE/ACTIVE sources
- 누적해도 안전한 대화 context
- 접근권한, 보존, privacy와 workspace 경계

다음 중 하나라도 크게 다르면 분리를 우선 검토한다.

- 같은 질문에도 사실 정본이나 검증법이 다르다.
- 한쪽 대화가 다른 쪽 답변에 섞이면 품질이나 privacy가 나빠진다.
- source 교체 주기와 archive 기준이 다르다.
- 협업자 또는 workspace 배포 범위가 다르다.
- 위험 행동과 승인 기준이 다르다.
- 사용자가 시작할 때 어느 모드를 골라야 할지 자주 헷갈린다.

주제만 다르다는 이유로 자동 분리하지 않는다. 반대로 "개인", "업무", "학습" 같은 넓은 이름 아래
서로 다른 정본과 품질 gate를 한데 모으지 않는다.

## 공통 기능을 융합하는 방법

여러 Project가 한국어 교정, 시각 QA, 사실 잠금처럼 같은 기능을 필요로 해도 Project끼리 대화나 memory를
참조하게 만들지 않는다. 대신 작고 검증 가능한 capability source를 각 Project source set에 같은 hash로
배포하고 Instructions에서 적용 순서와 책임 범위를 다르게 고정한다.

- 공통 source: 사실 보존, 표현 QA처럼 도메인과 무관한 방법만 소유
- 도메인 Project: 내용 전략, 사실 정본, 완료 기준과 최종 승인 소유
- 독립 capability Project: 사용자가 범용 작업을 직접 시작할 진입점 소유
- handoff: 다른 Project의 memory를 읽었다고 가정하지 않고 필요한 입력을 사용자가 제공하도록 함

공통 기능이 도메인 사실까지 흡수하거나 독립 Project가 단순 alias에 그치면 융합 설계를 다시 나눈다.

## source를 구체화하는 최소 metadata

각 source 또는 selector에는 가능한 범위에서 `purpose`, `provenance/owner`, `BASE/ACTIVE 상태`, 적용 범위,
freshness/교체 조건, privacy·권리 disposition과 retrieval canary를 남긴다. 파일 수나 긴 원문을 구체성으로
오해하지 않는다. 한 source가 어떤 질문에 답해야 하고 어떤 질문에는 쓰이면 안 되는지가 분명해야 한다.

## Project별 검토표

각 항목을 `PASS`, `ADJUST`, `HOLD`로 판정한다.

| 축 | 질문 |
| --- | --- |
| Job | 반복해서 얻으려는 결과가 한 문장으로 명확한가? |
| Boundary | 담당/비담당과 이웃 Project handoff가 분명한가? |
| Instructions | 실제 작업 절차, 출력, 검증과 금지가 있는가? |
| Sources | BASE와 한 개의 ACTIVE set이 구분되는가? |
| Context | 이 Project의 대화가 함께 누적되어도 안전하고 유용한가? |
| Privacy | 공유 member가 모든 source와 chat을 봐도 되는가? |
| Rights | 업로드·재사용·cross-workspace 복제 권리가 확인됐는가? |
| Freshness | 변경되는 자료의 기준일, 교체와 archive 조건이 있는가? |
| Retrieval | source에만 있는 사실을 canary로 정확히 찾을 수 있는가? |
| Registry | logical ID와 physical binding, hash와 lifecycle이 분리됐는가? |
| Capability | 로컬 지침·skill·plugin이 행동 규칙, source 또는 runtime connector 중 올바른 층에 배치됐는가? |

## 포트폴리오 전체 검토표

1. 사용자의 상위 반복 업무를 빠뜨리지 않는다.
2. 두 Project가 같은 요청을 서로 담당한다고 주장하지 않는다.
3. 하나의 Project가 파일 한도를 채우기 위해 무관한 source를 묶지 않는다.
4. 모든 Project가 같은 개수의 source를 가질 필요는 없다.
5. 이름만 보고 올바른 시작점을 고를 수 있다.
6. 공통 방법론은 복제 가능한 build source로 관리하되 개인 사실은 최소화한다.
7. Business 공유와 Personal replica가 필요하면 배포 범위가 가장 넓은 쪽을 기준으로 privacy와 권리를
   검토한다.
8. 같은 이름의 remote가 이미 있거나 post-read가 불명확하면 자동 생성·재시도하지 않는다.
9. Codex 전용 skill이나 plugin 사용법을 ChatGPT Project source로 복사해 존재하지 않는 도구·권한을
   암시하지 않는다. 공통 판단법만 증류하고 실제 connector는 현재 workspace에서 검증한다.

## 판정

- `KEEP`: 경계와 내부 구성이 현재 요구에 적합하다.
- `ADJUST`: Project는 유지하되 이름, 범위, Instructions 또는 source를 고친다.
- `SPLIT`: 반복 업무가 서로 다른 context·정본·권한을 요구한다.
- `MERGE`: 두 Project의 요청, source와 품질 gate가 사실상 같고 분리 비용만 크다.
- `DROP`: 독립된 반복 업무가 아니거나 일반 대화/다른 system이 더 적합하다.
- `HOLD`: 구조는 타당하지만 privacy, 권리, identity 또는 remote evidence가 부족하다.

## dry-run 질문

각 Project마다 최소 다섯 개를 시험한다.

1. 대표 작업 1
2. 대표 작업 2
3. source retrieval이 필요한 작업
4. 이웃 Project가 담당해야 하는 요청
5. 승인 또는 개인정보 경계 때문에 거절·확인해야 하는 요청

정답뿐 아니라 어느 Instructions와 source를 사용했고 무엇을 사용하지 않았는지 확인한다.

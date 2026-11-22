# ChatGPT Project 개념과 내부 구성

## 제품 개념

ChatGPT Project는 장기간 반복되는 한 작업 영역을 위해 대화, Project Instructions, 업로드 또는 연결된
sources, memory와 도구 사용을 한 context 경계에 모으는 작업공간이다. 제품의 UI, plan별 파일 수,
sharing 방식과 memory 동작은 바뀔 수 있으므로 적용 직전에 OpenAI 공식 문서를 다시 확인한다.

공식 기준점:

- <https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt>

## 다른 자산과의 차이

| 대상 | 중심 | 적합한 경우 | 부적합한 경우 |
| --- | --- | --- | --- |
| 일반 대화 | 한 흐름의 질의·응답 | 일회성 질문, 짧은 탐색 | 여러 대화가 같은 source와 규칙을 계속 써야 함 |
| ChatGPT Project | 진화하는 작업 context | 장기·반복 업무, 관련 대화와 source 축적, 공동 작업 | 불특정 사용자가 여러 맥락에서 쓰는 고정 전문가 |
| Custom GPT | 재사용 가능한 맞춤형 ChatGPT | 정적 지식·도구·행동을 넓게 배포 | 특정 작업의 공동 history와 계속 변하는 context가 핵심 |
| 로컬 repository | 파일·코드 정본과 version history | 정확한 변경, test, review, release | 대화 context 자체를 정본으로 삼음 |

Project는 정본 저장소를 대체하지 않는다. 코드, 제출본, 일정, 고객 기록, credential과 lifecycle은 각각
권위 있는 외부 system을 유지하고 Project는 그 source를 이용하는 작업 표면으로 본다.

## 내부 구성의 8개 층

1. **Identity**: 논리 ID, 이름, 한 줄 목적, owner와 lifecycle.
2. **Boundary**: 담당하는 일, 담당하지 않는 일, 이웃 Project로 넘기는 기준.
3. **Instructions**: 목적, 사실 잠금, 작업 절차, 출력 형식, 검증과 금지 행동.
4. **Sources**: provenance와 hash가 있는 파일·붙여넣은 텍스트·지원되는 연결 source.
5. **Source lifecycle**: `BASE`, `ACTIVE`, `ARCHIVE`, `REJECT`와 교체 조건.
6. **Chats and memory**: 누적해도 되는 대화, project-only/default memory 선택과 삭제·이동 기준.
7. **Tools and access**: workspace 정책, collaborator 권한, 연결 앱, 외부 write 승인.
8. **Verification and registry**: Instructions/source hash, post-read, retrieval canary, remote binding과 상태.

## Instructions와 sources의 역할

Instructions는 "어떻게 일할 것인가"를 소유한다. source는 "무엇을 근거로 일할 것인가"를 소유한다.
개인 사실, 최신 수치, 교재 원문이나 제품 상태를 Instructions에 복제하지 않는다. 반대로 source 문서에
행동 규칙을 흩어 놓고 Instructions가 이를 암묵적으로 알아내리라 기대하지 않는다.

권장 source lifecycle:

- `BASE`: 오랫동안 유지되는 방법론, template, 검증 규칙
- `ACTIVE`: 현재 회사·과정·시험·저장소·과업에만 필요한 자료
- `ARCHIVE`: history 보존 대상이지만 현재 retrieval에서 제외할 자료
- `REJECT`: secret, 불필요한 원문, 권리 불명, 중복, 오래되거나 오염된 자료

## logical Project와 physical Project

논리 Project는 사람이 관리하는 하나의 업무 정의다. physical Project는 특정 account/workspace에 존재하는
원격 개체다. 동일한 Business workspace에서 owner Project를 member와 공유하면 logical 1개와 physical
1개다. 다른 Personal workspace에 같은 구성으로 만든 replica를 더하면 logical 1개, physical 2개가 된다.

동일성은 표시 순서나 계정 번호가 아니라 검증된 identity/workspace, logical ID, Instructions hash,
source-set hash와 task-owned remote binding으로 판단한다.

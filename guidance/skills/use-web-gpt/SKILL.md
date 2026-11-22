---
name: use-web-gpt
description: Ask exact ChatGPT Web for an authorized question or review.
---

# Web GPT 활용

사용자가 Web GPT 조사를 요청했거나, 현재 판단에 필요한 독립적 질문이 구체적으로 있을 때 사용한다. 웹사이트 수정·검증·배포라는 이유만으로 자동 호출하지 않는다. 답변은 참고 자료이며 실제 코드·운영 상태는 해당 환경에서 확인한다.

## 도구 이름

이 단계는 [상세 절차](references/execution-contract.md)의 같은 절을 읽고 수행한다.

## 기본 실행

1. 사용자가 surface를 지정하면 그대로 사용한다. 선택지는 `Codex Web GPT 앱`, `인앱 Browser`,
   `일반 Chrome GPT 확장`, private coordination에 등록된 CDP Chrome이다. 지정이 없으면 현재 작업에 결속된 기존 연결을 우선한다. 새 작업에서 선택한 경로는 명시하고 유지한다. 현재 로그인된
   **일반 Chrome GPT 확장**은 사용 가능한 선택지이며 필수 설치 조건이 아니다. 다른 surface로 조용히 바꾸지 않는다. registered CDP의 dormant
   launcher·없는 target·URL 준비는 `surface-selection.md`의 자동 기동 계약을 따른다.
   일반 Chrome 확장이 발견되지 않으면 같은 문서의 연결 진단을 따른다. CDP 포트 실패나 빈 provider
   인벤토리를 Chrome 종료·로그아웃으로 보고하지 않는다.
2. 사용자가 동시 탭 수 `N`을 지정하면 현재 root agent와 모든 하위 agent가 합쳐 최대 `N`개만
   연다. 지정이 없으면 root agent가 독립 작업 수, 목표의 긴급성, 예상 소요시간, 현재 browser·account·
   시스템 resource 상태를 보고 가장 작은 유효 병렬도를 정한다. 작업 중에도 관찰 결과에 따라 늘리거나
   줄일 수 있다. 선택한 예산 안에서는 독립 작업을 동시에 제출하고, 초과 역할은 탭이 반환될 때까지
   queue한다. agent마다 별도 고정 상한을 추가하지 않는다.
3. 한 대화에 결과 하나를 맡긴다. 목표, 직접 확인한 사실, 필요한 소스, 제약, 원하는 출력과
   미확인 항목만 보낸다. 저장소 전체·대화 원문·로컬 추론·비밀·세션 정보는 보내지 않는다.
4. prompt와 첨부를 먼저 준비해 같은 composer에 한 번에 넣고, identity·surface·ownership 확인이
   끝나는 즉시 제출한다. 인위적인 최소 전송 간격을 두지 않는다. 실제 429·capacity·security
   challenge가 관찰된 surface/account만 제품이 요구하는 시간 동안 쉰다.
5. 같은 질문을 반복하지 않는다. 결정·근거 URL·반례·미확인 항목만 회수하고 중요한 주장은 재검증한다.

## 정확한 응답 감시

이 단계는 [상세 절차](references/execution-contract.md)의 같은 절을 읽고 수행한다.

## 제출 권한

- 현재 사용자가 맡긴 Web GPT 작업은 ordinary Chat 생성과 관련 파일 첨부, 전송, 같은 대화의 후속 전송을 승인한다.
  agent는 작업 범위에서 `보내도 될까요?`를 묻거나 확인을 기다리지 않는다.
- identity·privacy·surface·소유권·중복만 조용히 확인하며 `WAIT_UNTIL` 재개에도 재승인을 묻지 않는다.
- 사용자가 `준비만`, `초안만`, `보내지 마`라고 명시한 경우에는 전송하지 않는다. click 뒤 결과가
  불확실하면 uncertain을 기록하고 자동 재전송하지 않은 채 기존 대화에서 제출 여부를 reconcile한다.
- 이 자율 권한은 맡긴 목적 범위의 ordinary Chat turn에만 적용한다. ChatGPT Project/Custom GPT
  생성·변경·공유, 계정·로그인·route 변경, publication 또는 삭제는 각각의 별도 변경 계약을 따른다.

## 계정·탭 소유권

이 단계는 [상세 절차](references/account-tab-ownership.md)를 읽고 수행한다.

## 조건부 참조

- 여러 파일·첨부·큰 handoff가 필요할 때만
  [`references/context-and-prompting.md`](references/context-and-prompting.md)를 읽는다.
- cadence gate의 상세 상태, route 상태·복구, identity 불일치, 기존 ChatGPT 대화 연결, 인앱 Browser,
  로컬 workspace 읽기·쓰기가 관련될 때만
  [`references/execution-contract.md`](references/execution-contract.md)를 읽는다.
- 사용자가 여러 Web GPT 또는 fan-out 조사를 명시한 경우에만
  [`references/multi-research.md`](references/multi-research.md)를 읽는다.

경로가 실패하면 원인을 보고하고 다른 계정·browser·provider로 조용히 우회하지 않는다.
사용자가 대체 포트·계정을 명시한 경우에는 surface-selection의 대체 경로 절차로 바로 이어가며
같은 연결 실패나 본문 복사 요청을 반복하지 않는다.

## 현재 Web 대화에서 직접 완수하기

이 단계는 [상세 절차](references/execution-contract.md)의 같은 절을 읽고 수행한다.

## 화면 사용 한도 안내

이 단계는 [상세 절차](references/execution-contract.md)의 같은 절을 읽고 수행한다.

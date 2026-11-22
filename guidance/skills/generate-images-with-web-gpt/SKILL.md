---
name: generate-images-with-web-gpt
description: 명시 요청 전용. 비트맵 생성·편집은 인증된 Web GPT를 먼저 쓰고 ImageGen 대체 경로를 판단한다.
---

# Web GPT 우선 이미지 생성

이미지 생성 경로와 프롬프트 품질을 함께 관리한다. 기존 `use-web-gpt`와 시스템
`imagegen`을 대체하지 않고 순서와 증거 기준만 조정한다.

## 실행 순서

1. 실제 레퍼런스와 사용 목적을 확인한다. 로컬 이미지는 직접 열어 보고, 파일명만으로
   스타일을 추측하지 않는다. 등록된 개인 디자인 라이브러리가 있으면
   `aicc guidance find manage-design-library`로 비등록 workflow를 찾아 `image`와
   `cross-media`를 먼저 검색하고, 용도에 따라 `web`,
   `presentation`, `motion` 태그를 확장한다. 선택한 시각 원리와 금지 요소를 프롬프트에
   명시하되 제3자 고유 자산이나 distinctive composition을 복제하지 않는다.
2. [프롬프트 계약](references/prompt-contract.md)에 따라 Codex Desktop에서 구체적인
   생성 프롬프트를 만든다. 이미 충분히 구체적인 요청에는 임의의 서사나 요소를 더하지
   않는다.
   로고·워드마크·브랜드 키트 요청이면 먼저 [로고 제작 계약](references/logo-workflow.md)을
   읽고 서로 다른 방향을 한 이미지에 합치지 않는다.
3. `use-web-gpt`를 불러 `chatgpt-web/temporary/*` route로 Web GPT에 프롬프트와 필요한
   최소 레퍼런스를 전달한다. 일반 작업은 high, 복잡한 시각 설계는 xhigh를 사용한다.
   Web GPT에 프롬프트 개선만 요청하지 말고 최종 이미지를 생성하도록 명시한다.
4. route 상태, 계정, pacing, 첨부 경계는 `use-web-gpt`의 실행 계약을 따른다. 실행 중인
   다른 turn, 로그인 문제, frozen connector, rate limit을 다른 브라우저나 계정으로
   조용히 우회하지 않는다.
5. Web GPT가 실제 이미지 결과를 반환하지 못하거나 현재 route가 이미지 출력을 지원하지
   않으면 그 상태를 기록하고 시스템 `imagegen`의 built-in 도구로 전환한다. 특히
   `visible text that could not be serialized as Markdown`처럼 ChatGPT에는 비텍스트 결과가
   보이지만 route가 회수하지 못한 오류는 같은 제출을 반복하지 않고 fallback한다. 이
   경로는 로그인된 Codex/ChatGPT 인증과 일반 Codex 사용량을 사용하므로
   `OPENAI_API_KEY`를 요구하지 않는다.
6. 현재 Desktop 또는 CLI가 17841 통합 브리지를 앞단으로 쓰는 환경에서는 일반 Codex
   모델명을 선택한 것만으로 Native 직결이라고 판단하지 않는다. 보존된 `codex-native`
   profile의 작은 read-only smoke를 먼저 통과시킨 뒤 그 profile 안에서 built-in
   `imagegen`을 실행한다. 활성 Desktop endpoint를 바꾸거나 재시작하지 않는다.
7. API/CLI 경로는 사용자가 명시적으로 API, CLI, 모델 제어 또는 대량 API 생성을
   요청했을 때만 사용한다. API 키를 채팅에 붙여 넣게 하지 않는다.

## 생성 계약

- 프롬프트를 `role → subject → composition → camera/view → material/light → palette → text →
  constraints → output size` 순서로 작성한다. 각 항목은 결과 화면에서 확인할 수 있는 표현을 쓴다.
- 웹 hero는 copy safe area, focal object, background depth, crop behavior를 지정한다. slide image는
  title/evidence 영역을 비워 두고 projector 대비를 지정한다. logo는 한 variant씩 geometry와
  lettering을 명시한다.
- 레퍼런스가 있으면 각 이미지의 역할을 `edit target`, `style reference`, `composition
  reference`, `supporting input`으로 구분한다.
- 서로 다른 시안은 한 장에 합치지 않고 각각 독립 생성한다.
- UI mock은 실제 제품 화면처럼 만들고 concept art, device bezel, 의미 없는 카드·지표,
  작은 글자와 잘린 콘텐츠를 피한다.
- 상표·영화 장면·캐릭터 레퍼런스는 색, 재질, 조명, 공간감, 모션 원리만 추출한다.
  공개 결과에는 타사 로고, 캐릭터, 슈트, 얼굴, 영화 프레임을 복제하지 않는다.
- 생성 결과는 subject, composition, text accuracy, constraints, reference fidelity를 직접
  확인한다. 수정은 한 번에 한 가지 변화만 요청하고 불변 조건을 다시 적는다.

## 결과와 저장

- 미리보기 작업은 결과 이미지를 대화에 표시한다.
- 프로젝트 자산은 선택된 결과를 프로젝트 내부의 명시적 경로로 복사한 뒤 소비 코드를
  갱신한다. 생성 홈이나 임시 경로만 참조하는 배포를 만들지 않는다.
- 최종 보고에 실제 사용 경로, 모델/effort, 최종 프롬프트, 저장 경로, 검증한 제약을
  구분해 적는다. Web GPT의 자기보고는 이미지 파일 검증을 대신하지 않는다.

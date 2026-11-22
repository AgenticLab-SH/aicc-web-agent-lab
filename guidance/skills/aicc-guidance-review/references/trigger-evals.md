# Skill trigger 평가

새 skill과 description 변경은 최소 다음 사례를 기록한다.

## Positive

- 사용자가 skill 이름을 명시한 경우
- description의 핵심 사용자 목표를 자연어로 요청한 경우
- 구체적인 대상 파일·surface가 달라도 같은 반복 workflow가 필요한 경우

## Near-miss negative

- 키워드는 겹치지만 다른 기존 skill이 정확히 소유하는 요청
- 네이티브 기능 또는 일반 코드 작업으로 충분한 요청
- 단순 조회·일회성 질문·routine deploy처럼 workflow 판단이 필요 없는 요청
- 위험 단어가 있지만 실제 고위험 변경은 아닌 요청

## 충돌 검토

1. active AICC guidance, system, installed plugin skill의 name과 description을 현재 상태에서
   수집한다. cache만 있는 plugin은 제외한다.
2. 후보 description의 각 동사를 기존 description과 비교한다.
3. 겹치는 요청마다 어느 skill이 선택되어야 하는지 한 문장 경계를 쓴다.
4. 두 skill이 동시에 필요하면 순서와 handoff를 명시한다.
5. false positive가 넓으면 description과 적용 범위를 먼저 좁힌다. 새 스킬은 기본 자동 발견을
   유지하며 사용자가 명시 전용을 요청했을 때만 `policy.allow_implicit_invocation: false`로 바꾼다.
   기존 호출 정책은 별도 변경 요청 없이 뒤집지 않는다.

## 2026-10-05 소유 지침 정상화 경계 검토

| 요청 | 선택·행동 경계 |
| --- | --- |
| 네이티브 앱의 버튼 조작 | `cua-driver`의 짧은 진입점과 해당 플랫폼 계약만 읽는다. |
| 웹 로그인·파일 수정·단일 저장소 구현 | 브라우저·파일·실행 도구를 사용하며 네이티브 매뉴얼·새 채팅을 자동으로 열지 않는다. |
| 기존 여러 작업 조율 | controller를 유지한다. 위임은 승인된 경우에만, 새 사용자 대화 생성은 명시 요청 때만 수행한다. |
| 완료 후 정리·유휴 상태 확인 | 보관을 자동 추론하지 않는다. 기존 보호·유지 요청과 명시 보관 승인을 따른다. |
| 작은 가역적 문서 수정·이미 승인한 배포 | `high-risk-change`나 사용자 알림을 범용 재승인 절차로 쓰지 않는다. 변경 영역만 검증한다. |
| `blocked by policy`만 반환 | 관찰된 도구 거부로 기록한다. 실제 별도 검토 결정 없이 자동 검토 거부로 단정하지 않는다. |

이는 의미 경계 검토이며 새 세션의 실제 자동 호출률 측정은 아니다.

## `aicc-guidance-review` 호출 사례

Positive:

- "두 브라우저 스킬을 합쳐야 하는지 AICC 지침 변경 검토를 해줘."
- "이 규칙을 AGENTS, config, validator 중 어디에 둘지 감사해줘."
- "새 skill description이 기존 plugin skill과 충돌하는지 검토해줘."

Negative:

- "이 Python 버그를 고쳐줘."
- "어느 브라우저 계정을 사용할지 골라줘."
- "현재 active skill을 그대로 배포해줘."
- "OpenAI 문서에서 업로드 제한만 찾아줘."
- "Web GPT에 이 파일을 보내 검토해줘."

## `establish-design-direction` 예시

Positive:

- "oh-my-design에서 우리 대시보드에 맞는 방향을 시각적으로 골라 DESIGN.md로 남겨줘."
- "이 제품의 브랜드 보이스, UI 토큰, anti-reference를 먼저 정하자."
- "기존 화면은 유지하면서 덜 평범하게 만들 디자인 방향을 비교해줘."
- "내 원본 디자인 레포 중 이 웹에 맞는 것만 골라 세련된 방향과 근거를 정해줘."
- "웹, 발표자료, 다이어그램, 로고가 한 브랜드로 보이게 공통 방향을 먼저 잡아줘."

Near-miss negative:

- "이 버튼 컴포넌트의 TypeScript 오류를 고쳐줘." -> `codex-frontend`
- "이 확정된 mockup을 그대로 React로 구현해줘." -> Product Design image-to-code 또는 `codex-frontend`
- "아키텍처를 SVG 다이어그램으로 만들어줘." -> `diagram-design`
- "이 로고 이미지를 수정해줘." -> image generation workflow
- "이 PPTX의 3페이지를 고쳐줘." -> native Presentations workflow
- "저장된 디자인 원본의 최신 커밋만 확인해줘." -> AICC design-source monitor

Handoff:

- 방향 선택과 `DESIGN.md`까지 `establish-design-direction`이 소유하고, 구현·이미지·다이어그램·
  슬라이드 제작은 각 전문 skill로 넘긴다.
- owner-local 원본 저장·scan·정확한 revision 전환은 AICC design-source manager가 소유하고,
  `establish-design-direction`은 활성 원본 가운데 과업에 맞는 1–3개와 읽을 경로를 선택한다.
- 이미 확정된 `DESIGN.md`가 있고 사용자가 방향 재검토를 요청하지 않으면 이 skill을
  끼워 넣지 않는다.

## `manage-design-library` 예시

Positive:

- "이 디자인 가이드 파일을 내 라이브러리에 알아서 분류해 넣어줘."
- "내가 모아둔 웹 디자인 중 대시보드에 어울리는 것을 찾아줘."
- "디자인 수신함을 정리하고 중복 자료를 알려줘."
- "내가 모아둔 디자인을 활용해서 발표자료와 보고서의 방향을 잡아줘."

Near-miss negative:

- "이 프로젝트의 DESIGN.md를 새로 정해줘." -> `establish-design-direction`
- "이 PPTX 3페이지를 수정해줘." -> native Presentations workflow
- "이 이미지를 생성해줘." -> image generation workflow
- "외부 GitHub 스킬을 AICC에 흡수해줘." -> `aicc-guidance-review`

Handoff:

- 개인 원본 수집·검색은 `manage-design-library`, 프로젝트 결정문 생성은
  `establish-design-direction`, 실제 산출물 생성은 각 전문 workflow가 소유한다.
- 시각적으로 중요한 새 산출물은 요청에 라이브러리가 명시되지 않아도 먼저 관련 주 분류와
  `cross-media`를 검색하고, 1–3개 레퍼런스의 원리만 전문 workflow에 넘긴다.
- 공개 AICC에는 분류 절차만 두고, 개인 원본과 절대 경로는 owner-local registry와
  비공개 라이브러리에 둔다.

## `run-evidence-gated-ai-development` 예시

Positive:

- "여러 에이전트가 나눠 구현할 이 기능을 명세부터 검증 증거까지 통제해줘."
- "오래 걸리는 구현을 재개 가능한 체크포인트와 acceptance criteria로 운영해줘."
- "여러 writer가 맡은 결과를 한 증거 사슬로 통합해줘."

Near-miss negative:

- "이 함수의 오타 하나를 고쳐줘." -> 일반 코드 수정과 가까운 테스트
- "이 코드가 무슨 뜻인지 설명해줘." -> 일반 설명
- "인증 스키마를 바꿔줘." -> `high-risk-change`; 장기·multi-writer 운영이 실제로 필요할 때만 함께 사용
- "새 결제 기능의 목적과 요구사항부터 정리해줘." -> `develop-from-project-spec`
- "완료한 프로젝트에서 무엇을 배웠는지 적어줘." -> `capture-learning-evidence`

Handoff:

- 인증·인가·결제·보안·DB migration·infrastructure·large refactor·multi-writer 변경은
  `high-risk-change`의 짧은 실행·복구 계약을 자동 적용한다.
- 목표·요구사항은 `develop-from-project-spec`, 복구가 비싼 mutation은 `high-risk-change`가
  소유한다. 이 스킬은 장기·multi-writer 실행 checkpoint, 피드백과 증거 사슬만 소유한다.
- 학습 기록은 `capture-learning-evidence`로 넘긴다.

## `high-risk-change` 예시

Positive:

- "인증 스키마와 세션 migration을 실제로 바꿔줘."
- "결제 webhook과 정산 DB를 무중단으로 전환해줘."
- "다른 작업자도 편집 중인 공용 인프라 설정을 리팩터링해줘."

Near-miss negative:

- "인증 코드가 어떻게 동작하는지 설명해줘." -> 읽기 전용 설명
- "이 결제 PR을 리뷰해줘." -> 실행 mutation 없는 검토
- "테스트 하나를 고치고 실행해줘." -> 일반 국소 수정
- "배포 명령이 무엇인지 알려줘." -> 실행하지 않는 사용법 안내

Handoff:

- 실제로 되돌리기 비싼 mutation을 수행할 때만 최대 네 항목의 실행·복구 계약을 먼저 고정한다.
- 별도 계획 문서, 장기 진행 UI, 범용 체크리스트는 이 스킬의 책임이 아니다.

## `capture-learning-evidence` 예시

Positive:

- "이 과제의 코드와 실행 결과를 보고 내가 실제로 배운 점을 자연스럽게 기록해줘."
- "프로젝트 결과를 포트폴리오 후보로 올려도 되는지 근거로 판단해줘."
- "예상, 오류, 수정과 재검증이 드러나도록 학습 노트를 개선해줘."

Near-miss negative:

- "이 폴더를 Obsidian 지식 볼트로 정리해줘." -> `maintain-llm-wiki`
- "완료 파일을 전부 인덱스에 자동 추가해줘." -> 일반 deterministic script; 의미·성과 판정 아님
- "이 PDF를 요약해줘." -> 문서 읽기 또는 요약
- "이 기능을 구현하고 테스트해줘." -> 일반 구현; 장기·multi-writer 실행일 때만 `run-evidence-gated-ai-development`
- "YOLO로 알아서 끝내고 정말 필요할 때만 나를 불러." -> `run-evidence-gated-ai-development` -> 필요할 때만 `notify-user`

Handoff:

- 이 스킬은 학습과 성취의 의미 판정을 소유하고, 대상 저장소의 인덱스·상태·validator는
  가장 가까운 프로젝트 어댑터와 지침을 따른다.
- 일반 지식의 구조화·출처 갱신은 `maintain-llm-wiki`, 장기·multi-writer 구현의 증거 사슬은
  `run-evidence-gated-ai-development`가 소유한다.

## `review-agent-platform-updates` 예시

이 skill은 `policy.allow_implicit_invocation: false`이므로 다음 Positive 요청도 사용자가 최신 수집·비교를
명시한 경우에만 실행한다.

Positive:

- "OpenAI와 Anthropic의 최신 에이전트 문서를 다시 수집해서 우리 로컬 기준과 비교해줘."
- "$review-agent-platform-updates로 이번 Codex와 Claude Code 업데이트의 개선점을 찾아줘."
- "지난 로컬 기준 이후 공식 기술 블로그가 바뀐 내용을 점검해줘."

Near-miss negative:

- "Codex 앱 MCP가 무엇인지 설명해줘." -> 공식 문서의 일회성 조회
- "이 저장소의 스킬을 정리해줘." -> `aicc-guidance-review`
- "OpenAI API 사용법을 알려줘." -> `openai-docs`
- "공식 문서를 매일 자동 수집해줘." -> 이 skill의 명시 호출 전용·무예약 경계와 충돌

Handoff:

- 이 skill은 공식 자료 수집, 로컬 baseline 비교와 개선 후보 문서화까지만 소유한다.
- guidance·runtime·plugin·MCP 변경은 별도 작업으로 넘기며 고위험 mutation이면 `high-risk-change`를
  먼저 적용한다.

# Trigger 경계

## Positive

- “프로젝트 전체 목적과 구조, 정본 문서 계층을 하나로 정리해줘.”
- “README, AGENTS, docs, plans가 서로 모순되는지 감사하고 길잡이를 만들어줘.”
- “새 에이전트가 이 저장소에서 무엇을 먼저 읽고 무엇을 믿어야 하는지 규정해줘.”
- “현재 구조와 목표 구조를 분리하고 repository·runtime owner를 정합화해줘.”
- “여러 독립 저장소와 Notion 문서의 source of truth를 필드별로 정해줘.”

## Near-miss negative

- “이 시스템 아키텍처를 SVG로 그려줘.” → `diagram-design`
- “이 기능을 구현하고 테스트해줘.” → 일반 구현; 장기·multi-writer 실행이면 `run-evidence-gated-ai-development`
- “이 README의 오타를 고쳐줘.” → 일반 문서 편집
- “이 규칙을 AGENTS, skill, plugin 중 어디에 둘지 검토해줘.” → `aicc-guidance-review`
- “프로젝트 폴더를 Obsidian Wiki로 옮겨줘.” → `maintain-llm-wiki`
- “인증 DB migration을 해줘.” → 일반 구현과 네이티브 안전 경계

## Handoff

- 이 스킬은 purpose, boundary, authority와 문서 체계를 확정한다.
- 구조도를 시각 산출물로 만드는 일은 `diagram-design`이 소유한다.
- AICC guidance 생태계에 새 skill을 배치·병합·retire하는 판단은 `aicc-guidance-review`가 소유하고,
  skill 파일 생성은 `skill-creator`를 함께 사용한다.
- 장기·multi-writer 구현의 checkpoint와 증거 사슬은 `run-evidence-gated-ai-development`가 소유한다.

`architecture` 단어만으로 implicit trigger하지 않는다. project-wide purpose, structure,
source-of-truth, document hierarchy 또는 agent routing 가운데 둘 이상을 함께 정합화하는 요청이어야 한다.

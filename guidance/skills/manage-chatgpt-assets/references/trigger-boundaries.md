# Trigger 경계

## Positive

- “세 ChatGPT 계정의 Project/GPT를 같은 정본으로 동기화해줘.”
- “현재 계정에 남은 오래된 Project를 점검하고 삭제 후보를 승인받아 정리해줘.”
- “Custom GPT의 이름·지침·지식 파일 목록을 가져와 Project에 흡수해줘.”
- “ChatGPT Project의 Instructions나 Source를 안전하게 수정하거나 새로 만들어줘.”
- “UI나 계정 순서가 바뀌어도 stable ID 기준으로 자산 자동화를 해줘.”
- “새 Project 구성을 설계하고 Notion에 Candidate로 등록한 뒤 승인 후 세 계정에 적용해줘.”
- “원격 Project를 내리고 대화를 보존한 다음 registry를 재설계 대기로 맞춰줘.”

- “기존 대화를 빠짐없이 새 프로젝트로 옮기고 빈 프로젝트를 정리해줘.”

## Near-miss negative

- 일반 ChatGPT 대화를 요약·답변 → 일반 대화 작업
- Web GPT 모델로 리뷰 또는 연구 → `use-web-gpt`
- Web GPT route/port/runtime 교체 → `manage-codex-model-routes`
- 로컬 웹 페이지 QA → `browser-qa`
- Notion 대화 캡처만 요청 → Notion knowledge capture

## Handoff

- 원격 Project/GPT discovery와 mutation은 private ChatGPT adapter가 소유한다.
- public AICC는 정책, broker, guidance와 audit contract를 소유한다.
- Notion connector는 lifecycle/registry mirror만 소유한다.
- 문서·지식을 재사용 가능한 원문으로 증류하는 일은 `maintain-llm-wiki` 또는 대화 증류 스킬로 넘긴다.

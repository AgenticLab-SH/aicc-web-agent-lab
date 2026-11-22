# 2026-09-06 OpenAI·Anthropic 에이전트 정합화

## 범위와 공식 source

- OpenAI GPT-6 Astra 최신 모델 가이드: https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra
- OpenAI Codex sandboxing: https://learn.chatgpt.com/docs/sandboxing
- OpenAI Codex skills: https://learn.chatgpt.com/docs/build-skills
- Anthropic Claude Code 기능 개요: https://code.claude.com/docs/en/features-overview
- Anthropic Academy Capture intent: https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent
- 확인일: 2026-09-06 (Asia/Seoul)

## 공식 사실과 이전 기준 대비 변경

- Astra 가이드는 사용자 지시가 skill 지침보다 우선하고, 위임과 테스트를 작업에 비례해 설계하도록 한다. 공통 지침에 이 순서를 명시했다.
- 현재 Codex 사용자 skill 위치는 `$HOME/.agents/skills`다. 기존 `.codex/skills` 관리형 배포는 legacy migration 입력으로만 남겼다.
- 현재 낮은 위험의 로컬 자동화 preset은 `workspace-write`와 `on-request`다. 예전 baseline의 `read-only` 기록을 현행 값으로 고쳤다.
- Claude의 `intent`는 단순 작업 일지가 아니라 큰 변경의 문제·이유·경계·성공을 spec과 plan보다 먼저 합의하는 문서다.
- CLAUDE.md, skill, MCP, subagent, hook, plugin은 대체 관계가 아니다. 지속 지침, 필요 시 절차, 외부 연결, 격리 실행, 결정적 이벤트, 배포 묶음이라는 서로 다른 책임을 유지한다.

## 로컬 적용과 증거

- `guidance/directives/fragments/common.md`: 사용자/skill 우선순위, 비례 검증, 경계형 위임을 2 KiB 전역 예산 안에 반영했다.
- `develop-from-project-spec`: 구체적인 intent가 검토 가능해진 뒤에만 수락하고, 작은 명시 수정은 생략하며, intent/spec → 구현 → 위험 통제 → 검증 순서로 조합한다.
- Korean guidance search: 큰 교차 변경은 intent skill을 찾고 한 글자 수정은 약한 본문 일치로 unrelated skill을 반환하지 않는다.
- Knowledge Review: canonical 최신 모델 페이지를 전담하는 `openai-latest-model-guide`와 `anthropic-academy-sdlc`를 exact host/path source로 추가했다. 실행 `knowledge-65a1d94791d87cba36f96aab`은 최신 모델 페이지를 수집했고 post-read에서 GPT-6 Astra·검증·지침 우선순위 구역을 확인했다. 실행 `knowledge-a434efd8c94a14487adc7b20`은 Academy 15페이지와 OpenAI developer checkpoint 508개를 오류 없이 확인했다. 두 실행 모두 candidate/promotion은 0이었다.
- crawler는 내부 오류를 안전한 diagnostic ID로 식별하고, 알려진 페이지의 80% 이상이 바뀌면 bulk review 신호를 낸다.
- plugin status는 필수 11개, 허용 추가 10개, disabled, feature drift, 계정 연결 미관찰을 분리한다. plugin·계정·MCP 상태는 바꾸지 않았다.
- 관리형 Codex skill 15개를 `.agents/skills`로 옮겼다. manifest 소유·해시가 확인된 legacy 사본만 제거했고 사용자 소유 legacy skill은 보존했다. fresh App Server 목록은 36개, 관리형 누락 0, 중복 0, 오류 0이다.
- Codex 사용자 기본은 `workspace-write`/`on-request`/user reviewer다. 변경 전 값과 복구 명령은 owner-only recovery receipt `codex-permissions-20260906T025101+0900.json`에 있다.

## 판단

- 유지: 짧은 AGENTS/CLAUDE, active/cold skill 분리, exact-source 수동 검토, 별도 high-risk recovery 계약.
- 개선 완료: intent 수락 규칙, 한국어 검색, source 범위와 crawler 진단, plugin 보고, 공식 skill root, 권한 기본값, 설명 예산과 Windows 검증 blocker.
- 의도적 미적용: 전역 intent hook, 자동 source 승격, 반복 scheduler, plugin 제거, 계정·route·MCP 재구성. 이들은 의미 판단 또는 별도 외부 상태를 바꾸므로 이번 정합화 범위가 아니다.
- 남은 UNKNOWN: 현재 task처럼 host override가 사용자 기본과 다른 경우의 effective permission 표시는 아직 모든 surface에서 통합되지 않았다.

## 검증

- 집중 계약 테스트 52/52 통과.
- guidance deploy/check 통과: 15개 관리형 skill, deployment/manifest/size/duplicate issue 0.
- intent와 feature spec validator 통과.
- Knowledge Review latest run completed, stale source 0, automatic apply false.
- `npm run verify:windows` 전체 게이트 통과.

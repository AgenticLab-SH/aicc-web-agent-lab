---
name: review-agent-platform-updates
description: 요청·노후화·신호에 따라 OpenAI/Anthropic 공식 변경을 검토한다. 예약·자동 승격 금지.
---

# 에이전트 플랫폼 최신 검토

사용자가 최신 공식 자료의 **수집과 로컬 비교**를 명시했거나 `$review-agent-platform-updates`를
호출했을 때 실행한다. Codex/AICC 관련 작업에 진입할 때도 status만 먼저 읽고, exact affected source의
마지막 성공이 7일을 **초과**했거나 이미 관찰된 중요 공식 changelog 신호가 있을 때만 한 번 실행한다.
일반 질문, 무관한 routine coding과 상시 예약 실행에는 사용하지 않는다.

## 절차

1. AICC source root의 `docs/agent-engineering-direction.md`, `docs/agent-platform-baseline.md`,
   `docs/knowledge-review.md`를 읽는다. 현재 task가 다른 저장소라면 `aicc` 실행 파일의 real path에서
   AICC root를 찾거나 script에 `--aicc-root`를 준다.
2. 요청 범위를 최소 source로 매핑한다.
   - OpenAI API·SDK·agent: `openai-developers`
   - 현재 최신 모델 가이드와 모델별 선택 내용: `openai-latest-model-guide`
   - ChatGPT·Codex 제품 문서: `openai-chatgpt`
   - OpenAI 개발 기술 글: `openai-developer-blog`
   - OpenAI 일반 제품 변경 신호: `openai-news`
   - Anthropic API·agent: `anthropic-platform`
   - Claude Code: `anthropic-claude-code`
   - Claude Academy AI-Native SDLC intent/spec/plan: `anthropic-academy-sdlc`
   - Claude 제품·개발 글: `anthropic-claude-blog`
   - Anthropic 엔지니어링 글: `anthropic-engineering`
3. `node scripts/knowledge-review.mjs status`만 먼저 실행한다.
   - 명시 요청이면 요청한 exact source를 한 번 갱신 대상으로 삼는다.
   - Codex/AICC 작업 진입이면 `sources[].freshness`를 보고 마지막 성공이 7일을 초과한 source와 중요
     changelog 신호의 exact affected source만 대상으로 삼는다. 모두 current면 preview와 run 없이 끝낸다.
   - partial/failed run은 성공한 source checkpoint만 최신으로 인정한다. 실패 source의 마지막 성공은
     바꾸지 않고 다음 eligible trigger에서 그 source만 다시 판단한다. 다른 성공 source를 함께 반복하지 않는다.
4. 대상이 있을 때만 `preview --source <id>...` 뒤 `run --confirmed --source <id>...`를 한 번 실행한다.
   `--confirmed`는 위 두 bounded trigger 중 하나를 확인했다는 뜻이다. Windows runner는 필요한 경우
   hidden Dashboard와 one-shot local scheduler를 요청 수명 동안만 소유하고 완료 뒤 종료한다.
5. run manifest의 outcome, changed URLs, `bulkChangeSignal`과 HOLD/error를 확인한다. 관련 공식 페이지는 공식 host에서
   직접 읽고, 날짜가 변할 수 있는 사실은 반드시 현재 자료로 재검증한다. 비공식 글·검색 snippet을
   사실의 정본으로 쓰지 않는다.
6. `docs/agent-platform-reviews/YYYY-MM-DD-<scope>.md`에 범위, 공식 사실, 이전 baseline과의 delta,
   로컬 증거, 개선 후보, 미적용 이유를 기록한다. 변경이 확인된 기준만 baseline에 반영한다.
7. 결론에는 `유지 / 개선 / 폐기 / HOLD`와 우선순위를 붙이고 test·post-read·URL을 연결한다.

## 경계

- 상시 자동화나 scheduler를 만들지 않는다. 한 번의 eligible trigger는 한 번의 bounded review만 허용한다.
- 외부 원문, credential, cookie, browser profile과 대화 원장을 저장소 문서에 넣지 않는다.
- Knowledge Review의 owner-only object·cursor·manifest 이외의 runtime을 수집 단계에서 바꾸지 않는다.
- source, guidance, plugin, MCP, permission과 runtime 개선을 자동 적용하지 않는다. 별도 변경 요청으로
  넘기고 고위험 mutation이면 `$high-risk-change` 계약을 먼저 적용한다.
- 공식 source가 실패하면 최신이라고 추정하지 말고 `HOLD`와 마지막 성공 시각을 명시한다.
- `source_internal_error`는 원문 대신 `diagnosticId`로 같은 실패를 식별한다. 진단 ID가 반복되면 fixture에서 재현해 고치며 stack, 경로, 응답 본문을 보고서에 복사하지 않는다.

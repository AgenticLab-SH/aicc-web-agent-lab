# 2026-08-30 OpenAI·Anthropic 에이전트 플랫폼 검토

## 범위와 수집

- 범위: OpenAI/Codex와 Anthropic/Claude의 공식 문서·개발 블로그, 로컬 skill/plugin/MCP/hook/config
- 핵심 검증: 공식 URL 13개 HTTP 200, 묶음 SHA-256
  `2a6ee01a201b5101998f85c6e99d5e60dc3e2282809d63a87c097f39685e1ec0`
- 증분 job: `knowledge-382546dc67c08eba767cabf8`
- source: `openai-developers`, `openai-chatgpt`, `openai-developer-blog`, `openai-news`,
  `anthropic-platform`, `anthropic-claude-code`, `anthropic-claude-blog`, `anthropic-engineering`
- 경계: manual-only, automatic promotion 0, 원문은 owner-only content-addressed storage
- 결과: 7 source `completed`, `openai-chatgpt`만 1개 문서가 기존 2 MiB 상한을 92,101 bytes 넘어
  `partial`; candidate 0, promotion 0, source/guidance mutation 0

## 공식 사실과 채택

| 판단 | 공식 사실 | 로컬 적용 |
| --- | --- | --- |
| 유지 | [Build skills](https://learn.chatgpt.com/docs/build-skills)는 progressive disclosure와 선택 가능한 supporting resource를 사용한다. | 짧은 description·SKILL 라우터·조건부 reference·script를 유지한다. |
| 개선 | [Hooks](https://learn.chatgpt.com/docs/hooks)는 신뢰된 결정적 event automation이다. | 전역 hook을 늘리지 않고 프롬프트로 보장할 수 없는 검사만 canary 뒤 내린다. |
| 개선 | [Long-running work](https://learn.chatgpt.com/docs/long-running-work)는 outcome·constraint·verification과 writer 분리를 강조한다. | multi-repo 작업에 exact writer·recovery·post-read를 유지한다. |
| 개선 | [Codex as a platform](https://learn.chatgpt.com/blog/codex-as-a-platform)은 CLI·SDK·App Server를 integration 수명에 맞춰 고른다. | AICC가 domain context와 policy를 소유하고 Codex는 harness surface로 사용한다. |
| 유지 | [Claude Code steering](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more)은 instruction·skill·subagent·hook을 분리한다. | 자동 중첩 스킬 대신 독립 skill graph와 handoff, reference routing을 사용한다. |
| 개선 | [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)는 namespacing·bounded output·평가 기반 개선을 권한다. | effective same-name collision과 cache/worktree 복제를 구분하고 0건을 검증한다. |

## 발견한 결함과 수정

1. Developer Blog가 `developers.openai.com`의 `/blog/` prefix로 잘못 간주됐고 Claude Blog는 source가
   없었다. 두 blog를 현재 공식 host의 exact HTML source로 분리했다.
2. skill inventory의 same-name 5건이 모두 충돌로 보였다. installed plugin cache와 격리 project scope를
   별도 분류하고 실제 충돌만 summary에 표시한다.
3. local scheduler의 monitoring 설정 오류가 confirmed knowledge job을 함께 막았다. component별 실패를
   격리하고 knowledge job 실행 회귀 테스트를 추가했다.
4. canonical skill description 총예산을 다시 맞추고, explicit-only review skill의 호출·제외 범위를
   짧게 유지했다.
5. 공식 `codex-manual.md`가 2,189,253 bytes여서 기존 2 MiB 상한에 걸렸다. 해당 exact source만
   3 MiB로 올리고 다른 source의 2 MiB 상한은 유지했다. 한 요청당 한 run 원칙 때문에 같은 요청에서
   재실행하지 않고 다음 증분 run부터 적용한다.

## 변경하지 않은 것

- 추천 plugin은 설치하지 않았다. 현재 task에 필요한 공식 web·local source와 built-in tool이 충분하다.
- Native route, Web GPT/OCX route, 인증, permission, 전역 hook을 바꾸지 않았다.
- 외부 source를 guidance에 자동 승격하거나 예약 crawler를 만들지 않았다.

## 다음 검증

- Windows full verify, guidance deploy/check, owner-local inventory 재생성을 통과시킨다.

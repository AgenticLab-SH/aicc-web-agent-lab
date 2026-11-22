# 2026-08-20 OpenAI·Anthropic 에이전트 플랫폼 검토

## 범위와 결과

- 요청: OpenAI/GPT/Codex와 Anthropic/Claude의 공식 개발 문서·기술 글을 로컬 기준과 비교
- 실행: `knowledge-6a0d7e28e3342174560e4112`
- 완료: 2026-08-20 12:05 KST
- 결과: 6 source 모두 `completed`, errors 0, candidate 0, promotion 0, `automaticApply: false`
- source: `openai-developers`, `openai-chatgpt`, `openai-news`, `anthropic-platform`,
  `anthropic-claude-code`, `anthropic-engineering`

OpenAI News HTML crawler는 공식 server가 403을 반환해 우회하지 않았다. 대신 200과 bounded content type을
검증한 [공식 RSS](https://openai.com/news/rss.xml)를 단일 변경 신호로 저장하고, 관련 article은 검토 시
공식 web surface에서 직접 읽는 구조로 제한했다.

## 공식 사실과 로컬 비교

| 판단 | 공식 사실 | 로컬 증거와 delta |
| --- | --- | --- |
| 유지 | OpenAI는 bounded environment, 저위험의 낮은 마찰과 고위험 경계를 함께 요구한다. | `high-risk-change`, exact source, durable job과 rollback은 방향에 맞다. 전역 권한 profile은 아직 P1이다. |
| 유지 | agent harness는 짧은 instruction map, repo 정본, 기계적 불변식과 정기 정리를 요구한다. | active/cold skill 분리, docs home, schema/test와 garbage-collection 후보 목록을 유지한다. |
| 유지 | plugin은 skill과 MCP를 bundle할 수 있으며 client surface가 네이티브 tool을 제공할 수 있다. | Computer Use와 Codex App의 중복 MCP를 끈 현재 구성이 맞다. |
| 유지 | Claude Code는 always-on memory와 on-demand skill, MCP, subagent, hook, plugin을 서로 다른 확장층으로 본다. | Claude는 opt-in이고 root instruction과 active skill을 최소화했다. |
| 유지 | context engineering은 최소 고신호 context와 just-in-time retrieval을 권장한다. | 최신 검토 skill은 active catalog에 있지만 implicit invocation을 꺼 평소 context를 사용하지 않는다. |
| 변경 없음 | [Anthropic Additional resources](https://platform.claude.com/docs/en/about-claude/additional-resources)는 quickstart, course, cookbook, use-case guide와 AI ingestion용 primer/`llms.txt`를 연결한다. | 이번 실행의 유일한 changed URL이지만 기능·권한·agent loop 계약 변경은 아니므로 runtime 변경이 필요 없다. |

## 구현 중 발견한 결함과 수정

초기 runner가 Knowledge Review service의 `runOnce`를 별도 프로세스에서 직접 호출해 30초 scheduler와
job-store transaction이 경합했다. source checkpoint는 fail-closed 됐지만 완료 artifact 등록도
`writer_busy`가 되어 partial manifest가 남았다.

runner를 Dashboard API의 preview → confirmed enqueue → status poll로 바꾸고 실제 crawl과 artifact 등록은
기존 `aicc-local-scheduler` 한 writer만 소유하게 했다. 새 테스트는 runner 안의 직접 `.runOnce(` 호출을
금지한다. 수정 후 6 source 실행과 완료 artifact가 성공했다.

## 개선 판단

### 지정 작업 인수 대조

사용자가 지정한 Codex 작업 `[종료] 에이전트 최적화`의 완료 감사를 다시 읽고 현재 상태와 대조했다.
당시 P1이었던 신규 skill 기본 active, cold workflow 검색 실패, user symlink와 scanner의 소유권 혼동,
단일 대형 route reference와 과대한 high-risk 부속물은 현재 명시적 active allowlist, catalog-aware 검색,
manifest-owned/unmanaged 분리, operation별 route reference와 19줄 high-risk entry로 해소됐다.

현재 `aicc guidance find 'logged in browser account'`와 `'account browser tab'`은 모두
`choose-browser-session`을 1위로 반환한다. canonical은 이번 explicit-only review skill 추가로 41개,
Codex active 11개, cold 30개이며 사용자 `book-to-skill`은 보존됐다. 남은 정적 부채는 cold
`diagram-design` 전체 resource가 약 1.82MB라는 점이다. 시작 context 비용은 아니지만 실제 호출 시
선택된 diagram 유형의 reference만 읽도록 줄일 가치가 있다.

### 완료

- `review-agent-platform-updates`를 Codex active catalog에 추가하고 implicit invocation을 비활성화했다.
- 공식 source 6개, 사람이 읽는 baseline과 dated review 형식을 정본화했다.
- OpenAI News의 수집 불가 HTML을 공식 RSS single-document source로 대체했다.
- 직접 multi-writer runner를 제거하고 Dashboard API → scheduler 단일 writer를 테스트로 고정했다.

### 다음 우선순위

1. **P1 — bounded permission profile canary:** 일반 코딩의 workspace write와 신뢰된 운영 예외를 분리하고
   Codex 앱·CLI·다중 저장소·Computer Use·복구 경로 회귀를 먼저 통과시킨다.
2. **P1 — redacted agent telemetry:** task/tool/중단/rollback 이벤트를 owner-only sink에 남기되 prompt,
   credential과 source 본문은 배제한다.
3. **P2 — external app capability 분리:** read, draft, send, permission-expansion을 별도 capability로 보고
   실제 전송·권한 확대만 강제 경계에 둔다.
4. **P2 — compaction/handoff eval:** PROJECT 정본과 checkpoint만으로 새 task가 완료 조건과 evidence를
   복원하는 fixture를 만든다.

권한 profile과 telemetry는 전역 runtime 동작을 바꾸므로 이번 검토에서는 자동 적용하지 않았다.

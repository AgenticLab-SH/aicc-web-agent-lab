# 에이전트 플랫폼 기준선

- 마지막 공식 확인: 2026-09-06 (Asia/Seoul)
- 부분 재확인: 2026-10-05 KST, Codex 지침·스킬 적재·설정/승인·hook·자동화. 다른 공식 항목은 위 확인일의 기록이다.
- 적용 대상: open-AICC의 Codex 기본 경로와 Claude 선택 경로
- 원칙: 공식 1차 자료만 사실로 사용하고, 외부 원문 대신 URL·확인일·짧은 결론을 보존한다.
- 사람이 읽는 기준선 갱신: 사용자가 `$review-agent-platform-updates` 또는 동등한 최신 비교를
  명시적으로 요청할 때만. Knowledge Review source checkpoint는 Codex/AICC 작업 진입 시 7일 초과
  또는 중요 changelog 신호가 있는 exact affected source만 다시 확인한다. 사용자가 지속 최신화를 요청한 지침 점검은 `agent-context-optimization.md`의 승인된 관리 범위에서 이 문서의 해당 항목만 갱신한다.

## OpenAI·Codex 기준

| 공식 자료 | 현재 기준 | 로컬 대응 |
| --- | --- | --- |
| [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | 전역 파일은 모든 프로젝트의 재사용 기본값, 가까운 프로젝트 파일은 해당 범위의 구체 규칙을 소유한다. 규칙은 가까운 경로가 나중에 합쳐져 우선한다. | 전역 지침에는 cross-project 작업·보고 계약만 두고 Windows·Computer Use·UI 규칙은 제품 권한, 프로젝트 문서와 focused skill로 내린다. |
| [Prompting](https://learn.chatgpt.com/docs/prompting) | 결과를 먼저 설명하고 Goal·Context·Output·Boundary 중 결과를 바꾸는 요소만 제공한다. 중요한 작업은 검증 방법과 최종 확인을 포함한다. | 설명/진단과 변경 요청을 분리하고 최소 수정·관련 검증·적응형 보고 길이를 전역 계약으로 둔다. |
| [GPT-6 Astra model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) | 사용자 지시는 skill 지침보다 우선하고, 위임 범위와 검증 강도는 작업 위험·규모에 맞게 명시한다. | 공통 지침에 우선순위·비례 검증·경계형 위임을 짧게 두고 skill은 해당 작업의 상세 절차만 소유한다. |
| [Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay) | 안정적이고 성공 기준이 분명한 반복 화면 절차는 시연을 재사용 skill로 바꿀 수 있으며 녹화에는 환경 지원과 명시 권한이 필요하다. | 결정적 절차는 코드·테스트를 우선하고, 지원 환경의 안정된 GUI 절차만 녹화 기반 skill 후보로 둔다. 비밀·민감정보는 기록하지 않는다. |
| [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | 로컬 Codex surface는 MCP 구성을 공유할 수 있고 plugin은 자체 MCP를 bundle할 수 있다. | plugin bundled MCP와 user MCP를 별도 inventory로 본다. exact tool surface·hook dependency·host ownership이 같고 제거 canary가 있을 때만 transport를 중복으로 판정한다. |
| [Plugins](https://learn.chatgpt.com/docs/build-plugins) | plugin은 skill, connector/MCP, browser extension과 hook을 함께 배포할 수 있다. | 설치 여부, 활성 여부, 권한과 실제 runtime tool 노출을 분리해 감사한다. |
| [Skills](https://learn.chatgpt.com/docs/build-skills) | 사용자 skill은 `$HOME/.agents/skills`에 두며 description이 자동 선택의 핵심이다. 한 작업에 집중하고 결정성이 필요한 단계는 script를 포함한다. | AICC 관리형 Codex skill은 `.agents/skills`에 배포하고, 의미 판단은 description·본문으로 안내하되 선택 뒤 불변식은 script·test로 검증한다. |
| [Hooks](https://learn.chatgpt.com/docs/hooks) | hook은 신뢰된 결정적 event automation이며 설정·plugin 범위와 command 경계를 가진다. | 현재 전역 hook은 추가하지 않는다. 프롬프트로 강제할 수 없는 검사만 canary와 rollback 뒤 hook으로 내린다. |
| [Long-running work](https://learn.chatgpt.com/docs/long-running-work) | 장기 작업은 outcome·constraint·verification을 고정하고 같은 파일의 동시 writer를 피해야 한다. | root PROJECT 정본, single-writer 조정, test·post-read·recovery 계약을 유지한다. |
| [Codex as a platform](https://learn.chatgpt.com/blog/codex-as-a-platform) | 일회성은 CLI, 프로그램 통합은 SDK, 지속 thread·stream·approval surface는 App Server가 맞다. | AICC는 domain state와 정책을 소유하고 Codex harness는 실행·도구·approval 경계로 사용한다. |
| [Running Codex safely](https://openai.com/index/running-codex-safely/) | bounded environment, 저위험의 낮은 마찰, 고위험의 명시적 경계가 핵심이다. | 일상 쓰기는 workspace 안으로 제한하고 고위험 변경은 별도 recovery 계약을 유지한다. |
| [Sandboxing](https://learn.chatgpt.com/docs/sandboxing) | 승인 정책, 격리 모드, reviewer와 도구의 강제 제한은 따로 확인한다. | 사용자 선택은 현재 config와 실제 task 권한으로 확인한다. 과거 `workspace-write`/`on-request` 기록을 기본 설정으로 강제하지 않는다. |
| [Harness engineering](https://openai.com/index/harness-engineering/) | 사람은 방향을 정하고 agent가 실행하며, 저장소 문서·기계적 검증·정기 정리가 품질을 만든다. | 짧은 AGENTS, docs 정본, schema/test, active/cold skill, durable artifact를 유지한다. |
| [Codex App Server](https://openai.com/index/unlocking-the-codex-harness/) | App Server는 Codex client surface가 thread·config·auth·tool을 다루는 bidirectional JSON-RPC 인터페이스다. | `codex-app-tools@openai-bundled`는 우리 구현이 아닌 공식 앱 통합 fallback이다. 앱 네이티브 tool이 있으면 중복 MCP를 끈다. |
| [Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | 모델·tool·context·실행 환경이 반복 loop를 이룬다. | tool 결과를 다시 읽고 상태를 재파생하며 완료 전에 검증한다. |

## Anthropic·Claude 기준

| 공식 자료 | 현재 기준 | 로컬 대응 |
| --- | --- | --- |
| [Claude Code 확장 개요](https://code.claude.com/docs/en/features-overview) | CLAUDE.md는 항상 적재되고 skill은 on-demand, MCP는 외부 연결, subagent는 격리, hook은 event automation, plugin은 package 역할이다. | CLAUDE는 opt-in, 짧은 root 지침과 최소 active skill을 유지한다. 명시 전용 skill은 model implicit invocation을 끈다. |
| [Capture intent](https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent) | 큰 변경은 문제·이유·영향 대상·제약·제외·열린 질문을 intent로 먼저 분리하고, 검토 가능한 의도에서 spec과 plan을 파생한다. | `intent.md`는 큰·교차·모호·위험 작업에만 쓰며, 구체 경계가 보인 뒤 수락하고 작은 명시 수정에는 만들지 않는다. |
| [Claude Code steering](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more) | persistent instruction, skill, subagent, hook은 서로 다른 문제를 해결한다. | 스킬 중첩 discovery를 가정하지 않고 독립 skill·handoff·reference routing으로 조합한다. 결정적 경계는 script/test로 내린다. |
| [Claude Code skills](https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills) | description은 호출 선택자이고 script는 반복 boilerplate를 줄인다. native dependency management는 전제할 수 없다. | description 총예산과 길이를 테스트하고 handoff 대상은 inventory로 감사한다. |
| [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | context는 유한하므로 최소 고신호 token, just-in-time retrieval, compaction과 subagent 분리가 중요하다. | 반복 지침만 active로, 상세 runbook은 progressive disclosure로, 장기 상태는 PROJECT/checkpoint로 내린다. |
| [Agent tool 설계](https://www.anthropic.com/engineering/writing-tools-for-agents) | tool description·응답·evaluation은 agent가 경계를 이해하고 검증하게 설계해야 한다. | exact input schema, bounded output, post-read와 failure code를 유지한다. |
| [Multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system) | 격리된 context와 명확한 위임·종합이 병렬 agent의 핵심이다. | subtask는 단일 writer와 결과 evidence를 가지고 parent가 최종 종합한다. |
| [Agent 자율성 측정](https://www.anthropic.com/research/measuring-agent-autonomy) | 숙련 사용자는 자동 승인을 더 쓰면서도 더 자주 중단한다. 자율성과 감시는 대체 관계가 아니다. | low-risk 자율 실행과 interrupt·rollback·telemetry를 함께 강화한다. |

## 날짜별 로컬 관찰

날짜를 따로 적지 않은 아래 항목은 2026-09-06 snapshot이다. 현재 설정은 live 조회를 따른다.

- `computer-use@openai-bundled`는 공식 OpenAI plugin이다. plugin skill과 stop hook이 user-configured
  `node_repl`을 사용한다. `unified-computer-use`의 `cua_repl`은 Browser/Chrome app-managed 표면이라
  같은 runtime을 공유해도 대체 관계가 아니다.
- `codex-app-tools@openai-bundled`와 그 `codex_app` MCP도 OpenAI 공식 bundle이며 AICC가 만든 것이
  아니다. Codex Desktop이 `codex_app__*` 도구를 네이티브로 제공하는 현재 구성에서는 fallback MCP를
  별도로 켜지 않는다.
- AICC가 만든 MCP는 `workspace-mcp`와 선택형 `web-gpt-orchestrator`처럼 저장소에 source·contract·test가
  있는 구성요소다. vendor bundle과 소유권을 혼동하지 않는다.
- Knowledge Review는 공식 source 10개를 exact host/path로 관리한다. `openai-latest-model-guide`는
  canonical 최신 모델 HTML을 별도 추적하며 첫 실행에서 GPT-6 Astra·검증·지침 우선순위 구역을 확인했다.
  새 `anthropic-academy-sdlc` source의 첫 확인은 15페이지를 처리했고, `openai-developers`는 508개
  checkpoint를 변경 없이 재사용했다.
  candidate/promotion과 자동 승격은 0이다. 내부 예외는 원문 대신 diagnostic ID를 남기고, 기존 페이지의
  80% 이상이 한 번에 바뀌면 bulk review 신호를 낸다.
- 2026-10-05 사용자 설정 post-read는 `approval_policy = never`, `approvals_reviewer = user`,
  `sandbox_mode = danger-full-access`다. 실제 task host 권한·도구 제한은 별도 층이다.
  이는 2026-10-05의 역사 관측값이다. 2026-10-24 사용자 선택으로 대화형 기본을 on-request + auto_review로 변경했으며 연결 앱 reviewer도 같은 선택을 따른다. 과거 never/user를 현재 기본값으로 복구하지 않는다. 기존 파일 접근 범위와 별도 도구 제한은 유지한다. 실행 중 대화 반영·실사용은 설정 작성과 구분한다.
- 필수 plugin 11개와 허용된 추가 plugin 10개가 활성이다. status는 required·extra·disabled·feature를
  따로 보고하며 계정 연결은 검사하지 않았다고 명시한다. 추가 plugin은 기본 `report` 정책에서 readiness
  실패가 아니고, 정확한 폐쇄 환경만 `forbid`를 선택한다.
- 현재 scanner는 canonical 45개, Codex active/cold 16/29, system 6개, installed plugin skill 43개,
  unmanaged user skill 5개를 논리 항목으로 구분한다. active 가운데 implicit 14개와 explicit-only
  2개를 나누며 effective same-name collision은 0이다. 이 숫자는 2026-09-06 snapshot이다.
- Windows scheduler에서 unrelated monitoring 설정 실패가 confirmed Knowledge Review까지 막는 결함을
  발견했다. component별 실패 격리와 회귀 테스트를 추가해 knowledge writer가 독립 실행된다.
- Codex active AICC skill은 16개다. 모두 공식 사용자 root인 `$HOME/.agents/skills`에 배포하며 예전
  `.codex/skills`에는 AICC 관리형 복사본 없이 사용자 소유 5개와 `.system`만 남긴다. scanner는 두
  root를 분리하고 implicit description cost와 deferred body bytes를 섞지 않는다. 최신 비교 skill은
  명시 요청 외에는 status만 읽고 7일 초과 stale 또는 중요한 changelog 신호가 있는 exact source만
  한 번 검토한다.
- 2026-09-06 live `codex mcp list --json`에는 `aicc_workspace_windows`, `node_repl`, `cua_repl`이 활성이다.
  Workspace surface는 18개 read-only 도구로 command/network를 닫고, 나머지 두 server는 각각 Windows
  Computer Use/hook와 Browser/Chrome surface를 소유한다. plugin 21개는 모두 enabled이며 required 11,
  allowed extra 10, disabled 0, account connection은 unobserved다.
- 공식 최신 모델 GPT-6 Astra는 현재 local Codex `models_cache.json`에도 `visibility=list`로 노출된다.
  이 관측 당시 Codex와 AICC 기본 모델은 GPT-5.6 Sol이었고, Astra는 AICC 후보 목록에만 추가했다. 현재 모델 선택은 사용자 요청과 live 설정을 따른다. 무료 귀속과
  실제 계정 API 접근이 확인되기 전에는 자동 호출하지 않는다.

## 다음 검토 산출물

명시 검토마다 `docs/agent-platform-reviews/YYYY-MM-DD-<scope>.md`를 만들고 아래만 기록한다.

1. 범위와 source별 확인 시각
2. 공식 사실과 URL
3. 이전 baseline 대비 변경
4. 로컬 file·config·test 증거
5. 유지·개선·폐기 후보와 우선순위
6. 적용하지 않은 이유와 다음 검증

baseline 변경은 공식 자료로 확인된 사실과 현재 로컬 post-read를 반영할 때만 한다. runtime, plugin,
MCP와 guidance 변경은 이 문서의 자동 후속 동작이 아니다.

최근 검토: [2026-09-06 에이전트 컨텍스트 단순화](agent-platform-reviews/2026-09-06-agent-context-simplification.md)

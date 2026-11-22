# 2026-09-06 에이전트 컨텍스트 단순화 검토

## 범위와 공식 근거

- [GPT-6 Astra model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra), 2026-09-06 확인: instruction file 충돌에 더 민감하고 작은 변경에서 검사를 넓힐 수 있으므로 user/skill 우선순위, 위임, 보고 형식과 검증 강도를 명시적으로 조정한다.
- [Claude Code extension loading](https://code.claude.com/docs/en/features-overview), 2026-09-06 확인: CLAUDE.md는 항상 적재되고, implicit skill은 description만 먼저 보이며, MCP schema와 skill 본문은 필요할 때 적재된다. hook은 판단이 필요 없는 결정적 event automation에 쓴다.
- [Claude Academy intent.md](https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent), 2026-09-06 확인: 작성자와 product owner가 검토한 what/why/constraint가 spec보다 앞선다.
- Knowledge Review의 10개 source는 모두 current이고 stale/signalled 항목은 0이어서 추가 수집은 실행하지 않았다.

## 로컬 실측

| Surface | 관찰 | 판정 |
| --- | --- | --- |
| 전역 지침 | Windows terminal 세부 규칙이 공통 지침과 전용 skill에 동시에 있었고 source가 2,048-byte/12-line budget을 넘었다. | `revise`: 세부 규칙은 전용 skill에만 유지하고 공통 지침에서는 제거한다. |
| Skill delivery | 스캐너가 옛 `.codex/skills`를 현재 배포 root로 사용해 active 항목 전체를 미배포로 오판했다. | `revise`: `.agents/skills`를 현재 root로, `.codex/skills`를 legacy/system root로 분리한다. |
| Skill context | 현재 canonical 45, active/cold 16/29, implicit/explicit-only 14/2다. implicit description은 1,595자이고 active entry body 70,861 bytes는 호출 전 적재되지 않는다. 서로 다른 active skill의 40자 이상 exact repeated instruction line은 0개다. | `keep`: active 수를 기계적으로 줄이지 않고 trigger와 invocation policy를 기준으로 유지한다. |
| Workflow ownership | `run-evidence-gated-ai-development`가 새 intent/spec skill과 목표·요구사항 소유권을 공유하고 security-sensitive 일반 작업까지 넓게 끌어들였다. | `revise`: intent/spec은 `develop-from-project-spec`, 장기·multi-writer checkpoint와 증거는 실행 skill, 비싼 mutation은 `high-risk-change`로 분리한다. |
| Plugins | required 11, extra 10, disabled 0이며 account connection은 미관찰이다. | `keep`: extra는 report 정책으로 남기고 설치 상태를 계정 readiness로 확대하지 않는다. |
| MCP | `aicc_workspace_windows`, `node_repl`, `cua_repl` 세 server가 활성이다. 첫째는 18개 read-only workspace 도구, 둘째는 Windows Computer Use와 stop hook, 셋째는 Browser/Chrome 표면이다. | `keep`: 역할과 hook dependency가 달라 중복 제거 조건을 충족하지 않는다. |
| Model route | 공식 최신은 GPT-6 Astra지만 현재 local Codex host catalog와 선택 가능한 agent model 목록은 GPT-5.6 계열이다. owner config도 GPT-5.6 Sol을 가리킨다. | `defer`: 지원되지 않은 model string이나 고정 catalog를 강제 수정하지 않는다. host 노출 뒤 별도 route canary로 전환한다. |

## 변경과 검증

- Skill scanner schema v2가 current/legacy root, implicit/explicit-only, implicit description characters,
  deferred entry bytes, exact repeated instruction lines, legacy managed copies와 delivery issues를 보고한다.
- `run-evidence-gated-ai-development`의 description과 본문을 장기·multi-writer 실행 책임으로 줄이고
  positive/near-miss trigger를 갱신했다.
- `present-agent-terminal-status` description은 핵심 trigger와 ordinary-shell exclusion만 남겼다.
- 동시 갱신된 `notify-user`는 CAPTCHA 자동 재개·KST·비밀 보호 계약을 보존하면서 implicit 본문을
  5,543 bytes로 줄여 6,144-byte 제한 안에 넣었다.
- 전역 지침은 terminal 구현 세부를 제거하고 source → generated → owner home으로 다시 배포한다.
- 통합 guidance 검사는 기본 실행에서 Codex 기본 target만 검사하고, Claude는 명시한 target 또는
  `--all`에서만 포함한다. 여러 target은 `pwsh -File`의 배열 인자 손실을 피하도록 하나씩 검증한다.
- 배포 정책 검사는 위 두 불변식을 aggregate 스크립트에서 직접 확인해, 과거 optional manifest나
  PowerShell 배열 바인딩이 기본 검증 범위를 다시 넓히지 못하게 한다.
- 외부 plugin, MCP, account, route, model, Desktop과 Claude target은 바꾸지 않는다.

최종 증거는 focused test 137/137, live scanner/plugin/MCP post-read, guidance source/home hash 일치,
intent/spec validator와 `npm run verify:windows` PASS다. 선택형 외부 검사기 `gitleaks`는 이 host에
없어 Windows gate가 경고 후 건너뛰었으며, 내장 비밀·경로 검사는 통과했다.

후속 최종 재검토에서는 공식 source 10개가 모두 current이고 stale/signalled 항목이 0임을 다시
확인했다. 배포 정책 35/35와 aggregate guidance 5/5가 통과했고, scanner는 logical 99개, AICC
active/cold 16/29, delivery issue 0, effective collision 0을 재현했다. 생성본과 owner-home
`AGENTS.md` SHA-256도 일치했으며 추가 retire·plugin/MCP/model mutation 대상은 없었다.

같은 날 후속 모델 확인에서 local Codex catalog에 `gpt-6-astra`가 `visibility=list`로 들어온 것을
확인했다. AICC 후보 목록과 공식 가격 snapshot만 갱신하고 기본 모델은 GPT-5.6 Sol로 유지했다.
Astra의 무료 귀속과 실제 계정 API 접근은 미확인이므로 자동 호출과 route 전환은 하지 않았다.

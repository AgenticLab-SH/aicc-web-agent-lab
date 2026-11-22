# 외부 소스와 파생 관계 집합소

이 문서는 AICC와 AICC가 배포하는 스킬이 어떤 외부 저장소·문서·패턴을 기반으로
개발됐는지 찾는 단일 진입점이다. “링크를 봤다”, “원리만 참고했다”, “코드를
가져왔다”, “fork/clone이다”를 구분한다.

기계 판정의 정본은
[`guidance/skills/aicc-guidance-review/references/absorption-ledger.json`](../guidance/skills/aicc-guidance-review/references/absorption-ledger.json)이다.
이 문서는 그 원장을 사람이 읽기 쉽게 요약하며, 상세 라이선스와 import 증거는
각 `UPSTREAM.md` 또는 skill의 `upstream-and-licenses.md`가 소유한다.

## 관계 용어

| 관계 | 의미 |
| --- | --- |
| `vendored` | 외부 코드·asset·skill을 고정 ref에서 저장소 안으로 가져왔다. notice와 update 감시가 필요하다. |
| `copied` | 일부 코드·문구·asset을 복사·수정했다. 원문 ref와 라이선스 의무를 제품에도 남긴다. |
| `dependency` | 제품이 package/registry를 통해 소비한다. 전역 설치 여부와 프로젝트 의존성을 구분한다. |
| `pattern` / `ui-pattern` | 원리·workflow·관찰된 패턴만 자체 구현했다. clone이나 코드 복사가 아니다. |
| `tool` | 도구 자체를 평가했다. `absorbed`여도 전체 앱 설치가 아니라 일부 원리 채택일 수 있다. |
| `duplicate` / `superseded` | 기존 native/정본이 책임을 이미 소유하거나 더 정확하게 대체한다. |
| `deferred` / `rejected` | 현재는 도입하지 않았다. 이유와 재검토 조건을 원장에 남긴다. |

`clone`, `fork`, `based on` 같은 모호한 표현만 쓰지 않는다. 실제 관계가 `vendored`,
`copied`, `dependency`, `pattern` 중 무엇인지 함께 적는다.

## 현재 직접 통합·vendor 구성요소

| AICC target | 외부 source | 관계 | 상세 증거 |
| --- | --- | --- | --- |
| `vendor/opencodex` | `lidge-jun/opencodex` | pinned Git submodule (`vendored`) | [`vendor/opencodex.UPSTREAM.md`](../vendor/opencodex.UPSTREAM.md) |
| `components/account-manager` | former standalone Codex Account Manager | tracked source import (`copied`/integrated component) | [`components/account-manager/UPSTREAM.md`](../components/account-manager/UPSTREAM.md) |
| `guidance/skills/diagram-design` | `cathrynlavery/diagram-design` | pinned skill vendor + small AICC adaptation | [`upstream-and-licenses.md`](../guidance/skills/diagram-design/references/upstream-and-licenses.md) |

별도 저장소인 `codex-chatgpt-web`은 AICC 자체의 clone이 아니다. 그 저장소가
`miuuyy/codex-chatgpt-web`을 기반으로 한 fork라는 상세 관계는 해당 저장소의 README와
notice가 소유하며, AICC는 여기서 런타임 dependency 관계만 설명한다.

## 2026-08-12 디자인 흡수 묶음

| Source | 관계와 실제 흡수 | 설치하지 않은 것 |
| --- | --- | --- |
| `kwakseongjae/oh-my-design` | `pattern`: 시각 카탈로그 선택, evidence-aware reference, project-owned `DESIGN.md`, unknown 보존 | 20 skills, 18 roles, hooks, browser automation, 440개 reference 전체 |
| `pbakaus/impeccable` | `pattern`: surface mode, anti-generic critique, bounded polish | hook, live browser editor, 대형 script bundle |
| `nexu-io/open-design` | `tool`→adapted workflow: portable design context, export-aware planning | Electron/daemon/MCP/BYOK/provider/telemetry/plugin catalog |
| `cathrynlavery/diagram-design` | `vendored`: self-contained HTML/SVG skill과 import extractor | Claude plugin과 전역 hook |
| `JCodesMore/ai-website-cloner-template` | `pattern`: authorized observable-UI reconstruction과 verification | Next.js template과 channel bundles |
| `allweonedev/presentation-ai` | `pattern`: outline-first slide workflow와 theme/image gates | SaaS app, PostgreSQL, OAuth, uploads, provider integrations |
| `shadcn-ui/ui` | `dependency` policy: 필요한 component만 프로젝트 소유 코드로 채택 | 저장소 전체 vendor와 전역 테마 고정 |
| `Nutlope/logocreator` | `pattern`: brief→variants→brand-kit | license 미확인으로 code/UI/assets 전부 제외 |

정확한 commit, 라이선스 증거, target, 우리 고유 요소와 다음 확인일은 JSON 원장에서
각 source ID로 확인한다.

## 2026-08-14 owner-local 원본 라이브러리

디자인 원리를 고정된 요약만으로 소비하던 구조를 보완했다. `guidance/design-sources.json`은
배포 가능한 URL·baseline·license·capability routing만 기록하고, 실제 원본 tree는
`AICC_STATE_ROOT/design-sources`의 commit별 snapshot에 보존한다. 각 저장소의 hook, installer,
daemon, provider 설정은 실행하지 않는다.

AICC dashboard의 **디자인 원본** 화면은 6시간 읽기 전용 scan, 원본별 상태·예상 크기·license,
선택/전체 선택, one-use preview, exact commit apply와 rollback을 제공한다. apply는 선택된 모든
snapshot을 먼저 내려받고 무결성을 검증한 뒤 active symlink를 전환한다. 자동 적용은 항상 꺼져 있다.

`establish-design-direction/scripts/select-design-sources.mjs`는 web, presentation, diagram, logo 등
현재 매체와 의도에 맞는 1–3개 active 원본과 recommended path를 반환한다. 프로젝트는 실제로 읽은
commit/path와 adopt/adapt 결정을 `DESIGN.md` provenance에 남긴다. license가 `UNKNOWN`인 source는
local reference만 허용한다.

## 2026-08-18 에이전트 컨텍스트 경량화

| 공식 source | 반영한 원칙 | AICC 적용 |
| --- | --- | --- |
| OpenAI Codex `AGENTS.md` | 시작 시 조합되는 지침은 짧고 안정적으로 유지 | 공통 지침 축약, 프로젝트 상세는 `context/PROJECT.md`로 분리 |
| OpenAI Codex Skills | 짧은 trigger metadata와 선택 후 본문 로딩 | 등록 스킬 제한, 드문 대화 증류의 implicit invocation 비활성화 |
| OpenAI Codex config | 기본값과 폐기된 flag를 반복하지 않고 plugin/MCP 도구를 필요한 만큼만 노출 | 기본 `fast_mode`, 폐기된 `js_repl`, 문서 MCP 제거; Computer Use·Visualize plugin 활성화, 중복 Computer Use MCP 비활성화, `node_repl`은 `js`만 허용 |
| Anthropic Claude Code memory | `CLAUDE.md`는 모든 Claude 대화에 로드 | Claude 홈 기본 배포 중단, 명시 배포도 공통 정본에서 `CLAUDE.md` 하나만 생성 |
| Anthropic context engineering | 최소 고신호 컨텍스트와 최소 도구 집합 | 공용 `node_repl` 하나와 비등록 workflow 온디맨드 조회 유지 |

공식 문구나 구현을 복사하지 않고 확인된 동작과 설계 원칙만 AICC의 배포·검사 계약으로
다시 작성했다. 정확한 URL과 판정은 기계 원장의 `20260818` 항목이 소유한다.

## 기록 규칙

1. GitHub·문서·UI에서 무언가를 실제로 흡수하거나 보류·거절하면 같은 변경에서 원장에
   source와 판정을 추가한다.
2. 코드·문구·asset을 가져오면 중앙 원장만으로 끝내지 않고 실제 제품의
   `THIRD_PARTY_NOTICES` 또는 `*.UPSTREAM.md`에도 copyright·license·ref를 남긴다.
3. pattern-only면 무엇을 자체 구현했고 무엇을 가져오지 않았는지 적는다.
4. external source가 다시 external source를 큐레이션한 경우 직접 upstream을 확인하지
   않았다면 그 카탈로그를 원 출처로 승격하지 않는다.
5. `UNKNOWN`을 빈 값이나 확인 완료로 바꾸지 않는다. license가 없으면 코드를 복사하지
   않고 pattern-only 또는 `deferred`로 둔다.
6. 인증 URL, 비밀, 계정·세션 DB, 브라우저 프로필, 개인 절대 경로는 원장에 넣지 않는다.

검증은 다음을 사용한다.

```bash
pwsh -NoProfile -File tools/platform/inspect/Inspect-GuidanceSources.ps1 -AiccRoot . -AsJson
pwsh -NoProfile -File tools/platform/inspect/Inspect-GuidanceUpstreams.ps1 -AiccRoot . -AsJson
```

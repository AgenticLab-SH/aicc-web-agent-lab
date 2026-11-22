# 디자인 원본 사용과 파생 관계

AICC는 디자인 원리를 짧은 요약 하나로 고정하지 않는다. 등록된 원본 저장소를 owner-local
commit snapshot으로 보존하고, 작업마다 필요한 원본의 관련 파일을 직접 읽는다. 활성 commit과
업데이트 상태는 AICC의 디자인 원본 화면에서 선택·검증·전환한다.

| Source | Codex가 읽는 역할 | AICC가 적용하는 경계 |
| --- | --- | --- |
| `pbakaus/impeccable` (Apache-2.0) | layout, typography, color, critique, polish, detector references | 원본 skill/reference는 읽되 hooks, live browser owner, provider 설정을 자동 실행하지 않는다. |
| `nexu-io/open-design` (Apache-2.0) | design-system 구조, template, catalog, cross-format organization | 필요한 source path만 읽고 Electron/daemon/MCP/BYOK/telemetry를 AICC runtime에 연결하지 않는다. |
| `shadcn-ui/ui` (MIT) | accessible component source와 examples | 프로젝트 stack에 맞는 component만 프로젝트가 소유하고 notice/dependency를 기록한다. |
| `JCodesMore/ai-website-cloner-template` (MIT) | observable UI reconstruction skill과 viewport workflow | 공개 관찰 범위와 권리 있는 자산만 현재 stack으로 재구성한다. |
| `allweonedev/presentation-ai` (MIT) | themes, editable layouts, charts, narrative modes | native Presentations workflow의 reference로 읽고 별도 SaaS runtime을 세우지 않는다. |
| `cathrynlavery/diagram-design` (MIT) | diagram type grammar, examples, SVG/HTML tooling | vendored AICC skill과 active original을 비교해 update를 검토한다. |
| `Nutlope/logocreator` (license UNKNOWN) | brief, independent variants, selection, brand-kit sequence | local pattern reference로만 읽고 code/UI/assets는 배포물에 복사하지 않는다. |

`kwakseongjae/oh-my-design`은 visual catalog와 project-owned `DESIGN.md` 선택 근거를 제공한다.
개인 design library는 사용자 선호와 reusable frame을 제공한다. 둘 다 현재 프로젝트의 실제
token, copy, product behavior보다 우선하지 않는다.

정확한 baseline, license evidence, update observation은 AICC central absorption ledger와
`guidance/design-sources.json`이 소유한다. 실제 작업에서 선택한 commit과 파일은 프로젝트
`DESIGN.md` provenance에 기록한다.

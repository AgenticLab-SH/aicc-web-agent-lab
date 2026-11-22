# 2026-08-31 Codex AGENTS.md 최적화

## 범위와 공식 사실

- 확인 시각: 2026-08-31 00:52 (Asia/Seoul)
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md): 전역에는 모든 프로젝트의 재사용 기본값을 두고, 저장소·하위 경로의 구체 규칙은 가장 가까운 파일에 둔다.
- [Prompting](https://learn.chatgpt.com/docs/prompting): 결과부터 설명하고 Goal·Context·Output·Boundary 중 결과를 바꾸는 요소만 추가하며, 중요한 작업은 검증 방법과 최종 확인을 둔다.
- [Model guidance](https://developers.openai.com/api/docs/guides/latest-model): 반복 지침을 제거하고 자율성·승인 경계를 한 번만 짧게 정의한다. 짧은 답은 근거·중요 caveat·다음 행동을 보존한다.
- [Build skills](https://learn.chatgpt.com/docs/build-skills): skill은 한 작업에 집중하고 입력·출력을 명확히 하며, 결정성이 필요하거나 외부 도구가 있어야 할 때 script를 쓴다.
- [Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay): 안정적이고 성공 기준이 분명한 반복 화면 절차는 시연을 재사용 skill로 만들 수 있다. 녹화에는 지원 환경과 명시 권한이 필요하며 비밀·민감정보를 피한다.

## 이전 대비 변경

- 전역 지침에서 Windows·Computer Use·스레드명처럼 platform·tool·UI에 묶인 규칙을 제거했다. 해당 경계는 제품 권한, AICC 프로젝트 문서와 focused skill에 이미 존재한다.
- 설명·검토·진단과 변경 요청을 분리해, 진단 요청의 무단 수정과 변경 요청의 불필요한 재승인을 함께 줄였다.
- 기존 구조·관례·사용자 변경 보존, 최소 수정, 관련 검증 통과를 완료 조건으로 고정했다.
- 답은 결론부터 쓰고 초등학생 비개발자도 한 번에 이해할 쉬운 말·짧은 문장으로 설명한다. 전문용어는 필요한 경우 바로 푼다.
- 짧은 답 1~2문장, 일반 보고 최대 5개 핵심 항목을 기본값으로 두고 정확성·안전·사용자 형식에 따라 확장한다.
- 두 번 이상 쓰였거나 다시 쓸 가능성이 큰 과정은 script·test를 우선하고, 판단 절차는 focused skill·runbook으로 남긴다. 지원 환경의 안정된 GUI 절차만 녹화 기반 skill 후보로 둔다.
- `guidance/directives/README.md`를 작성 정본으로 확장해 전역 포함 조건, 계층 선택, 쉬운 문장, 수치 사용, 자동화 전환, 배포·검증·복구를 한곳에서 관리한다.

## 로컬 적용과 검증

- 정본: `guidance/directives/fragments/common.md`
- 작성 규칙 정본: `guidance/directives/README.md`
- 생성·배포: `guidance/directives/generated/codex/AGENTS.md`, owner Codex home
- 불변식: 2,048 bytes·12 lines 이하, project context bounded, surface-specific 상세 금지, agentic execution·plain reporting·reusable automation 필수
- 적용하지 않음: 권한 profile, route, plugin, MCP, hook, Claude 선택 배포

## 판단과 다음 검증

- 유지: 전역 AGENTS.md는 cross-project 결과·경계·검증·보고 계약만 소유한다.
- 개선: 대표적인 설명·진단·국소 수정·HOLD 응답에서 누락과 과잉 질문을 관찰해 수치 기본값을 조정한다.
- 검증: `aicc guidance plan`, `deploy`, `check`, `npm run verify:windows`와 생성본·home hash 일치를 확인한다.

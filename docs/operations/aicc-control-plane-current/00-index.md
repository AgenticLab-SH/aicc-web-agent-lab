# AICC current control-plane program

상태: **최종 방향 선정 완료 — AgentDock/NexusDock POC 및 ChatGPT App 통합 진행 전**

이 디렉터리는 2026-09-26 이후 AICC의 현재 통합 작업계획, 진행 증거, 남은 gate를 기록한다.
과거 handoff와 복구계획을 덮어쓰지 않고, 현재 live source/evidence를 우선한다.

## 정본 우선순위

1. 현재 live/runtime evidence와 owner-local receipt
2. [12-webjjonku-continuity-ledger.md](12-webjjonku-continuity-ledger.md)의 현재 복구 상태·결정·다음 gate
3. `context/PROJECT.md`의 current facts
4. 이 디렉터리의 세부 계획/작업 로그
5. `docs/operations/aicc-runtime-handbook/`의 안정된 운영 계약
6. 과거 `aicc-next-thread-handoff`와 historical recovery plan

## 문서

- [01-integrated-plan.md](01-integrated-plan.md): 전체 작업 순서와 gate
- [02-work-log.md](02-work-log.md): 수행한 일, 결과, 남은 일
- [03-chatgpt-app-and-observability.md](03-chatgpt-app-and-observability.md): ChatGPT MCP 앱 등록과 관측성 설계
- [04-agentdock-evaluation.md](04-agentdock-evaluation.md): AgentDock/NexusDock와 RDC/AICC 비교 및 채택 POC 기준
- [05-cccc-evaluation.md](05-cccc-evaluation.md): CCCC multi-agent orchestration과 AgentDock/AICC/WebGPT 비교
- [06-final-direction.md](06-final-direction.md): 최종 선정 아키텍처와 채택/비채택 결정
- [07-naming-system.md](07-naming-system.md): canonical 명칭과 compatibility migration 규칙
- [08-reliability-contract.md](08-reliability-contract.md): 세션 중단·충돌·포커스·파일·로그인 반복 문제 제거 계약
- [09-implementation-plan.md](09-implementation-plan.md): 기존 코드 재사용 매핑과 단계별 구현 순서
- [10-immutable-candidate-gate.md](10-immutable-candidate-gate.md): source acceptance와 installed cutover를 분리하는 gate
- [11-codex-app-control-automation.md](11-codex-app-control-automation.md): Codex Desktop exact thread/writer/route handoff 절차
- [12-webjjonku-continuity-ledger.md](12-webjjonku-continuity-ledger.md): `웹쫀쿠 총괄` + `이어쓰기 결과` 통합 복구 원장과 최신 resume point
- [13-candidate-overlay.json](13-candidate-overlay.json): immutable candidate에 포함할 task-owned static/runtime overlay 89개 경로와 소유 이유

## 변경 원칙

- 기존 dirty work를 reset/revert/clean하지 않는다.
- 다른 세션이 수정 중인 tracked 파일은 ownership이 불명확하면 건드리지 않는다.
- 비밀값, 실제 계정 식별자, SSH private key, OAuth token을 tracked 문서에 기록하지 않는다.
- mutation은 backup/preview/bounded change/post-read/rollback 순서로 한다.
- RDC는 AICC 장애 복구용 독립 경로로 유지한다.
- 완성된 운영 계약만 runtime handbook으로 승격한다.

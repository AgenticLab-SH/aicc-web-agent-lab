# 에이전트 엔지니어링 방향

open-AICC의 목표는 **근거 기반의 경계형 자율성**이다. 사용자가 요청한 범위 안의 읽기, 국소 수정,
테스트와 복구 가능한 운영은 에이전트가 별도 승인 없이 끝까지 수행한다. 비가역 결과, 권한 확대,
결제·법적 약정, credential 처리와 범위가 불명확한 외부 영향은 자율성의 대상이 아니다.

여기서 “YOLO 코딩”은 검증을 생략하거나 전역 권한으로 밀어붙인다는 뜻이 아니다. 의도를 반복해서
묻지 않되, 작은 실패 경계·실제 검증·복구 가능성을 기본으로 만들어 빠르게 완결한다는 뜻이다.
현재 승인된 범위의 성공 가능성이 있는 자동 경로를 우선한다. 같은 실패를 반복하거나 강제 제한을 우회하지 않는다. 정확한 현재 화면 승인이 있고 지원되는 Computer Use는 필요한 경우에만 사용하고, 사람만 가능한 단계가 남으면 owner-local 알림으로 보낸다. 세부 계약은
[Agentic coding and last-resort intervention](runbooks/agentic-intervention.md)을 따른다.

## 운영 원칙

1. **사용자가 방향을 정하고 에이전트가 실행한다.** 목표와 완료 조건을 먼저 고정하고 정상적인 구현
   단계는 스스로 판단한다.
2. **저위험 작업은 마찰 없이, 고위험 작업은 경계 안에서 실행한다.** 읽기·진단·작은 수정·테스트는
   진행하고, 고위험 mutation만 짧은 실행·복구 계약을 둔다.
3. **문서는 탐색 지도이고 검증기가 불변식을 지킨다.** AGENTS/CLAUDE는 짧은 목차로 유지하고 상세
   계약은 정본 문서·schema·test·lint로 내린다.
4. **필요할 때만 context와 tool을 적재한다.** 반복 workflow만 active skill로 두고 나머지는 cold
   search, 명시 호출 또는 전문 tool로 연결한다.
5. **상태는 단일 writer와 내구 artifact로 남긴다.** 대화 기억에 의존하지 않고 request, checkpoint,
   result evidence와 rollback ref를 분리한다.
6. **외부 입력은 사실이 아니라 후보 증거다.** 공식 출처라도 host/path/content 경계를 통과시키고
   source나 guidance에는 자동 승격하지 않는다.
7. **완료는 주장보다 증거다.** 변경된 surface에 비례한 test, post-read, browser QA 또는 artifact
   hash가 있어야 완료로 본다.

## 자율 실행 결정표

| 작업 | 기본 행동 | 필요한 경계 |
| --- | --- | --- |
| 읽기·검색·진단 | 즉시 수행 | 민감정보 최소화, 공식 source 우선 |
| task 범위의 국소 코드·문서 수정 | 수정 후 검증 | dirty worktree 보존, 관련 test |
| 복구 가능한 설정·외부 write를 사용자가 구체적으로 요청 | 수행 후 post-read | exact target, idempotency, rollback |
| 인증·결제·보안·DB migration·infra·대형 refactor·multi-writer | 짧은 계약 뒤 수행 | 대상·단일 writer·중단 조건·복구 |
| credential 입력, 비가역 삭제, 법적 약정, 금전 거래 | 기존 승인·지원 capability와 제품의 강제 확인을 대조한 뒤 실행 또는 handoff | 승인되지 않은 새 대상만 확인하고 강제 제품 제한은 유지 |
| 범위가 달라지는 선택 | 질문 | 합리적 추론으로 같은 결과를 낼 수 없을 때만 |

## 현재 아키텍처 판단

잘 맞는 부분:

- Codex active skill은 반복 진입점만 유지하고 나머지는 cold search로 내렸다.
- `high-risk-change`는 실행 전 네 항목만 고정하며 일반 작업에는 개입하지 않는다.
- Knowledge Review는 exact official host, checkpoint, owner-only artifact와 수동 승격을 사용한다.
- MCP·plugin·app surface는 소유권과 실패 영역을 따로 inventory하고, 같은 기능을 둘 이상 켤 때 status가 추가 경로와 검사 한계를 숨기지 않는다.
- route, durable job, artifact, rollback과 테스트가 대화 바깥의 검증 가능한 상태를 만든다.

남은 개선 우선순위:

| 우선순위 | 개선 | 이유와 완료 조건 |
| --- | --- | --- |
| P1 | 설정·task override·실제 execution profile의 drift 가시화 | 사용자 기본은 공식 저위험 preset인 workspace-write/on-request로 전환했다. 다음 단계는 task host override를 effective profile과 근거로 status에 표시하는 것이다. |
| P1 | 저위험 자동 승인과 고위험 강제 경계를 제품 기능으로 시험 | 전역 무제한 권한은 제거했다. 이후 자동 reviewer를 검토한다면 risk classifier·정책 불변식·recovery canary를 먼저 증명한다. |
| P1 | redaction된 agent-native telemetry와 실패 분류 | task·tool·승인·중단·rollback 이벤트를 local OTLP 또는 동등한 owner-only sink에 남기고 secret 원문은 기록하지 않는다. |
| P2 | 최신 공식 기준의 사람이 읽는 delta 생성 | `$review-agent-platform-updates`가 명시 요청 source 또는 Codex/AICC 작업 진입 시 7일 초과 stale·중요 changelog 신호의 exact affected source만 한 번 수집하고 baseline·dated review를 갱신하며 runtime에는 자동 적용하지 않는다. |
| P2 | 외부 app write 권한을 read/draft/send로 세분화 | 조회와 초안은 자율 처리하고 실제 전송·권한 확대·비가역 결과만 제품 confirmation 경계에 둔다. |
| P2 | 장기 작업의 compaction·handoff 품질 측정 | PROJECT 정본, checkpoint와 final evidence가 새 task에서 손실 없이 이어지는지 fixture로 검증한다. |
| P3 | 주기적 garbage collection | 오래된 cache·artifact·대형 DB는 owner와 보존기간을 확인한 뒤 압축·삭제하고 복구 가능성을 기록한다. |
| P3 | cold skill의 호출 시 resource budget | `diagram-design`처럼 cold라 startup tax는 없지만 호출 시 약 1.82MB를 탐색하는 workflow는 selector를 작게 유지하고 선택된 유형의 reference만 읽도록 축소한다. |

현재 사용자 기본 권한은 recovery receipt, config post-read, CLI parse canary 뒤 저위험 preset으로
전환했다. task host가 주는 더 넓거나 좁은 유효 권한은 계속 별도 층이며 status 가시화가 남았다.

## 수용 기준

- 에이전트는 task 범위의 정상 구현·테스트를 재승인 없이 완료한다.
- 실패는 source·job·workspace 단위로 격리되며 다른 writer 상태를 되돌리지 않는다.
- 고위험 변경은 mutation 전에 target, preserved state, validation, recovery를 네 항목 이하로 남긴다.
- 활성 context는 반복 가치가 있는 최소 instruction만 포함한다.
- “완료” 응답은 test, post-read 또는 artifact evidence를 가리킨다.
- 최신 지식 검토는 명시 요청 또는 Codex/AICC 작업 진입의 7일 초과 stale·중요 changelog 신호에서만 exact source 단위로 한 번 시작되며, 상시 예약·자동 승격은 계속 0이다.

최신 외부 기준과 로컬 대응은 [에이전트 플랫폼 기준선](agent-platform-baseline.md)을 정본으로 삼는다.

# open-AICC 문서 홈

이 디렉터리는 재사용 가능한 open-AICC core의 제품·운영 **계약** 정본이다.
특정 owner의 계정, 설치 버전, PID, Tunnel ID, 현재 route/release/writer와 private adapter 증거는
이 `docs/`에 고정하지 않는다. 현재 owner 설치의 live 운영 상태는 `../context/PROJECT.md`와
owner-private 실행 원장에서 확인한다.

## 먼저 읽기

처음 사용하는 분은 **[AICC · OCX · Codex 쉬운 사용 설명서](user-guide.html)**를 엽니다.
에이전트가 읽는 정본은 [같은 설명서의 Markdown](user-guide.md)입니다.

0. 현재 owner 설치의 live 상태가 필요하면 [`../context/PROJECT.md`](../context/PROJECT.md)를 먼저 읽는다.
1. [현재 사용 계약](current-state-and-usage.md)
2. [아키텍처](architecture.md)
3. [실행 계약](execution-contract.md)
4. [상태 경계](state-boundaries.md)
5. [Private Home](private-home.md)

## 운영 영역

| 영역 | 문서 |
| --- | --- |
| 브라우저·원격 작업 | [browser-remote-boundaries.md](browser-remote-boundaries.md), [Background Computer Use runbook](runbooks/background-computer-use.md) |
| durable job·artifact | [durable-jobs-artifacts.md](durable-jobs-artifacts.md) |
| 공식 지식 검토 | [knowledge-review.md](knowledge-review.md) |
| 에이전트 엔지니어링 방향·최신 기준 | [agent-engineering-direction.md](agent-engineering-direction.md), [agent-platform-baseline.md](agent-platform-baseline.md) |
| Project Catalog·Notion priority | [project-catalog.md](project-catalog.md) |
| AI Asset Registry·Notion connector | [asset-control-plane.md](asset-control-plane.md) |
| plugin·skill·Web GPT 역할 DAG | [extensions-and-web-gpt-orchestration.md](extensions-and-web-gpt-orchestration.md) |
| OCX upstream·storage | [ocx-upstream-storage-governance.md](ocx-upstream-storage-governance.md) |
| AICC runtime handbook | [operations/aicc-runtime-handbook/00-index.md](operations/aicc-runtime-handbook/00-index.md) |
| 승인된 최종 복구의 다음 작업 인계 | [operations/aicc-next-thread-handoff/00-index.md](operations/aicc-next-thread-handoff/00-index.md) |
| 호환성·업데이트 | [compatibility-updates.md](compatibility-updates.md), [upstream-updates.md](upstream-updates.md) |
| canonical guidance | [agent-operations.md](agent-operations.md), [skill-ecosystem.md](skill-ecosystem.md) |
| Codex·AICC 전체 구성요소 원본 | [component-source-map.md](component-source-map.md) |
| OpenAI API guard | [openai-complimentary-guard.md](openai-complimentary-guard.md) |
| 사용자 알림 | [user-notification-channels.md](user-notification-channels.md), [Slack alert bot runbook](runbooks/slack-alert-bot.md) |
| 출처·license | [source-provenance.md](source-provenance.md) |

## 제품·마이그레이션

- [대시보드 제품 사양](dashboard-product-spec.md)
- [open-AICC 통합과 마이그레이션](open-aicc-migration.md)
- [호환성 migration pointer](migration.md)

## 세부 runbook과 policy

- 반복 운영 절차: [runbooks/](runbooks/)
- 유지보수 정책: [policies/](policies/)
- 배포 가능한 guidance와 skills의 정본: [../guidance/](../guidance/)

## 배치 규칙

- 재사용 가능한 제품 설명과 운영 계약만 `docs/`에 둔다.
- 특정 owner의 현재 상태, 대화 원장, 장기 evidence와 personal asset은 넣지 않는다.
- 숫자가 자주 변하는 사실은 문장에 고정하지 않고 live status 명령을 연결한다.
- 같은 설명을 여러 파일에 복제하지 않고 이 홈에서 정본 한 곳으로 링크한다.
- 역사적 migration 기록은 현재 사용법으로 재해석하지 않는다.

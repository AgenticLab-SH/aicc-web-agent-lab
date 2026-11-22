## 7. IT 실무 검토를 통과시킨다

해당되는 항목만 확인한다.

- 시스템 context, component/data/control plane과 failure domain
- repository/package/runtime/deployment 경계
- interface와 external dependency, version compatibility
- data ownership, lifecycle, retention, privacy와 access boundary
- nonfunctional requirement: availability, performance, security, observability, recovery
- change path: preview, approval, idempotency, single writer, verify, rollback
- 운영: owner, health, alert, runbook, incident/recovery entrypoint
- 전달: 신규 에이전트가 5분 안에 owner, current, target, next action을 찾을 수 있는가

프로젝트 규모와 위험에 필요 없는 회의, RACI 문서, 형식적 다이어그램, 중복 표준 문서는 만들지 않는다.

## 8. 검증한다

최소 다음을 확인한다.

1. 새/수정 링크와 실제 path가 존재한다.
2. 같은 핵심 용어, repository owner, current/target 판정이 문서마다 모순되지 않는다.
3. `AGENTS.md`가 중요한 자동 규칙을 포함하되 상세 문서를 복제하지 않는다.
4. 생성본·cache·runtime state를 edit target으로 지정하지 않았다.
5. dirty/untracked 사용자 변경을 stage, reset, clean, 삭제하지 않았다.
6. 문서가 주장하는 command/test를 가능한 범위에서 실제 실행한다.
7. 새 에이전트 관점으로 “어디서 시작하고 무엇을 믿는가”를 dry-run한다.

검사 결과를 source/doc, static validation, runtime, external system으로 나눠 보고한다. 한 계층의 PASS를
다른 계층 완료로 확대하지 않는다.

## 결과 형식

```text
Outcome:
Canonical project guide:
Source/runtime/record/authority map:
Document hierarchy:
Changed files:
Validation:
HOLD/UNKNOWN:
Next implementation entrypoint:
```

스킬 자체의 trigger나 AICC 배치를 바꿀 때만
[`references/trigger-boundaries.md`](references/trigger-boundaries.md)를 함께 검토한다.

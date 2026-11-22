---
name: distill-conversation-archives
description: 격리된 Codex·Web GPT 기록을 중복·손실 없이 정본 vault로 정리한다.
---

# 대화 아카이브 증류

대화 원천별 증류, owner-only 통합 bundle, canonical knowledge vault 편입을 분리한다.
절차와 상태 원장은 이 스킬이 소유하고 실제 원문 검토는 실행 때마다 격리된 작업자가 맡는다.

## 실행 모드 선택

- 한 원천만 갱신하면 해당 lane만 연다.
- Codex와 Web GPT를 모두 갱신해도 원문 검토는 두 lane으로 분리한다.
- 통합 bundle만 갱신하면 검증된 lane 번들만 읽고 원문 대화는 열지 않는다.
- canonical vault만 갱신하면 검증된 통합 bundle과 target vault 규약만 읽는다.
- 프로젝트 문서만 Wiki로 만들면 `$maintain-llm-wiki`를 직접 사용한다.

## 요청형 자동 실행

사용자가 대화 지식 증류를 요청하면 별도 명령 실행이나 수동 검수 절차를 사용자에게 넘기지 않고
에이전트가 이 스킬의 전체 pipeline을 수행한다. 각 호출은 시작 시각을 입력 경계로 고정하고
다음 순서를 지킨다.

1. 두 lane의 delta만 먼저 검사한다. `new=0`이고 `changed=0`이면 artifact, vault,
   checkpoint를 쓰지 않고 no-op으로 끝낸다.
2. 이미 다른 writer가 같은 staging 또는 승격 작업을 진행 중이면 병렬 writer를 열지 않고
   이번 실행을 건너뛴다.
3. 대화에 새 내용이 붙어 fingerprint 또는 revision이 달라지면 완료 목록에서 자동으로
   `changed` 입력으로 되돌린다.
4. 이전 증류 호출 자체의 제어 작업은 `EXCLUDED / DISTILLATION_CONTROL_TASK`로 판정해
   지식 후보와 통합 bundle에 넣지 않는다.
5. 원본 대화나 세션은 삭제·보관처리하지 않는다. 세션 정리는 별도 명시 요청과 안전 절차로만 한다.

예약 automation, daemon, watch mode, 원격 동기화는 만들지 않는다. 사용자는 평문으로
`대화 지식 증류해줘`라고 요청하거나 저장된 호출 프롬프트를 선택하면 충분하다.

## 작업자 격리

호스트가 하위 에이전트를 제공하면 실행마다 임시 작업자를 사용한다. 영구 작업자나
사용자 소유 작업을 미리 만들지 않는다. 하위 에이전트를 쓸 수 없으면 같은 경계를
지키며 lane을 순차 처리한다.

| 역할 | 읽을 수 있는 것 | 읽으면 안 되는 것 | 쓸 수 있는 것 |
| --- | --- | --- | --- |
| Codex lane | Codex 원장, exact new/changed rollout tail, 기존 Codex 번들 | Web GPT 원문·원장 | Codex staging·batch manifest |
| Web GPT lane | Web GPT 원장, exact new/changed conversation, 기존 Web GPT 번들 | Codex 원문·원장 | Web GPT staging·batch manifest |
| merger | 검증된 두 lane 번들, provenance, source snapshot | 양쪽 원문·세션 DB | owner-only 통합 staging |
| promoter | 검증된 통합 bundle, target vault 규약·기존 지식 | 원문 대화·세션 DB | source·review·도메인 staging |
| verifier | staging, manifests, source hashes, target lineage | 작성자의 결론 | 검증 보고서만 |

merger 외 writer를 두지 않는다. 병렬 작업자는 모두 read-only이며 서로의 중간 산출물을
읽지 않는다. host가 실제 격리 dispatch를 제공하지 않으면 독립 실행을 했다고 주장하지 않는다.

## 증분 입력 고정

1. 원본 아카이브와 현재 번들을 읽기 전용으로 고정한다.
2. lane 원장에서 ID와 content/revision fingerprint를 비교한다.
3. `new`와 `changed`만 입력으로 선택한다.
4. append-only가 입증된 `changed`는 checkpoint 이후 꼬리만 읽는다. 입증할 수 없으면
   그 대화 한 건만 전체 검토하고 corpus 전체로 넓히지 않는다.
5. `unchanged`, 이미 `EXCLUDED`된 항목, 해결되지 않은 `HOLD`는 재처리하지 않는다.
6. 제목·프롬프트·응답·원문·인증정보는 상태 원장에 복제하지 않는다.

상세 상태 형식과 gate는 [state-contract.md](references/state-contract.md)를 따른다.

## Lane 증류

각 입력을 `ADOPTED`, `EXCLUDED`, `HOLD`로 전수 판정한다.

- `ADOPTED`: 장기 재사용 가치가 있고 현재 정본과 충돌하지 않는 최소 의미만 기존 지식에 병합한다.
- `EXCLUDED`: 일회성, 중복, 시점 민감, 검증 불가, 완료된 작업 과정이다. reason code와
  fingerprint를 남겨 다시 검토하지 않는다.
- `HOLD`: 출처 부재, 충돌, 불완전, 민감 경계 때문에 판정할 수 없다. 해결 조건을 남긴다.

기존 지식 항목도 `retained`, `merged`, `superseded`, `hold` 중 하나로 계보를 남긴다.
기존 항목이 새 번들에서 조용히 사라지면 실패다.

## 통합 bundle 생성

1. 두 lane의 검증된 `current/`를 별도 읽기 전용 `sources/` 스냅샷으로 복사한다.
2. 파일별 SHA-256과 source revision을 기록한다.
3. `staging/`에서 중복·충돌·출처를 다시 검토한다.
4. 같은 의미는 한 항목으로 합치되 양쪽 provenance를 유지한다.
5. `_inbox`나 pending 문서는 현재 정본 대조 없이 자동 승격하지 않는다.
6. 개인정보·지원서 원문·거래·인증·세션 ID 원장은 통합 bundle에서 제외한다.
7. 제한 정보는 owner ledger 후보로만 최소화하고 기본 load path에서 제외한다.

통합 bundle의 `current/`는 조립·검증·복구가 끝난 source artifact다. 사용자가 그 경로를
지식 정본으로 명시하지 않은 한 최종 knowledge vault라고 부르지 않는다.

## Canonical vault 편입

1. `$maintain-llm-wiki`의 선택 규칙으로 실제 canonical vault를 찾는다.
2. target의 Home, Conventions, Update Workflow, 기존 MOC와 dirty state를 읽는다.
3. 통합 bundle 전체를 source record와 tree hash로 고정한다.
4. source Markdown 전부에 `absorbed`, `owner-ledger`, `source-meta`, `artifact-only` disposition과
   target lineage를 배정한다.
5. 범용 채택 주장만 target의 기존 도메인 템플릿으로 다시 쓰고 MOC에 연결한다.
6. 프로젝트 상태·제한 선호는 각 private owner 원장으로 분리한다.
7. target vault 검사기와 promotion manifest 검사가 PASS인 경우에만 편입 완료로 판정한다.

## 무손실 승격 Gate

다음을 모두 통과하기 전에는 lane checkpoint나 통합 baseline을 전진시키지 않는다.

1. 입력 ID 전수 disposition과 고유성
2. 기존 채택 지식의 retained/merged/superseded/hold 계보
3. source snapshot과 실제 입력 hash 일치
4. Markdown 내부 링크·고아 문서·중복 제목 검사
5. 절대 로컬 경로·이메일·비밀·대화 원문 패턴 검사
6. 기존 `current/` 복구점과 새 staging 전체 checksum
7. canonical vault source 전수 disposition과 target lineage
8. target vault의 기존 지식 보존, MOC·metadata·ghost link 검사
9. 독립 verifier의 실제 artifact와 promotion 결과 검사

검증 뒤 완성된 staging을 한 번에 승격하고 마지막 단계에서만 checkpoint를 갱신한다.
원본 아카이브, 이전 current, batch manifest를 삭제하지 않는다. 대화 삭제는 별도 요청과
별도 안전 절차다.

통합 프로젝트에서는 다음 검사도 실행한다.

```powershell
node C:\absolute\path\to\distill-conversation-archives\scripts\validate-distillation-project.mjs C:\absolute\path\to\project
```

첫 경로는 이 `SKILL.md`가 있는 폴더를 기준으로 해석한다. 스크립트는 읽기 전용 source
snapshot, hash, portable Markdown, 완료 baseline을 검사한다.

canonical vault 편입 뒤에는 다음 검사도 실행한다.

```powershell
node C:\absolute\path\to\distill-conversation-archives\scripts\validate-knowledge-promotion.mjs C:\absolute\path\to\fusion-project C:\absolute\path\to\vault
```

이 검사는 fusion `current/`의 모든 Markdown disposition, source tree hash, target note hash와
canonical vault 표식을 검증한다.

## 완료 보고

- lane별 `new / changed / unchanged / missing / unknown`
- lane별 `ADOPTED / EXCLUDED / HOLD`
- 기존 지식 `retained / merged / superseded / hold`
- source revision, 생성 문서 수, checksum·링크·민감정보 결과
- 통합 bundle 경로와 실제 canonical vault 경로를 구분해 보고
- source 파일 전수 disposition과 target vault 편입 문서 수
- checkpoint가 실제로 전진했는지와 남은 UNKNOWN/HOLD

사용자 요청 없이 스스로 갱신된다고 말하지 않는다. 요청을 받으면 delta 검사부터 검증·편입까지
에이전트가 수행하고 결과만 보고한다.

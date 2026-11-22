# 대화 증류 상태·승격 계약

## 1. 디렉터리 경계

```text
lane-home/
├── current/                 검증된 Markdown 번들
├── staging/                 이번 batch 작업 영역
├── state/
│   ├── processed.*          ID·fingerprint·disposition
│   ├── holds.*              해결 조건이 있는 HOLD
│   ├── reviews/             완료된 batch manifest
│   └── last-check.*         최신 증분 비교
└── tools/                   결정론적 검사기

fusion-project/
├── context/PROJECT.md
├── sources/codex/           읽기 전용 snapshot
├── sources/web-gpt/         읽기 전용 snapshot
├── staging/
├── current/
└── state/
    ├── source-snapshot.json
    └── knowledge-promotion.json

canonical-vault/
├── 00_Meta/sources/              통합 bundle 포인터·tree hash
├── 00_Meta/_new/llm-wiki/        검토 전·검토된 편입 draft
├── 00_Meta/reviews/llm-wiki/     전수 disposition과 결정
└── <domain>/{knowledge,playbooks} 채택 주장 재작성
```

lane state와 fusion source snapshot은 서로 다른 정본이다. lane state는 대화 처리 여부를,
fusion state는 검증된 bundle 파일의 통합 여부를 소유한다. canonical vault는 최종 재사용 지식을
소유하고 `knowledge-promotion.json`은 bundle에서 vault로 간 계보만 소유한다.

## 2. 최소 lane 레코드

```json
{
  "source": "codex-or-web-gpt",
  "opaqueId": "provider-owned-id",
  "revisionOrUpdatedAt": "opaque-revision",
  "contentFingerprint": "sha256",
  "semanticDisposition": "ADOPTED|EXCLUDED|HOLD",
  "knowledgeStatus": "REFLECTED|REVIEWED_NOT_RETAINED|NOT_REFLECTED_HOLD",
  "reasonCode": "LIMITED_REASON_CODE",
  "batchId": "stable-batch-id"
}
```

허용하지 않는 필드: 제목, 사용자 발화, 모델 응답, 원문 요약, 이메일, 계정 인증정보,
브라우저·세션 경로. 계정 구분이 필요하면 사용자 식별자가 아닌 로컬 alias만 쓴다.

이전 증류 호출을 실행한 Codex 제어 작업 자체는 재사용 지식이 아니다. 다음 호출에서 발견되면
`semanticDisposition=EXCLUDED`, `knowledgeStatus=REVIEWED_NOT_RETAINED`,
`reasonCode=DISTILLATION_CONTROL_TASK`로 기록한다. 다만 동일 대화의 revision 또는 content
fingerprint가 바뀐 일반 입력은 과거 완료 여부와 무관하게 `changed`로 다시 검토한다.

## 3. Batch manifest

manifest에는 입력 source revision, expected IDs, 각 ID disposition, staging bundle hash,
검사 결과를 둔다. expected IDs와 판정 IDs의 집합이 정확히 같아야 한다. 중복 ID, 누락,
알 수 없는 disposition, `ADOPTED`인데 반영 위치가 없는 항목이 하나라도 있으면 승격하지 않는다.

기존 지식에는 다음 계보를 별도로 둔다.

- `retained`: 의미와 출처가 유지됨
- `merged`: 다른 항목과 합쳐졌고 새 위치가 기록됨
- `superseded`: 더 권위 있는 현재 근거로 대체됐고 새 위치가 기록됨
- `hold`: 충돌 또는 출처 부족으로 기본 load에서 제외됨

`removed`만 있는 상태는 허용하지 않는다. 삭제가 필요하면 대체 근거 또는 명시적 제외 이유와
복구 가능한 이전 revision을 기록한다.

## 4. Checkpoint 순서

1. 현재 checkpoint를 읽는다.
2. new/changed ID를 고정한다.
3. staging과 batch manifest를 작성한다.
4. 원본·기존 current·staging을 독립 검증한다.
5. 기존 current의 복구점을 확인한다.
6. staging을 current로 원자적으로 승격한다.
7. post-read와 checksum을 수행한다.
8. 마지막에만 processed checkpoint와 fusion snapshot을 갱신한다.

canonical vault 편입이 요청 범위에 포함됐으면 8 전에 source record, 전수 disposition, target
lineage, vault 검사와 promotion manifest를 검증한다. fusion `current/`가 완성됐다는 이유만으로
지식 편입 checkpoint를 전진시키지 않는다.

4~7 중 하나라도 실패하면 checkpoint를 전진시키지 않는다. 같은 입력에서 재개할 수 있어야 한다.

## 5. 원천별 차이

### Codex

- DB의 ID·updated timestamp와 rollout fingerprint를 함께 사용한다.
- append-only rollout은 이전 byte offset 이후 꼬리를 검토할 수 있다.
- 현재·HOLD·개인·인증·거래 관련 세션은 증류할 수 있어도 삭제하지 않는다.

### Web GPT

- account alias + conversation ID를 복합키로 사용한다.
- catalog 존재와 원문 확보를 구분한다.
- HTTP 404, catalog 부재, 첨부 실패는 서로 다른 HOLD reason code로 둔다.
- 원격 대화·Project·GPT·Memory·Notion 쓰기는 별도 권한 없이는 수행하지 않는다.

## 6. 통합 source snapshot

`source-snapshot.json`은 최소한 schema version, fusion status, 생성 시각, lane별 상대경로·bytes·
SHA-256, 완료 시 최종 output inventory를 가진다. 원문 대화 ID를 포함하지 않는다.

`fusionStatus=complete`이면 실제 `current/`가 존재하고 output inventory와 정확히 일치해야 한다.
입력 파일이 바뀌면 전체 Wiki를 다시 만들지 않고 변경된 source 문서에 영향받는 항목만 재검토한다.

`knowledge-promotion.json`은 source root·Markdown 수·tree hash, canonical vault 논리 ID,
source 파일별 disposition과 target kind/path/hash, promotion status를 가진다. 절대 사용자 경로와
원문 대화 ID는 넣지 않는다. `promotionStatus=complete`는 source 전수 coverage와 모든 vault target
hash가 실제 파일과 일치할 때만 허용한다.

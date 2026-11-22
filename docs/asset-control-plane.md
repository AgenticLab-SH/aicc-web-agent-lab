# AI Asset Control Plane

AI Asset Control Plane은 Project, AICC skill, Codex plugin, ChatGPT Project와 Custom GPT를 하나의
inventory로 정규화한다. lifecycle·priority·next action은 Notion, local root·source revision·runtime
evidence는 로컬 소유자가 각각 권위자다. 한쪽 값을 다른 쪽으로 조용히 덮어쓰지 않는다.

## 현재 제공 표면

- stable kind-prefixed `assetId`, canonical owner, adapter, fingerprint와 sync state
- 기존 Project Catalog, `guidance/skills`, Extension Registry를 재사용하는 collector
- private adapter가 만든 secret-free ChatGPT visible snapshot의 owner-only import
- private adapter가 만든 다중 계정 대화·Project·Custom GPT 요약 카탈로그의 별도 owner-only import와 검색
- one-use confirmation, idempotency, precondition fingerprint, single writer와 `UNKNOWN` journal
- Notion `2026-03-11` data-source API의 schema inspection, bounded pagination, page precondition과 post-read
- 기존 Project priority outbox를 처리하는 exact-one Notion worker
- 6시간 간격의 저비용 scheduled audit; due가 아니면 Project/skill tree를 스캔하지 않음
- loopback `/api/assets`와 guarded operation endpoints

별도 dashboard나 daemon은 만들지 않는다. 기존 AICC server와 scheduler를 소비하며, 외부 ChatGPT UI
구현은 private adapter에 남긴다.

## 명령

```bash
aicc assets status --json
aicc assets audit --json
aicc assets audit --force --json
aicc assets import-chatgpt --file /absolute/owner-state/chatgpt-export.json --json
aicc assets import-chatgpt-catalog --file /absolute/owner-state/chatgpt-archive-source-catalog.json --json
aicc assets chatgpt-catalog --account account-alias --kind conversation --limit 25 --json
aicc assets notion-pull --config /absolute/owner-state/notion-connector.json --json
aicc assets notion-priority-worker \
  --config /absolute/owner-state/notion-connector.json \
  --operation priority-operation-id \
  --worker exact-worker-id \
  --json
aicc assets notion-asset-plan --config /absolute/owner-state/notion-asset-registry.json --json
aicc assets notion-asset-worker \
  --config /absolute/owner-state/notion-asset-registry.json \
  --operation approved-operation-id \
  --worker exact-worker-id \
  --json
```

`status`, `audit`, `import-chatgpt`, `import-chatgpt-catalog`, `chatgpt-catalog`, `notion-pull`은 외부
write를 하지 않는다. priority worker는 이미
preview/confirm된 outbox operation 한 건만 처리한다.

## Owner-local Notion 설정

설정과 token은 Git 밖에 둔다. token 값은 설정에 넣지 않고 명시한 환경 변수 이름만 기록한다.

```json
{
  "schemaVersion": 1,
  "profile": "projectCatalog",
  "dataSourceId": "00000000-0000-4000-8000-000000000000",
  "tokenEnv": "EXPLICIT_OWNER_NOTION_TOKEN",
  "properties": {
    "projectId": "Project ID",
    "title": "Name",
    "priority": "Priority",
    "lifecycle": "Lifecycle",
    "nextAction": "Next Action",
    "canonicalRoot": "Canonical Root",
    "repository": "Repository",
    "recordKind": "Kind"
  },
  "ideaKindValues": ["idea"]
}
```

AI Asset Registry는 별도 owner-local 설정에서 `profile`을 `assetRegistry`로 두고 다음 exact
property mapping을 사용한다.

```json
{
  "schemaVersion": 1,
  "profile": "assetRegistry",
  "dataSourceId": "00000000-0000-4000-8000-000000000000",
  "tokenEnv": "EXPLICIT_OWNER_NOTION_TOKEN",
  "properties": {
    "assetId": "Asset ID",
    "title": "Name",
    "assetKind": "Asset Kind",
    "remoteId": "Remote ID",
    "lifecycle": "Lifecycle",
    "syncState": "Sync Status"
  }
}
```

data source ID와 property 이름은 현재 schema를 읽어 exact match한다. title이나 URL에서 ID를 추측하지
않는다. read의 HTTP 429만 `Retry-After`를 존중해 한 번 재시도한다. PATCH timeout/5xx 또는 postcondition
불일치는 effect가 이미 발생했을 수 있으므로 `UNKNOWN`이며 blind retry하지 않는다.

## ChatGPT adapter 계약

open-AICC는 ChatGPT DOM, 계정, profile이나 locator를 소유하지 않는다. private adapter가 visible UI에서
account, workspace, Remote ID, name, Before hash와 Source hash를 확인한 뒤 secret-free export를 만든다.
open-AICC는 그 export만 owner-only state로 import한다.

대화 원문 보관은 private adapter가 별도 owner-only archive로 소유한다. open-AICC는 원문, prompt,
response, cookie, token, browser profile을 받지 않고 계정·종류·상태·제목·짧은 설명·개수만 있는 요약
카탈로그를 import한다. 대화 카탈로그는 수가 큰 시계열 자료이므로 Project/skill/plugin 중심의 기본
inventory에 합쳐 매번 출력하지 않는다. `/api/assets/chatgpt-catalog`과 `aicc assets chatgpt-catalog`의
검색·페이지 조회로만 제공한다.

요약 카탈로그 중 Project와 Custom GPT는 Notion reconciliation이 새 Remote ID를 볼 수 있도록 기본
AI 자산 inventory에도 `DISCOVERED` 관측으로 투영한다. 같은 Remote ID의 visible-UI snapshot이 있으면
그 관측이 이름·검증·sync state의 더 강한 근거이므로 archive projection을 덮어쓴다. conversation은
이 투영에 포함하지 않는다.

웹 대시보드는 이 loopback 조회 API의 얇은 소비자로만 둘 수 있다. raw archive, CDP lease, 계정 인증,
수집 재시도와 remote mutation을 웹 저장소로 옮기지 않는다.

in-app Browser가 기본 executor다. 등록 CDP는 AICC broker의 task-created target ID, lease ID, identity hash와
capability authorization이 있을 때만 사용한다. 기존 사용자 tab을 채택하거나 활성화하지 않는다.

## Mutation과 삭제 경계

| 동작 | 일반 제어면 |
| --- | --- |
| inspect/audit | 자동 허용 |
| Notion priority update | 기존 preview/confirm outbox 뒤 exact-one worker |
| ChatGPT create/update | R2 one-use 승인 + visible post-read |
| skill deploy/plugin disable | 기존 guidance/extension lifecycle 사용 |
| retire | R3 별도 action; adapter profile과 복구 증거가 없으면 HOLD |
| hard delete/public share/account switch | 일반 sync에서 제외 |

Notion API는 page의 영구 삭제를 제공하지 않는다. ChatGPT delete와 공개 범위 변경도 batch sync가 아닌
대상별 별도 재승인 작업이다.

## 검증

```bash
npm run check:assets
node --test test/server.test.mjs test/project-catalog-service.test.mjs test/public-contracts.test.mjs
```

contract 정본은 [`../contracts/assets/`](../contracts/assets/), 구현은
[`../src/assets/`](../src/assets/)에 있다.

2026-08-16 최초 live read-only canary에서는 기존 ChatGPT visible export 11개와 Notion AI Asset Registry
25행을 비교해 `IN_SYNC 11 / NOTION_ONLY 14`를 확인했다. 이후 다중 계정 archive catalog의 Project/GPT
summary projection을 합치고 누락 Custom GPT 2건을 고유 Remote ID로 Notion에 생성·사후 조회했다.
최종 mirror plan은 `IN_SYNC 26 / DRIFT 0 / PLANNED 0 / NOTION_ONLY 1`이다. 남은 1건은 기존 legacy
record이며 일반 동기화에서 삭제하지 않는다. 대화 1,178건은 별도 paginated catalog에만 있고 기본
asset inventory나 Notion registry에는 합치지 않는다.

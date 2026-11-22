# 동일 실행기로 Project와 사용자 지침 관리

코덱스는 로컬에서, 일반 Chat 지피티는 실제로 연결된 기존 호스트 실행 도구에서 private adapter의 `scripts/chatgpt-web-management-run.mjs`를 **node**로 실행한다. Bun의 Playwright CDP 연결은 이 경로에서 사용하지 않는다. Windows 파일은 웹 샌드박스가 아닌 기존 AICC 등록 작업공간으로 접근한다.

owner-local request JSON의 공통 필드:

```json
{
 "schemaVersion":1,
 "config":"ABSOLUTE_REGISTERED_ACCOUNT_CONFIG.json",
 "account":"REGISTERED_ALIAS",
 "identityHash":"EXACT_CURRENT_ACCOUNT_SHA256",
 "workspaceIdentityHash":"EXACT_CURRENT_WORKSPACE_SHA256",
 "action":"project-inspect",
 "remoteId":"g-p-EXACT_ID",
 "expectedName":"w-목적",
 "resultFile":"ABSOLUTE_PRIVATE_RESULT.json"
}
```

실행: `node ADAPTER_ROOT/scripts/chatgpt-web-management-run.mjs ABSOLUTE_REQUEST.json`.
실제 계정·workspace·lease는 기존 등록 설정에서 가져온다. request에 credential이나 session token을 넣지 않는다. 일반 Chat의 Windows 접근은 기존 AICC Workspace를 우선한다. 열린 등록 workspace의 실제 명령 capability, 해당 Node 실행 경로와 브라우저 관리 지원을 확인한 경우에만 같은 실행기를 호출한다. 파일 읽기 성공이나 node 명령 부재를 관리 권한의 증거로 쓰지 않는다. 관리 실행 기능이 노출되지 않으면 부족한 기능과 exact 작업을 기록하고 정상 배포·권한 등록으로 마련한다. RDC를 기본 경로나 자동 fallback으로 쓰지 않으며 AppContainer 설정·ACL·root·실행 복사본을 바꿔 거절을 우회하지 않는다. 이미 거절된 요청은 원거절의 정식 해소 전 재실행하거나 다른 도구에 맡기지 않는다. 실행 중 session은 같은 ID로 회수한다. 과거 RDC를 통한 Instructions 저장은 당시 실행 이력이며 현재 AICC 관리 기능의 성공 증거가 아니다.

## 작업별 필드

- `project-inspect`: exact ID의 이름, Instructions 원문, Sources 파일명·개수와 snapshotSHA256을 회수한다. 비어 있지 않은 Sources는 metadata 관측이며 원본 바이트 복구를 대신하지 않는다.
- `project-create`: remoteId 대신 `name`, `memory:"default"`, `instructions`, `sources:[]`, `commit:true`, `backupReceipt`를 사용한다. 새 이름의 stable assetKey는 `project|ALIAS|NAME`, operation=create, preimage는 빈 바이트 SHA, desired는 키 순서대로 `{name,memory,instructions,sources}`의 UTF-8 compact JSON SHA다. UI에서 기본 메모리 선택을 확인하고 shell만 만든다. `CREATED_CONFIGURATION_PENDING`은 전체 구성 완료가 아니다. exact 생성 ID를 읽고 아래 update/upload로 이어간다.
- `project-update`: fresh `preimageSHA256`, `desired:{name,instructions}`, `commit:true`, `backupReceipt`. assetKey는 `project|ALIAS|ID`, operation=update, desired는 키 순서대로 `{name,instructions}` compact JSON SHA다. 동일 이름/본문은 보존한다.
- `project-upload`: fresh preimage와 exact `sources:[{filename,path,sha256,sizeBytes}]`, commit/receipt. operation=source-update, desired는 `{filename,sha256,sizeBytes}` 배열 SHA, 해당 원본 bytes를 백업에 포함한다. 기존 같은 파일을 덮어쓰지 않는다. 업로드 후 원격 다운로드 바이트가 맞아야 완료다.
- `project-delete`: 이 adapter의 자동 삭제 범위는 **대화·소스가 모두 없는 명시 대상**이다. `confirm:"DELETE:EXACT_ID"`, `conversationCount:0`, `sourceCount:0`, fresh preimage, commit/receipt를 사용한다. operation=delete, desired는 빈 바이트 SHA, recoveryComplete=true. 채팅·자료가 있는 프로젝트는 전체 export/복구와 지원 삭제 경로를 먼저 마련하며 빈 프로젝트로 거짓 선언하지 않는다.
- `project-source-delete`: fresh Project preimage, `source:{filename,sha256,sizeBytes}`, commit/receipt를 사용한다. assetKey=`project|ALIAS|ID|source|FILENAME`, operation=delete, desired=빈 SHA, recoveryComplete=true. 원본 bytes를 양쪽 백업하고 원격 다운로드가 정확히 맞아야 한다. 삭제 메뉴 직전에 durable attempt를 남겨 즉시 삭제와 확인 dialog를 모두 처리한다. 같은 이름 다른 Source·자료 일괄 삭제는 하지 않는다. 교체는 기존 Source를 이 절차로 제거하고 새 exact bytes를 upload하는 두 거래로 기록한다.
- `plugin-delete`: exact `remoteId`, `expectedName`, `expectedVersion`, 전체 archive의 `preimageSHA256`, `confirm:"DELETE:EXACT_ID"`, commit/receipt. assetKey=`plugin|ID`, operation=delete, desired=빈 SHA, recoveryComplete=true. 추가 작업의 공식 삭제 확인 UI를 사용한다. 불명 응답은 official get_plugin_metadata의 같은 ID 결과와 조정하고 재삭제하지 않는다.
- `instructions-inspect`: 사용자 개인 설정의 실제 textarea 필드 label/placeholder/value를 읽는다. 화면 구조가 다르면 HOLD한다.
- `instructions-update`: inspect의 `preimageSHA256`, 동일 필드 결속의 `desiredFields`, commit/receipt. assetKey=`instructions|ALIAS|personalization`, operation=instructions-update, desired는 fields 배열 compact JSON SHA다. 해당 필드의 생성은 value 채우기, 삭제는 value 비우기다. 다른 설정은 보존한다.

## 백업과 미결 조정

양쪽 실제 bytes VERIFIED인 공통 asset-lifecycle 영수증을 사용한다. 호출자가 코덱스인지 지피티인지로 새 백업을 만들지 않는다. 저장 요청 직전 durable operation을 기록한다. 같은 receipt에 attempt가 있으면 자동 재실행하지 않는다. exact 원격 ID를 fresh read하고 이전 결과와 대조한다. 저장 클릭 전 실패가 명확하고 같은 preimage가 남아 있을 때만 failure/fresh evidence/reconciliation을 보존해 미전송 attempt를 분리한 뒤 같은 백업을 재사용한다. 저장 이후 불명은 확인 전 HOLD다.

프로젝트 구성은 design-chatgpt-projects의 목적·담당/비담당·정본·산출물·BASE/ACTIVE/ARCHIVE/REJECT 기준을 따른다. 이름 w-와 기본 메모리만 맞췄다고 지침/Source 설계까지 완료됐다고 쓰지 않는다.
사용자 지침의 현재 UI는 settings/personalization 페이지의 ‘ChatGPT 사용자 지정 지침 편집’ 버튼을 거친 별도 main 편집 페이지다. Codex 지침 버튼과 다른 프로필 필드는 보존한다. 프로젝트 삭제 확인은 ‘Chat 및 Work에서 삭제’라는 공통 자산 문구를 쓰며 모드 전환은 하지 않는다. 생성한 빈 점검 대상만 이 경로에서 삭제한다. 삭제 후 exact ID가 홈으로 리다이렉트되고 해당 ID 링크가 사라진 실제 읽기를 조정 근거로 남긴다.

## 기존 Project 메모리 변경의 공식 지원 범위 · 2026-10-23 KST

최신 [OpenAI 공식 Projects 안내](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)의 ‘Change a project’s memory setting’은 기존 프로젝트의 더 보기 → 프로젝트 설정 → Memory에서 Default memory / Project-only memory를 선택하고 저장하는 경로를 명시한다. 반영에 몇 시간이 걸릴 수 있다. 공유 프로젝트는 자동으로 project-only이며 default로 전환할 수 없다. 공유 해제를 일반 메모리 변경의 우회 수단으로 사용하지 않는다.

이는 플랫폼 지원 계약이며 현재 AICC 관리 실행기의 기능 추가·설치·작동 증거가 아니다. 현재 project-update는 desired.name/instructions만 지원한다. desired.memory를 추가해 호출하거나 기존 snapshot의 UNCHANGED를 실제 메모리 유형으로 해석하지 않는다. 직접 UI 작업도 실제 신원·exact Project ID·공유 상태와 현재 Memory control을 읽고, before/desired 원본 백업 및 단일 저장 계약을 충족할 때만 수행한다. 변경할 구체적 대상과 원하는 유형이 없는 이번 관리기 정비 요청으로 기존 프로젝트를 일괄 변경하지 않는다.

관리기 확장 시 inspect의 실제 memory 및 변경 가능 상태 → 같은 ID의 memory 전용 mutation → reload/readback을 함께 구현하고 owner binding/schema/설치본을 정상 갱신해야 한다. 새 프로젝트 생성·대화 이동·재생성으로 대신하지 않는다. 공식 문서만 확인하고 UI control을 관측하지 못했다면 실행 경로는 미구현으로 남긴다.

## 기존 Project 메모리 관리 구현 · 2026-10-23

실제 한국어 설정 화면에서 메모리 버튼 `프로젝트 전용`, 메뉴의 `기본`과 `프로젝트 전용` radio 옵션을 읽었다. 조회만 했으며 프로젝트 설정은 저장하지 않았다. 선택된 옵션이 채팅 확인 중 일시 비활성화되는 경우도 관측했다. 비활성 옵션을 강제 선택하거나 공유 프로젝트의 제한을 해제하지 않는다.

소스의 `project-inspect`는 현재 메모리 유형을 `default` / `project-only`로 반환하고 전체 snapshot에 포함한다. 지원 UI가 없으면 null이며 변경 요청은 HOLD다. `project-update`는 선택 필드 `desired.memory`를 지원하도록 작성했다. 새 필드가 없으면 기존 유형을 보존한다. desired 해시는 기존 `{name,instructions}` 뒤에 요청한 경우만 `memory`를 추가한 compact JSON이다. 변경 전 fresh snapshot 및 identity, 기존 GitHub/Notion 원문 백업과 mutation journal 계약을 유지한다. 첫 옵션 선택 전에 journal을 시작하며 저장 결과 불명은 `OUTCOME_UNKNOWN_RECONCILE`, automaticRetry=false다. 성공 판단에는 저장 후 실제 설정의 메모리 유형과 Sources 보존도 포함한다.

**배포 구분:** 위 기능은 소스 구현이며 검증 미실행이다. 기존 manager-4e2cd41905efc63b와 Workspace provider에는 아직 반영하지 않았다. 설치 provider가 새 필드를 거절하는 상태에서 직접 호출·다른 경로로 우회하지 않는다. 기존 pinned manager / provider 변경은 현재 활성 작업과 UNKNOWN을 보존하고 정상 배포 절차로 함께 적용한다. 이번 안내의 홈 배포는 실행기 배포나 실제 메모리 변경 성공을 뜻하지 않는다.

조회 보조 메뉴의 창 닫기에는 표시·활성 확인 후 클릭을 사용하도록 수정했다. 창 닫기 실패 시 부분 관측을 보존하고, 브라우저 disconnect 예외가 발생해도 exact lease release를 시도한다. 계정·프로필·사용자 기존 탭은 대상이 아니다.

## 프로젝트 표시 이름

지피티(ChatGPT Web) 프로젝트는 `w-`, 로컬 코덱스(CLI·Desktop) 프로젝트는 `l-`을 앞에 붙인다. 예: `w-유튜브 스크립트 정리`, `l-trading-automation`. 이미 맞는 접두사가 있으면 유지하고 반대 접두사 하나는 교체하며 중첩하지 않는다. 이는 표시 이름 규칙이며 경로·저장소·논리 ID·원격 ID·route alias를 바꾸지 않는다.

대상별 stable ID·현재 이름·원하는 이름으로 명칭 변경 계획을 만들고 중복 이름을 먼저 해소한다. 이름만 바꿀 때 지침·소스·대화를 다시 작성하지 않는다. 제외 대상과 타인 소유 대상은 보존한다. 코덱스 프로젝트와 대화 제목을 혼동하지 않으며 지원되는 프로젝트 이름 변경 기능이 없으면 경로 변경이나 내부 DB 편집으로 대신하지 않는다.

이름은 작업 중 바뀔 수 있다. exact ID의 실제 현재 제목이 예상과 다르면 기존 mutation 결과·최신 목록을 먼저 조정한다. 옛 이름 locator 시간초과를 자산 삭제·로그아웃으로 단정하거나 같은 실패를 전체 프로젝트에 반복하지 않는다.


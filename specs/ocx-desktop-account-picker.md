# Codex Desktop 모델 메뉴에서 OCX 계정별 Sol 6.1 High 선택

## 상태 · 2026-10-23
- 의도: 신규 Codex Desktop 대화를 계정 1/2/3/4 중 하나의 OCX 물리 계정에 처음부터 고정하며, 모델 GPT-6.1 Sol과 노력도 High를 단일 메뉴 항목으로 고른다.
- 소유자: open-AICC(Windows 로컬 OCX 외부 어댑터), codex-chatgpt-web-private(17841 카탈로그와 Codex Desktop 통합/rollback), A1 OCX Hub(계정 identity/credential 단독 writer).
- 이번 상태: SOURCE_INTEGRATED_TESTED / PRODUCTION_HOLD. 외부 어댑터·17841·관리형 Desktop catalog transaction에 결합했다. 격리된 source 경로에서 실제 지정 계정 High 1회 HTTP200, 한도 차단 계정 물리전송0을 확인했다. 설치본·Desktop 메뉴·일반 Chat 전체 E2E는 미완료다.
- 제품 구현: tools/platform/opencodex/external-account-picker.ts / external-pool-state.ts. 기존 candidate 경로는 호환 re-export로 유지한다.
- 격리 테스트 후보: test/desktop-account-picker-candidate.test.ts
- 기존 계약: context/PROJECT.md, tools/platform/opencodex/README.md, specs/independent-codex-cli-routes(spec에서 Desktop 전환은 제외), 개인 저장소의 src/model-catalog.ts / src/server.ts / src/codex-integration.ts. 이 문서는 위 정본의 역할을 대체하지 않고 새 변경 범위만 규정한다.

## 현재 이관 · 2026-10-23 19:02 KST

- 최신 상태는 SOURCE_DELTA_CHECKED / PRIVATE_FULL_TYPECHECK_HOLD / PRODUCTION_HOLD다. 아래 2026-10-22 구현/141개 검사·실 canary는 과거 증거이며 재실행하지 않았다. 이 절과 기존 owner operation의 CURRENT.md를 먼저 인수한다.
- 원 전체 이관: 00000000-0000-4000-8000-000000000000 / turn01a16823-5070-7291-8310-96fdcdc9cde3. 이번 개발 담당 01a1618b-adde-7d70-a407-1d36a9d75526은 단일 writer로 소스 및 명시 검사만 수행하고 메인01a160f7에 반환한다. 이번 turn/URL은 도구 미제공 UNKNOWN·발명0. 옛 준비대기 상태로 되돌리지 않는다.
- 서버의 unconditional bounded_direct_read로 끊긴 Fast Read를 server.mjs와 필수 fast-read.mjs에 연결했다. 기존 byte 페이지/base64/검색 예산·고정 문자열·민감 경로·read store/CLI writer guard는 보존한다. 완전한 snapshot만 제한 응답 캐시를 사용하고 untracked 누락 시 live bounded 경로, tracked drift 시 fail closed한다. read_many는 기존 직접 페이지 방식이다.
- 실제 source: components/workspace-mcp/server.mjs, fast-read.mjs 및 두 지정 test. PRIVATE는 scripts/aicc-local-tools.d.mts와 tests/aicc-local-tools.test.ts만 변경해 기존 helper의 정확한 타입과 null 계약을 연결했다. 계정 picker server 의존 타입 검사 exit0, Workspace/Fast Read 20통과·실패0·환경 제외2, helper3통과. 전체 PRIVATE 타입 검사에는 다른 테스트 파일 8오류가 남으며 기존 오류로 입증된 것이 아니다. 정확 명령/분류/담당은 기존 CURRENT.md에 기록했다.
- 정식 bundle은 bun@1.4.0을 요구하고 검사 실행기 배너는 1.3.14였으므로 release 가능성을 확정하지 않는다. build/설치/버전 변경0. 등록 root 보안 수락/관리자 PrepareOnly/fresh 복구 READY·active/unknown/CAS·관리형 서비스별 적용은 메인 담당이다. ACL·production AppContainer·실 canary·계정/route·catalog·Desktop 화면·일반 Chat 운영 검증 미실행. 과거 26개 모델·Web/Native·기존 대화·다른 dirty 원문 보존.
## 최종 사용자 경험
Codex Desktop의 기존 모델 선택 메뉴에 아래와 같은 행을 보여준다.

~~~text
GPT-6.1 Sol                       [기존, OCX 자동 풀 / 기존 대화 유지]
OCX · 계정 1 · Sol 6.1 · High     [실제 계정 1에만 연결]
OCX · 계정 2 · Sol 6.1 · High     [실제 계정 2에만 연결]
OCX · 계정 3 · Sol 6.1 · High     [실제 계정 3에만 연결]
OCX · 계정 4 · Sol 6.1 · High     [실제 계정 4에만 연결]
Web · 계정 1 ...                  [기존 Web GPT 전부 유지]
~~~

표시 번호는 A1의 검증된 계정 별칭을 사용한다. 현재 계정 목록을 단순 정렬하여 새 번호를 부여하지 않는다. A1 계정 수에 따라 표시 행 수가 달라지며, Team/Plus 계획 여부가 라우팅 판단을 자동으로 대신하지 않는다.

사용자가 새 대화에서 account-specific 행을 선택하면 모델 ID는 고정된 A1 공개 selector와 결합한 selector/gpt-6.1-sol이다. 별도의 selector/gpt-6.1-sol--high ID를 만들지 않는다. UI 메타데이터의 default_reasoning_level=high와 supported_reasoning_levels=[high]가 메뉴를 담당하며, Windows OCX 요청 준비 시 wire reasoning.effort=high를 반드시 검사한다.

변경하지 않는 기존 bare gpt-6.1-sol 대화는 지금의 OCX 자동 풀을 계속 사용한다. 사용자가 계정별 모델을 선택한 새 대화는 해당 물리 계정으로만 전송된다. 한도/인증/권한 문제가 생기면 다른 Plus 계정, Native 또는 API키로 몰래 우회하지 않고 오류를 반환한다.

## 설계 당시 기준선 · 2026-10-21 (아래 구현 인수 절 우선)
- Codex Desktop은 gpt-6.1-sol / high / http://127.0.0.1:17841/v1을 사용한다.
- 전역 model_catalog_json이 .codex-chatgpt-web/desktop-models.json을 가리킨다. 읽은 정적 목록에는 총 26행(기본 10, Web GPT 16), OCX 계정 고정 행 0개가 있다.
- 등록된 Windows OCX: upstream 2.81.0, AICC 외부 adapter 0.1.1, 실제 requestExecution=windows-local, credentialWriter=a1. 공급자 원본을 손대면 안 된다.
- 로컬 OCX 미러에는 codexAccountPickerEnabled=false, A1 공개 namespace와 현재 pool 대상 사이에 유효성 대조가 필요한 오래된 매핑 하나가 있다.
- 2026-10-21 로컬 미러의 네 개 계정 plan 표시는 Plus 2/Team 2였다. 사용자가 설명한 Plus 4와 불일치하므로 적용 시 A1의 실제 identity와 quota를 재조회한다. 정적 순서/이메일/다른 제품의 번호로 추측 금지.
- 실효 Windows 한도 정책은 5시간/장기 양쪽 97% 차단으로 문서화되어 있다. 로컬 미러의 autoSwitchThreshold=95는 서버 실효 정책을 대체할 수 없다.
- 현재 external-stock-dispatch.ts의 buildCatalog는 accountSelectors=[]이며 맨 마지막에 bare model slug만 남긴다. 단순 플래그 on으로는 10100 카탈로그가 account-bound로 바뀌지 않는다.
- external-pool-state.ts selectOne은 명시 bound에서도 전역 selected/pin/priority 처리와 persistSelection이 실행될 수 있다. 이 기능에서 반드시 분리해야 한다.
- 개인 17841 bridge의 modelsRequest는 nativeModelCatalogPath 또는 native forward를 augmentNativeModelCatalog에 넣고 Web 모델을 합친다. Desktop은 그 결과와 별개인 정적 catalog 소유 파일을 쓰므로 두 경로의 모델 동기화가 필요하다.
- OpenCodex upstream 2.81.0은 selector/native-model 라우팅을 구현하며 명시 선택에 대해 다른 계정 fallback을 의도하지 않는다. 단 일부 Desktop 릴리스가 타사 행을 숨기는 renderer allowlist가 있어 실제 picker 표시는 별도 검증해야 한다.

## 아키텍처와 불변 규칙

~~~text
A1 Hub:
  codexAccountNamespaces(public selector -> private account id)
  identity + model entitlement + quota + refresh credential writer
          |
          | 현재 승인된 credential lease / 비민감 snapshot만
          v
Windows OCX 외부 adapter (10100):
  roster(account id) -> account-specific Sol entitlement
  기존 bare stock catalog + high-only qualified rows
  explicit-bound selector -> 정확히 한 계정
  60s quota freshness / generation-fence / no retry
          ^
          | 17841의 기존 보안 인증 전달
AICC 17841:
  chatgpt-web/* 는 기존 Web 경로
  다른 모든 모델(qualified OCX 포함)은 모델 ID를 보존해 OCX로 전달
          ^
          |
Codex Desktop:
  managed journal v7 -> static desktop-models.json
  기존 Native/Web 26행 + 검증된 OCX qualified 행
~~~

- A1 계정 인증이나 원문 메일을 Desktop 목록/17841/Web 설정으로 전달하지 않는다.
- 공개 selector가 물리 계정의 authoritative 매핑이고, 표시 alias/번호가 실제 route를 결정하지 않는다.
- 카탈로그는 계정 지원 가능성을 표시하는 목록일 뿐, 모델 호출 허가증이 아니다. dispatch 전 fresh quota + credential generation + roster를 재확인한다.
- static picker label에 변동 quota 사용률을 새로 쓰지 않는다. 사용률과 갱신 시각은 기존 AICC 한도 화면에서 확인한다. 네이티브 메뉴의 실시간 숫자 표시를 주장하지 않는다.
- 6개 기존 대화의 모델, 저장 history, 암호문, issuer, 기존 Web GPT 16개/Native 모델 목록을 변경하지 않는다.

## 실제 코드 결합 위치

### 1. Windows OCX 카탈로그 생성: open-AICC
파일: tools/platform/opencodex/external-pool-state.ts
함수: createExternalPoolState().catalog()

현재 로직은 각 계정에서 roster(id)를 호출해 native 슬러그를 union한 뒤, stock.buildCatalog(config,observed)를 반환한다. 여기서 계정별 roster도 동시에 수집해 A1 current namespaces와 정확히 대조한 verifiedTargets를 만든다. main, stale, paused, credential terminal, roster lookup 실패, gpt-6.1-sol entitlement 없는 계정은 행을 만들지 않는다.

비민감 별칭은 A1이 실제 관리하는 별칭에서 email 부분을 제거한 검증된 publicLabel을 사용하고, alias가 모호하면 행 광고를 보류한다. 수집한 targets를 후보 makePinnedHighRows(stockCatalog, verifiedTargets)에 주고 반환된 계정 행만 원본 bare catalog 뒤에 합친다. stock source/빌드 절차를 직접 수정하지 않는다.

파일: tools/platform/opencodex/external-stock-dispatch.ts
현재 stock.buildCatalog 안의 accountSelectors=[]와 bare-only 필터 때문에 일반 upstream selector 행은 나오지 않는다. 이번 방식은 vendor의 기존 bare builder 결과 다음에 위 pure projection을 더하므로 upstream provider 본체 패치가 불필요하다. 기존 resolveRoute는 selector/gpt-6.1-sol → modelId=gpt-6.1-sol + codexAccountId로 해석해야 한다. codexAccountPickerEnabled=false는 catalog visibility만 숨기고 exact routing은 유지하는 계약을 fake-runner로 확인한다. 계정마다 합격한 모델만 projection한다.

파일: tools/platform/opencodex/external-runtime.ts
기존 GET /catalog /models 인증 경계를 유지하며 account-bound 행을 같이 반환한다. 보안 노출이 넓은 새로운 계정/토큰 API를 개설하지 않는다.

### 2. Windows OCX 물리 계정 선택: open-AICC
파일: tools/platform/opencodex/external-pool-state.ts
함수: createExternalPoolState().selectOne()

현재 qualified 변수는 stock previewRouteModel이 반환한 실제 accountId다. qualified가 있을 때는 우선 후보를 딱 해당 한 계정으로 좁힌다. 후보의 존재와 prior issuer가 다른 계정인지 후보 selectExactBoundAccount로 확인하고, 기존 계정별 fresh quota / model roster / generation checks는 그대로 적용한다.

반드시 다음 세 가지를 분리한다.
1. qualified 요청에는 다른 global selected 계정의 stop 검사, activeCodexAccountPinned에 의한 persistSelection, 전역 priority ceiling/sort를 적용하지 않는다.
2. qualified 요청 성공은 전역 selected를 persistSelection(row.id)로 바꾸지 않는다. 현재 전역 선택은 unqualified Pool 요청에만 영향을 준다.
3. qualified가 quota 97% 이상, 모델 미지원, pause/reauth이면 1회 dispatch도 하지 않는다. 다른 후보를 찾지 않는다.

추가로 prior issuer가 이미 존재하고 이번 명시 계정이 다르면 pinned_thread_account_change_refused를 반환한다. 기존 encrypted reasoning, previous_response_id, fileId를 다른 계정으로 자동 scrub/이관하지 않는다. 안전한 새로운 계정에서 작업하려면 별도의 신규 대화를 사용한다.

최종 dispatch용 preparedBody를 만들기 직전에 후보 enforceBoundSolHigh(originalBody, qualified, requestedQualifiedModel)를 적용한다. 명시적인 Low/xhigh 등의 노력도는 거절하고, reasoning 누락이면 high로 보정한다. Web 모델 또는 기존 bare Sol에는 손대지 않는다. 실제 model은 stock wire gpt-6.1-sol로 변환하고, 요청 credential만 정확한 A1 계정 lease로 교체한다. 원래 외부 boundary의 단일 전송·취소·no replay 계약 유지.

### 3. Desktop 카탈로그와 17841: 개인 저장소 소유
파일: codex-chatgpt-web-private/src/model-catalog.ts
함수: augmentNativeModelCatalog()

원래 nativeRows + Web rows를 만드는 함수는 계속 한 곳만 정본으로 두고, 검증된 OCX /catalog qualified row만 삽입하는 인자 또는 좁은 owner-side projection을 추가한다. stage의 mergeDesktopCatalog는 기존 행 전부를 보존하고 우리 marker(aicc-ocx-picker-high-v1)가 붙은 행만 교체하며, foreign ID 충돌을 거절한다. Native template의 context, comp_hash, tool mode와 High-only metadata를 보존한다.

파일: codex-chatgpt-web-private/src/server.ts
modelsRequest()의 source는 nativeModelCatalogPath 파일일 수도 있으므로 10100 /catalog만 고쳐서는 17841 모델 목록이 자동으로 바뀌지 않는다. 기존 17841 호출자 인증/OCX Bearer 전달 owner 경로에서 로컬 OCX /catalog의 인증된 safe rows를 조회해 native+Web에 병합해야 한다. 브리지의 사용자 프로필/token을 직접 열지 않고 기존 로컬 data credential을 재사용한다. 브라우저 모델 chatgpt-web/* 분기는 손대지 않는다.

파일: codex-chatgpt-web-private/src/codex-integration.ts
함수: installCodexDesktopCatalog(), journal v7

Codex Desktop은 정적 model_catalog_json을 사용하므로 src/server.ts의 /models 변경만으로 메뉴가 바뀌지는 않는다. 기존 관리 journal과 원본 preimage CAS/rollback 경로를 통해 desktop-models.json을 갱신하는 owner-only transaction을 추가한다. 26행의 정확한 모델 id/메타데이터와 Web 16개는 그대로 두고 qualified 행만 추가한다. 기존 설치 트랜잭션 보호 조건(기존 Native+8개 기본 Web 모델 등)은 유지해야 한다.

실제 주입 전 해당 버전의 Codex Desktop app-server model/list가 모델 항목을 실제 반환/표시하는지 확인한다. 일부 공식 앱 빌드에서는 외부 namespace가 Custom으로 나오거나 목록에서 숨겨질 수 있다. 설치 실패/버전 미지원이라고 구분하고 임의 renderer 바이너리 패치나 사용자 프로필 재로그인을 금지한다.

## 인터페이스 요약

~~~ts
type VerifiedAccount = {
  selector: string; publicLabel: string; present: boolean;
  credentialAvailable: boolean; paused: boolean;
  entitledModels: string[] | null;
};

// A1 current identity / model roster를 읽은 뒤:
const qualifiedRows = makePinnedHighRows(nativeStockCatalog, verifiedAccounts);

// 기존 managed Desktop catalog 소유 트랜잭션의 후보 산출:
const proposedCatalog = mergeDesktopCatalog(currentDesktopCatalog, qualifiedRows);

// request route는 vendor lookup이 먼저 물리 계정 ID를 확인:
const bound = selectExactBoundAccount(
  routing.accountId, physicalCandidates, priorIssuerAccountId
);
// bound인 경우에는 전역 selected/pin/priority 상태를 건드리지 않는다.
// quota/entitlement/generation 검증이 끝난 뒤:
const prepared = enforceBoundSolHigh(body, routing.accountId, requestedModel);
// prepared의 model은 기존 stock routing.wireModel로 바꾸어 단 1회 전송한다.
~~~

위는 결합 대상 위치를 설명하는 의사 코드이며, 현재 구동 파일에 import/호출된 상태가 아니다. 후보 코드는 네트워크/파일/계정/서비스 부작용이 없는 순수 함수다.

## 적용 준비와 인수 순서
1. 후속 Codex가 open-AICC, 개인 bridge 저장소, Windows installed adapter/manifest, A1 current Hub의 현재 SHA·Git dirty·동시 writer를 대조한다. 원본 소스의 SHA가 달라졌으면 해당 함수/호출부부터 최신으로 대조한다.
2. A1 실제 계정 identity, 검증된 공개 번호와 selector, 실효 한도/사용권을 읽는다. local mirror의 Plus2/Team2와 사용자가 생각하는 Plus4 차이를 그대로 확정하지 않는다.
3. 후보 코드와 fake A1 fixtures를 기존 파일에 좁게 병합하고 아직 설치하지 않는다. 공급자 패키지 원본과 A1 refresh grant 소유권을 유지한다.
4. 후보 catalog의 정확한 diff를 만든다. 구 Desktop 26행, Web 16개, bare Sol, Native 경로가 변하지 않고 계정 행만 추가됐는지 inspect한다.
5. 사용자 후속 적용 요청과 실제 독립 복구 READY, 해당 소유자의 idle 및 unknown=0, 요청 중단 권한, 설치 전 바이트 백업·CAS/rollback을 확보한 다음에만 단계별 적용한다.
6. 승인된 실제 검증에서 신규 소규모 대화 하나만 account-qualified Sol High로 보낸다. requested model ID, A1의 returned non-sensitive accountSelector와 실제 wire reasoning.effort=high 및 HTTP 완료를 대조한다.
7. 실패 사례: stale/main/duplicate selector, 계정 stop 97%, reauth, entitlement 없음, 다른 prior issuer, Low/xhigh, quota stale, ocx down, static catalog 중간 실패, Desktop allowlist 차단. 모두 auto fallback 0, Native/Web 영향 없음.
8. 기존 6개 대화/소유 미확정 session은 강제 중지·모델 변경·리플레이하지 않는다. 전체 영향 확인 후 완료/보류를 context/PROJECT.md의 담당자 정본에 기록한다.

## 구현 인수 · 2026-10-22
- public 작성 범위: external-account-picker.ts, external-pool-state.ts, candidate 호환 entrypoint, Workspace server/broker 및 기존 Codex CLI writer guard와 관련 테스트. private 작성 범위: model-catalog.ts, server.ts, native-passthrough.ts, codex-integration.ts, 새 ocx-account-catalog.ts와 테스트. 공급자 원본 수정0.
- explicit account는 전역 selected/pin/priority ceiling 및 persistSelection에서 분리했다. 기존 issuer와 다른 계정은 거절하며, quota/roster/generation과 단일 물리전송 예산을 유지한다. bare 자동선택과 Web browser 분기는 유지한다.
- A1 current namespace와 물리 roster/credential generation을 대조했다. 표시 번호는 current alias에서만 가져오며 stale selector는 광고하지 않는다. 실제 quota 및 모델 사용권 영수증은 private owner operation에 둔다.
- Desktop owner 함수 updateCodexDesktopAccountCatalog는 기존 v7 journal lock, CAS, 원문 backup 및 보상 rollback을 재사용한다. 실제 26행/Web16을 모두 보존한 30행 review projection만 생성했고, 사용 중인 catalog 파일은 변경하지 않았다.
- Workspace 실제 선행 실패: 관련 없는 별도 CLI binding의 퇴역 binary를 일반 writer guard가 검사해 ENOENT를 반환했다. source에서 일반 writer 잠금 확인과 CLI 실행기 검증을 분리했고, 기존 미확정 writer.lock 보호는 유지한다.
- Workspace ACL 실패: 등록 root의 전용 AppContainer Modify ACE 부재, ancestor capability는 정상적인 비상속 ReadAttributes+Traverse만 존재했다. 현재 비상승 token으로 ACL 적용이 실제 거절됐으며 root ACL 불변이다. /C로 실패를 지나가지 않도록 바꾸고 정확한 ACE readback 전 lowbox 실행을 거절한다. 다른 실행기·관리자 우회0.
- 격리 AppContainer fixture에서 최종 source의 명령/폴더/UTF8 쓰기·읽기 성공. 새 patch 부모 생성/ADS·escape 거절, 기존 runtime integrity와 CLI writer 회귀를 수행했다. public/private 관련 테스트 총141 PASS. private 전체 typecheck는 이번 미변경 파일의10개 오류로 실패했으며 전체PASS가 아니다.
- 실제 요청 검증: 별도 임시 source home과 새 request ID만 사용해 한도 차단은 전송0, 지정 계정은 wire High/1회전송/HTTP200/marker/active0을 회수했다. 기존 Desktop 대화의 실행·변경·재전송0, 서비스/로그인/인증저장소 교체0.
- 운영 HOLD: 10100/17841의 실제 활성 요청이 관측됐고 operation-specific 독립 복구 READY 및 source/installed 교체용 전체 unknown0는 확보하지 않았다. 과거 READY를 재사용하지 않는다. root 보안 거절은 소유자의 정식 제한 ACL 정비가 선행되어야 하며 다른 executor로 우회하지 않는다.
- 다음: 소유자가 root의 exact SID 제한 ACL을 정식 조정 → fresh single-writer/active0/unknown0/원본hash/독립복구READY → 기존 관리형 교체 절차로 Workspace, OCX,17841을 각각 적용 → owner Desktop catalog transaction → 신규 대화 picker 및 일반 Chat 전체 E2E. 이전6개 대화·Native/Web·기존26행은 보존한다.
- private 정본: owner operation workspace-picker-20261022의 CURRENT.md와 원본·검사·live-canary·ACL 영수증. HOME 중앙 PROJECT/execution 및 다른 담당 current 절은 수정하지 않는다.
## 후속 요청에 사용할 짧은 지시

### Workspace broker 보안 후보의 정식 교체 계약 · 2026-10-25

기존 `Update-AiccWebManagementRuntime.ps1`의 명시적 `workspace-broker-security-update` 종류를 사용한다. `backend-policy-update`의 기존 8파일 허용 목록은 그대로다. 새 종류는 broker의 승인된 `bdd8ca28…` → `de42e808…` 바이트와 소스 표준사용자 수용 영수증에 고정한다. 전체 실제 before/desired inventory와 동일 파일 집합을 대조하고 broker·`.aicc-release.json`·`workspace-drive-manifest.json` 3파일만 변경할 수 있다. manifest는 원 metadata에서 broker row·counter·overlay만 파생하며 기존 stale row는 수리하지 않는다. owner config·manager binding은 동일 바이트이고 gateway code·host·Native·tool 권위는 그대로다. Workspace의 immutable backend 경로와 dependency pin, profile의 exact gateway 경로만 교체한다.

Prepare는 새 helper·후보·inventory·수용 근거·원/새 3파일 및 gateway/config/profile/registry/launcher/task receipt 복구 delta의 GitHub/Notion VERIFIED 백업을 요구한다. 원 source-read/PK02 후보·backup·helper pin은 갱신하지 않는다. Apply는 fresh independent READY와 같은 plan/challenge의 consumed 3-provider drain(active=0, unknown=0), 원 preimage CAS를 확인하고 기존 owned-runtime stop·journal·단일 start를 따른다. Rollback은 보관한 원 byte pin·원 backend/graph·현재 component CAS를 먼저 검증하며 다른 변경을 덮어쓰지 않는다. `START_ACCEPTED_RUNTIME_UNOBSERVED`는 시작 접수이며 설치판 broker 보안·picker 실사용 완료가 아니다. 소스 표준사용자 수용을 설치판 수용으로 승격하지 않는다.

open-AICC의 specs/ocx-desktop-account-picker.md와 두 후보 코드를 읽고, 최신 A1/Windows OCX/17841/Desktop 소유 설정 및 두 Git dirty를 대조해서 정확한 call site에 병합해. 기존 6개 대화와 Native/Web 경로, 97% quota 보호를 유지하고, 독립 복구·정확한 idle 및 변경 전 원본 백업이 확인된 범위에서만 배포해. 모델 High와 물리 계정 선택을 별도 영수증으로 검증하고, 다른 계정으로 자동 fallback하거나 불명확한 요청을 재전송하지 마.

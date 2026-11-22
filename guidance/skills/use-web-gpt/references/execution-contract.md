# Web GPT 실행 경계

route·계정·기존 대화·브라우저·로컬 workspace 접근이 작업에 포함될 때만 읽는다.

## 경로

- **일반 Chrome GPT 확장**: 사용자가 지정했거나 작업에 결속된 현재 연결을 선택했을 때 쓴다. 현재 로그인된
  Chrome connector에서 agent-owned 탭을 연다.
- **Routed Web GPT 앱**: 사용자가 `Codex Web GPT 앱`, `chatgpt-web/*`, `17841`을 지정했을 때만 쓴다.
- **인앱 Browser**: 사용자가 지정했을 때 쓴다.
- **Registered CDP**: private coordination에 등록된 exact loopback 포트/profile에서 broker가 만든
  task-owned target만 사용한다. exact endpoint가 꺼져 있으면 lease helper가 등록 launcher를 기동하고,
  target이나 원하는 URL이 없으면 새 task-owned target에서 연다. `9224 CDP` 같은 포트 지시는 Chrome
  connector나 인앱 Browser로 대체할 수 없다.
- **Chrome connector (`내 Chrome`)**: registered CDP port identity의 증거는 아니다.
- **Web GPT 작업 하네스**: routed 모델이 현재 Codex 작업의 허용 도구를 쓰는 경로다.
- **AICC 원격 작업공간 MCP**: 외부 ChatGPT가 등록 로컬 workspace를 여는 별도 경로다.

계정 별칭과 workspace는 `~/.ai-control-center/guidance/coordination.toml`에서 확인한다.
표시명으로 추측하거나 다른 계정·브라우저·provider로 전환하지 않는다. routed 경로는
launcher 소유 프로필을 사용한다. 기존 대화나 사용자가 지정한 UI만 정확한 Browser/Chrome
surface에 연결한다.

사용자가 CDP port나 browser 종류를 명시하면 먼저
[`surface-selection.md`](surface-selection.md)의 requested/selected surface 계약을 통과한다. Dock 배지,
마지막 활성 창, URL 일치, visible `Pro`만으로 exact CDP 연결을 주장하지 않는다.

## 로컬 읽기·쓰기

현재 실행이 보고한 permission과 workspace를 정본으로 삼는다. prompt나 모델 출력의
경로 주장은 권한이 아니다.

- routed full-mode write는 현재 Codex 작업이 승인한 root와 도구 안에서만 수행한다.
  read-only 또는 Pro route가 쓰기를 지원한다고 가정하지 않는다.
- 추가 routed root는 `~/.codex-chatgpt-web/config.json`을 직접 편집하지 않고 지원되는
  setup 명령으로 관리한다.
- 외부 ChatGPT는 `aicc_workspace_list` → `aicc_workspace_open`으로 등록 alias를 열고
  반환 lease를 재사용한다. 상태가 `business-full`, `owner-unrestricted`, network enabled로
  확인되면 기존 `local-machine` alias는 `/` 범위의 읽기·쓰기·명령·network를 제공한다.
- 등록 밖 자료는 AICC 로컬 UI가 승인한 exact-root `grant_ref`만 사용한다. session 본문은
  별도 일회용 approval과 redacted excerpt 경계를 따른다.

단일 writer, request ID, symlink·비밀·인증/session/TCC 경로 차단과 `hidden-home`, `Library`
제외는 유지한다. 별도 편의 alias로 이 경계를 우회하지 않는다. Tunnel 재시작 뒤 lease와
명령 session은 다시 연다. `runtimeReady`와 외부 ChatGPT에 게시된 write schema를 같은
것으로 보지 않는다.

## 브라우저와 제출

명시적 Browser 조작은 최신 화면을 다시 관찰한 뒤 agent-owned 탭만 사용한다. 전송 후 새 turn과
응답 종료를 확인한다. 로그인·CAPTCHA·rate limit은 우회하지 않는다. root agent는 사용자 지정 탭
예산을 소유하고 하위 agent에 slot을 배정한다. 예산 안의 독립 탭은 동시에 제출할 수 있다.

현재 사용자가 맡긴 Web GPT 작업 자체가 목적 달성에 필요한 ordinary Chat 대화 생성, prompt 작성·입력,
관련 파일 첨부, 전송과 같은 대화의 후속 전송을 승인한다. agent는 작업 범위 안에서 exact prompt·첨부·
대화·전송 시점을 스스로 정하며 아래 silent preflight 뒤 바로 진행한다. 전송 직전 사용자 승인을 다시
묻거나 기다리지 않는다. `WAIT_UNTIL` 재개도 재승인이 필요 없다. `HOLD`만으로 send 0회를 뜻하지 않으며 stage·dispatch 기록·원 turn을 보고 미전송과 전송불명을 구분한다. 사용자가
`준비만`·`초안만`·`보내지 마`라고 명시한 경우와 계정·route·publication·Project/Custom GPT 자산 변경·
공유·삭제는 이 자율 권한에 포함되지 않는다.

1. browser account identity/alias, root/agent/task ID, 선택 surface와 사용자 탭 예산을 확정하고
   agent-owned tab/target을 먼저 잡는다.
2. prompt와 첨부를 준비한 뒤 실제 send 직전에 해당 task의 중복 제출만 원자적으로 막는다. 다른
   agent-owned 탭에는 인위적 account/global 최소 간격을 적용하지 않는다.
3. 새 user turn이 보이면 즉시 `commit(submittedAt)`한다. 이후 응답 실패도 제출로 남긴다. click
   뒤 확인이 불확실하면 `submission_uncertain`으로 보수 기록하고 조용히 재시도하지 않는다.
4. 완료 성공/응답 실패를 outcome으로 기록한다. rate limit, soft pause, security challenge 또는
   capacity 신호가 실제로 관찰된 surface/account만 짧게 backoff하고 다른 계정·browser·provider로
   우회하지 않는다. 성공하면 자동 backoff를 즉시 해제한다.

ordinary Chat의 silent preflight에 다른 Codex task active/UNKNOWN 조회나 17841 non-browser HTTP idle 조건을
추가하지 않는다. registered CDP의 dormant listener는 exact launcher를 기동해 해소하며, 기동·identity·target
생성 실패가 확인된 뒤에만 send 0/HOLD로 기록한다.

지원되는 Observer로 응답을 회수할 때는 `watch_id`별 단일 서버 waiter를 사용한다. 정확한 prompt SHA-256과 첨부 identity가
일치한 새 user-turn ID를 먼저 고정하고, DOM 순서 또는 저장 대화 parent 관계상 그 뒤에 연결된
assistant-turn ID만 추적한다. 다른 탭의 최신 assistant, 전역 stop button, 제목 유사성, 마지막 DOM
텍스트만으로 완료를 추정하지 않는다. `notGenerating=true`, response-scoped completion action,
안정된 full content가 함께 확인되기 전에는 완료가 아니다. 결과와 파일은 content-addressed artifact로
보존하며 byte 수·SHA-256을 재검증한다. 현재 agent turn 안의 bounded wait는 `web_gpt_watch_wait`
한 번으로 처리하고 agent별 polling loop를 만들지 않는다. 일반 Chrome의 옛 Observer 확장 첨부 주입과 `web_gpt_followup_enqueue` 자동 발신 dispatcher는
2026-10-11 폐기됐다. 과거 watch·queue·도구 이름이나 확장 버전 설명만으로 현재 전달을 주장하지 않는다.
현재 선택한 surface가 실제 제공하는 파일 첨부·전송 기능을 사용한다. registered CDP는 아래 기존 전송기,
completed CDP watch의 단발 결과 전달은 `web-codex-handoff`의 지원 transport를 따른다.
queue 등록은 실제 전송 증거가 아니다.
Pro처럼 응답 시간이 일정하지 않은 장시간 생성은 agent가 완료 시각을 추정하거나 5분마다 UI를
조회하지 않는다. watch와 exact task callback을 먼저 결합한 owner-only one-shot worker가 Observer의
terminal event를 기다리고, 완료·실패 artifact 메타데이터를 검증된 결과 파일로 쓴 뒤 원래 Codex task가
idle일 때 `turn/start`를 정확히 한 번 호출한다. 응답 원문은 callback prompt에 넣지 않고 재개된 agent가
`web_gpt_watch_get`과 `web_gpt_artifact_read`로 읽는다. 반복 heartbeat·recurring automation·DOM polling은
금지하며, 응답 자동 회수가 필요한데 지원 observer/callback을 묶을 수 없으면 `RESPONSE_HOLD`와 exact watch·conversation identity만
남기고 재전송하지 않는다. task-owned 저장 대화의 장기 stall reconcile은 surface adapter가 durable
watch identity를 유지할 때만 코드에서 한 번 수행하며 사용자 탭은 새로고침하지 않는다.

공유 원장은 `~/.ai-control-center/web-gpt-submit-cadence/ledger.json`이며 parent `0700`, file
`0600`이다. 정상 상태의 account/global submit 하한은 0초이고 reservation은 15초 뒤 stale 처리한다.
명시적 provider pause는 15초부터 최대 60초까지 해당 surface/account에만 적용하며 15분이 지나면
만료된다. 그 뒤 성공 1회는 누적 backoff를 즉시 해제한다. wall-clock rollback과 unsafe/invalid
ledger는 fail closed하되 정상 병렬 탭을 직렬화하지 않는다.

원장 event에는 숫자 timestamp, opaque SHA-256 account/task key, random reservation ID,
reservation state, outcome code와 필요한 expiry/`blockedUntil`/soft-pause code만 둔다. prompt,
응답, URL, cookie, 계정 표시명, credential, token, session 원문을 남기지 않는다.

Browser/Chrome/Computer Use는 Workspace MCP가 아니다. 현재 Codex 작업이 별도 네이티브
기능으로 제공할 때만 쓴다. 경로 실패는 `aicc web-gpt status --json`과 `doctor`로 확인하고
다른 실행 경로로 조용히 대체하지 않는다.

모델 선택기 의미 근거가 불명확하면 [기존 모델 선택기 사례](../../web-gpt-driving/references/failure-solutions.md#모델-선택기의-로딩과-의미-결속-실패)의 실패 분류를 따른다. 숫자 index·트리거 전체 문자열·Plugins 혼입을 요청 모델/effort 근거로 쓰지 않는다. 이 사례의 구현은 소스 수정안·실제 성공 미확인이며 한도429·무인 재개 성공과 분리한다.

## 등록 브라우저의 공통 전송 절차

1. 현재 등록 정보에서 private adapter 저장소와 Bun, account role과 exact slot을 찾는다. 표시 순서·포트를 계정 번호로 추정하지 않는다. 꺼진 전용 브라우저는 기존 등록 launcher·프로필로 자동 준비하며 다시 승인받지 않는다.
2. 목표·자료 역할·보존/제외·출력·누락 범위가 담긴 UTF-8 prompt와 필요한 첨부만 준비한다. sender는 Bun, 개인 스킬 manager는 Node를 쓴다. 런타임을 서로 바꾸지 않는다.
3. 기존 `chatgpt:send-and-collect`를 한 번 실행한다. 아래 값은 작업별 실제 등록값·절대 경로·고유 owner ID로 채운다. slot 이름은 호환 selector이며 실제 role/identity는 등록값과 로그인 상태로 확인한다. 첨부가 없으면 해당 인수를 생략한다. 현재 최대 첨부1개이므로 여러 파일이 필요하면 관련 파일만 ZIP으로 묶는다.

```powershell
& $registeredBun run --cwd $privateAdapterRoot chatgpt:send-and-collect `
  --slot $registeredSlot --model xhigh --owner-id $requestOwner `
  --prompt-file $promptFile --attachment $attachmentFile --result-file $receiptFile
```

사용자가 결과를 직접 기다리거나 나중에 알려주겠다고 한 경우 `--handoff-after-submit`을 추가한다.
exact 저장 user turn 확인 뒤 `SUBMITTED`로 반환하고 같은 대화 target을 보존해 lease만 반환한다.
답변은 `NOT_COLLECTED`이며 제작·설치 완료로 보고하지 않는다. 기본 호출은 답변 회수를 기다린다.
현재 source/CLI가 지원하는 옵션만 사용한다.

4. 새 task-owned 일반 Chat·기존 turn0에서만 복원 초안과 미제출 첨부를 정리한다. 업로드와 전송 직전 확인은 같은 composer form의 공통 첨부 인식을 사용한다. 앱이 file input을 비워도 실제 파일명 버튼과 제거 버튼을 한 첨부로 센다. 이름·개수가 모호하면 정리·전송하지 않는다.
5. prompt 전체, 첨부 이름/바이트/SHA-256, 같은 신원·Chat·요청 모델, 유일 활성 보내기를 결속해1회 제출한다. 저장 user turn과 실제 대화 URL은 접수 증거다. 작업 시작 응답, 최종 산출물, 코덱스 반영은 별도다.
6. 클릭 뒤 읽기 API429나 빈 DOM이면 원 request·target·URL과 전송불명을 보존한다. 옛 `data-message-author-role`/`article` 선택자0은 미전송 증거가 아니다. 같은 신원·소유 target의 원 saved URL에서 실제 전문·첨부·대응 응답을 조정한다. 허용된 지연 후 새로고침1회는 조건부 회수이며 실패하면 반복하거나 다른 계정/API로 우회하지 않는다. [첨부·저장 읽기 사례](../../web-gpt-driving/references/failure-solutions.md#첨부-인식-불일치와-전송-뒤-읽기429)를 따른다.
7. receipt에 request ID, 실제 URL, 전송 횟수 또는 unknown, 첨부 근거, 접수/응답 상태, target 보존과 lease 반환을 따로 남긴다. URL·종료 코드 하나를 성공으로 바꾸지 않는다. 반환 시간 초과는 정확한 기존 lease부터 조정한다.

소스 수정·홈 적용과 실제 전달 관측을 구분한다. 새 코드의 검증은 현재 모델 정책과 사용자 명시 범위를 따르며 수정만으로 실제 전달 성공을 선언하지 않는다.

## 저장 대화 중복 탭 정리

`saved-followup`는 요청 불명·응답 감시를 보존하려고 작업 탭을 남긴다. 대화의 계속 사용과 모든 과거 탭의 보존은 다르다. 결과와 작성권을 인수한 후 같은 URL의 대표 탭 하나를 기존 원장에 지정하고, 역할이 끝난 정확한 중복 target만 닫는다.

생성 전 기존 작업 원장에 `purpose`, `owner`, `conversationUrl`, `lifetime`, `closeWhen`을 적고, 생성 후 `targetId`와 대표 target을 결속한다. 별도 새 원장은 만들지 않는다. 임시 검토/읽기 탭은 결과 보관·작성권 반환이 종료 조건이며 저장 대화에 후속 일이 남아도 탭 종료가 가능하다. 진행 중 응답·미제출 초안·첨부·사용자 인계·원요청 불명으로 보존하면 구체적 이유와 다음 재검토 사건을 적는다. 평상시 소유/읽기 불명은 보존하며, 사용자가 특정 등록 슬롯의 미사용 탭 정리를 명시적으로 맡긴 경우에만 별도 정확 목록·같은 대화 keeper·현재 활성 lease 부재·초안 읽기 가능 여부를 기록해 그 승인 범위의 중복 화면을 정리한다. 응답 없는 화면의 초안 미확인을 빈 초안으로 보고하지 않는다.

private adapter의 `scripts/chatgpt-retire-duplicate-targets.mjs --plan <owner-local JSON> --result <new receipt>`는 현재 등록된 9223 범위에서 생성·KeepTarget 반환 이력의 해시, 같은 saved URL의 별도 keeper, 활성 lease 부재, 현재 생성 중 아님·빈 초안·첨부 없음을 확인하고 대상별로 닫는다. plan은 `port`, `keepers:[{id,url}]`, `targets:[{id,url,owner}]`다. 대상 생성 이력이 없거나 현재 읽기가 실패하면 보존한다. 포트 범위 확대는 별도 구현·검증이 필요하며 다른 슬롯으로 우회하지 않는다. 이 명령은 저장 대화 삭제·전송·새 대화 생성·초안 정리를 하지 않는다.

예전 `close-completed`는 단일 새 Chat 영수증에 맞춘 도구이므로 saved-followup 영수증을 억지로 변환하지 않는다. 종료 실패·초안·불명 상태는 원장에 대상별로 남기며 성공 수와 남은 수를 실제 탭 목록으로 확인한다.

## 도구 이름

브라우저의 작업용 탭을 열고 prompt를 전송한 뒤 해당 응답을 가져오는 로컬 도구는 **지피티 대화 전송·응답 회수 도구**라고 부른다. 등록 브라우저의 전송·회수는 기존 도구를 재사용하며 에이전트마다 별도 전송기를 만들지 않는다. registered CDP 구현은 private adapter의 `REGISTERED_PRIVATE_ADAPTER_ROOT/scripts/chatgpt-registered-review-turn.mjs`이며 `chatgpt:send-and-collect` 명령으로 실행한다. 기존 `chatgpt:registered-review`는 호환 이름이다. 단순히 자동실행기라고 부르지 않으며 OCX 계정 전환·상시 감시와 구분한다.

실행 인수·런타임·사용자 결과 인계는 [공통 실행 절차](execution-contract.md#등록-브라우저의-공통-전송-절차)를 따른다. 사용자가 결과가 나오면 알려주겠다고 한 경우 접수까지만 확인하고 인계하며 완료 감시·재전송을 추가하지 않는다.

## 정확한 응답 감시

입력창 구조·복원 도구 mention·클릭 뒤 저장 미확인에서는 [기존 복구 사례](../../web-gpt-driving/references/failure-solutions.md#입력창-구조-변경도구-mention-복원저장-직렬화)를 필요한 범위만 읽는다. 고정 ID나 innerText 하나에 의존하지 않고, 원문·같은 form·원 turn을 결속한다. 입력 실패와 클릭 후 불명을 구분하며 후자는 원결과 조정 전 재전송하지 않는다.


- 초기 pending DOM은 미전송 증거가 아니다. 탭 목록은 살아 있고 특정 탭 제어만 실패하면 전체 로그인·확장 장애로 단정하지 않는다. 같은 신원·연결의 새 소유 탭에서 exact URL 읽기 회수가 허용되는 조건과 한도 배너 판정은 `web-gpt-driving/references/failure-solutions.md`를 따른다. 원래 요청은 다시 보내지 않는다.

- 응답 회수가 필요한 작업은 지원되는 Observer가 있을 때 전송 전 exact prompt·첨부 hash·owner task·surface·owned target에 watch를 묶고 새 user/assistant turn을
  response-scoped로 증명한다. observer 실패를 재전송이나 surface 변경 사유로 삼지 않는다.
- turn 안에서는 bounded waiter를 한 번만 쓰고 장시간 응답은 Observer와 exact task callback one-shot으로
  기다린다. 결과 artifact는 끝까지 읽어 byte 수와 SHA-256을 검증한다.
- CDP·Chrome claim, 첨부 staging, queue/steer와 장기 대기는 `execution-contract.md`를 따른다. 큰 첨부는
  `context-and-prompting.md`를 함께 읽는다.

## 현재 Web 대화에서 직접 완수하기

이 스킬이 ChatGPT Web에서 읽혔다는 이유만으로 같은 질문을 다른 AI나 Codex에 다시 보내지 않는다. 현재 대화의 실제 도구로 가능한 조사·문서·분석은 직접 완수한다. 사용자가 지정한 별도 표면이나 구체적인 독립 검토 필요가 있을 때 기존 전송 절차를 쓴다. 호스트 작업이 필요한 단계의 도구 부족과 Web 답변 작성 가능 여부를 분리한다.

프로젝트·지침·GPT 스킬 관리는 각각 manage-chatgpt-assets와 manage-chatgpt-skills의 기존 코드 manager를 사용한다. 관리 자동화가 있는데 확장 수작업 설치·클릭 반복으로 대신하지 않는다. 스킬 수정 뒤에는 지피티 영향도와 변경 동기화 상태를 함께 남긴다.

## 화면 사용 한도 안내

이 환경의 workspace 사용 한도 배너는 Codex 사용량 안내이며 일반 Chat 작업을 막는 조건으로 쓰지 않는다. 기존 OCX의 계정 전환·소진 전 차단을 유지하고 승인된 작업을 이어간다. 실제 요청 거절·OCX 차단과 MCP 429는 [공통 운영 기준](../../manage-chatgpt-skills/references/quota-and-connection.md)으로 분리한다. 사용자가 xhigh 유지를 명시한 작업에서는 high로 낮추지 않는다.

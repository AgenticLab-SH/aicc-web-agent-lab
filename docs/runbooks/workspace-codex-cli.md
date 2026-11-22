# 지피티에서 Native·OCX Codex CLI 사용

지피티는 ChatGPT Web 일반 Chat, 코덱스는 로컬 CLI·Desktop이다. Desktop 연결,
Windows 터미널의 CLI, 일반 Chat Workspace 도구는 별개 사용 경로다.

## 현재 상태

2026-11-02 정정: 공식 supplier 2.96.0과 독립 AICC adapter의 실제 설치를 구분한다. 신규 요청의 상한은 5시간 97%, 주간·장기 98%이며 더 낮은 사용자 설정은 유지한다. 저장 설정뿐 아니라 설치된 `/api/aicc-local/policy`에서 실제 값을 확인한다. 실패 SSE 종료를 관측한 요청은 연결 EOF를 기다리지 않고 정산하며, 과거 UNKNOWN과 실제 진행 중 요청의 보호는 유지한다. 자동·우선·고정 시작 및 우선 계정 한도 시 대체 계정의 실제 응답을 확인했다. 고정 계정의 한도 차단은 다른 계정으로 바꾸지 않는다. 아래 날짜별 기록은 당시 근거다.

2026-10-24 KST 현재: AI 협업 기반만 진행한다. 설치판의 작성자 검사와 현재 Codex 실행파일 pin을 기존 권한·거절 목록 그대로 교체했다. 독립 로컬 실행·fresh active0/unknown0·정상 정지·단일 시작 영수증은 `.ai-control-center/backups/cowork-runtime-compat-20261024/review/workspace-activation`에 있다. 아래 2026-10-20 결과는 과거 근거이며 이번 일반 Chat extra high의 AICC 읽기·쓰기·명령 종단 검증과 구분한다.
일반 Chat 계정1 실확인: AICC 문서·스킬 읽기와 Get-Location 종료0을 확인하고 이 운영기록을 AICC patch로 반영했다. 계정2 및 다른 제품의 완료를 뜻하지 않는다.

2026-10-20 KST: Native/OCX CLI와 일반 Chat start/status 설치·도구 갱신·실호출 검증 완료.
동일 기존 앱 AICC Workspace · Windows 22의57개 도구 활성화와 실제 일반 Chat 도구14개 응답을 확인했다.
최종 설치본에서 두 경로 모두 gpt-6.1-sol/medium, turn.started/completed, 종료0, 같은 한글 결과와 SHA를 회수했다. 시험 lease0, 새 Gateway OPEN/active0/unknown0 확인.
Job launcher의 VoidTaskResult stdout 오염과 작업공간별 binding 연결을 수정해 실제 적용했다.
기존 AppContainer·Desktop·OCX 모델 서비스·계정·로그인을 보존했고 원 w-커뮤니케이션 요청을 재전송하지 않았다.
## 터미널

### 기존 compat 대화에 접수된 큐 재개 · 2026-11-02

`aicc codex ocx`의 `aicc-ocx-compat`는 기존 관리형 실행기가 프로세스에만
등록하는 provider다. 저장된 대화에는 이 이름이 남지만 공유 HOME에는 없어도 된다.
일반 `codex queue --resume`이 메시지를 접수한 뒤 `modelProviderNotConfigured`
`-32600`으로 실패하면 모델 전송 실패와 큐 접수를 구분한다. 접수된 메시지를
다시 보내거나 대화 metadata/provider를 고치지 않는다.

원 작성자가 끝났고 해당 root의 다음 작업을 인수했는지 확인한 뒤, 그 root의
터미널에서 기존 지원 명령 `aicc codex ocx --no-alt-screen resume <exact UUID>`로
재개한다. 새 prompt/계정/provider override 없이 기존 실행기의 provider 등록과
child-env 인증 전달을 사용하며, 접수된 큐가 기존 대화의 새 turn을 시작한다.
실제 큐 trigger/turn ID, 모델 응답·도구 실행과 OCX issuer를 확인한 뒤에만
재개 완료로 기록한다. 최초 불명 업무 요청을 재생하는 절차가 아니다.

이 절차는 공유 config·모델 서비스·인증·다른 대화를 재시작하거나 새 alias를
영구 설치하지 않는다. 일반 큐 명령 자체에 provider 상속이 추가된 것도 아니다.
해당 기능의 향후 개선은 별도 owner 변경이며, 현재는 등록된 호환 실행기를 쓴다.
2026-11-02에는 기존 worker 대화의 접수된 단일 지시를 이 경로로 재개해
실제 모델 응답/도구 실행/issuer를 확인했다. 다른 pending 대화의 자동 시작은 하지 않았다.

### 새 CLI 작업의 OCX 계정 고정

먼저 `aicc codex accounts`로 `A1 e-8`처럼 표시되는 계정 번호와 짧은 이름을 읽는다. `--json`도 내부 선택자 ID를 표시하지 않는다. 번호는 소유자가 붙인 `1번(이름)` 별칭을 기준으로 하며, 우선순위나 목록 순서를 뜻하지 않는다. 짧은 이름은 첫 글자와 끝 글자를 사용하고 충돌하면 앞부분을 늘린다. 이 조회는 실시간 한도·실제 계정 접수 확인이 아니며, 로그인 정보·토큰·계정 우선순위를 변경하지 않는다.

`aicc codex ocx --account 1 --route-model gpt-6.1-sol --route-effort high -C '<Git root>'`로 1번 계정을 고른다. `--route-account 1`도 같다. 실행기는 최신 로컬 등록에서 번호를 내부 연결로 바꾸고 실행 직전에 같은 계정인지 다시 확인한다. 번호 중복·삭제·일시 정지·연결 변경은 다른 계정으로 넘기지 않고 거절한다. 지원되는 로컬 계정 연결이 없는 remote-client도 거절한다. CLI는 전역 account use나 로그인 설정 변경을 호출하지 않는다. 외부 OCX adapter의 계정 수락·한도·503 복구는 별도 실행 근거로 확인하며 이 CLI의 로컬 준비 성공만으로 실제 모델 요청 성공을 선언하지 않는다. 기술 호환용 `--route-account <기존 내부 선택자>`는 유지하되 일반 사용자는 계정 번호를 쓴다.

command-route-r2의 계정 지정은 공유 HOME의 단일 OCX catalog에서 metadata를 복사한 프로세스 전용 카탈로그만 생성하며, picker 광고가 꺼져 있어도 등록된 exact 선택자를 사용할 수 있다. 모델 서비스·전역 설정을 변경하거나 picker를 켜지 않는다. 카탈로그는 자식 CLI가 종료할 때 해당 파일과 빈 폴더만 정리한다. 비정상 종료 잔여를 자동 전체 삭제하지 않는다.

Windows 기존 터미널 실행기에는 `-Account 1`을 추가한다. 기술 호환용 `-AccountSelector`는 유지하지만 화면에는 내부 ID를 출력하지 않는다. 현재 트레이의 계정 드롭다운 추가와 설치된 트레이 실행기는 별개다. 소스 변경·CLI 적용·실제 계정 요청 성공은 각각 기록한다. 기존 대화를 resume할 때는 원 작성권·기존 시작 계정/불명 요청부터 조정하고 계정 고정 옵션으로 불명 요청을 다시 보내지 않는다.

로컬 Windows에서는 트레이 상태 창의 `CLI` 탭 안에서 OCX/Native·Git root·모델·medium/high를 고른 뒤 새 터미널을 연다. 우클릭 `Codex CLI · 경로 선택 → OCX로 시작 / Native로 시작`과 `도구` 탭 두 버튼도 같은 내부 CLI 탭으로 이동한다. 탭 이동 시 입력값을 보존하고 선택만으로 실행하지 않는다. 사용자 설명은 `docs/user-guide.html#codex-cli`, 에이전트 절차는 `manage-codex-model-routes`다. 2026-10-20 tray735f1d21ee7323d8에 빌드·설치했으며 실행기 전달/거절 및 창 입력 상태 시험을 통과했다. 새 트레이를 누른 실제 모델 추론 E2E를 추가로 실행한 것은 아니다.

```powershell
aicc codex ocx --route-model gpt-6.1-sol --route-effort medium exec `
  -C '<Git 작업공간>' --sandbox workspace-write -o '<결과 파일>' -
aicc codex native --route-model gpt-6.1-sol --route-effort medium exec `
  -C '<Git 작업공간>' --sandbox workspace-write -o '<결과 파일>' -
```

두 명령은 동일 공식 Codex 실행 파일의 endpoint·provider를 process별로 고정한다.
새 `--route-effort`는 `model_reasoning_effort` 하나만 설정하고 전역 설정을 쓰지 않는다.
compat는 route/auth/catalog/profile override를 차단한다. 명시 -m/--model과 좁은 사용자 설정 -c는 command-route-r2에서 지원하며 일반 config 전체 허용은 아니다.
모델과 추론 수준은 별개다. 6.1은 명시하고 이전 기본 모델을 최신으로 추정하지 않는다.
한글은 UTF-8 stdin 또는 UTF-8 파일을 사용하며 ASCII 번역은 필수가 아니다.
현재 관리형 PowerShell·CMD aicc 진입점에서 위 두 옵션을 사용할 수 있다.

`aicc codex status --json`의 ready는 로컬 executable/catalog 조건이다. status 명령은
실시간 OCX health·ready·모델 광고나 inference를 실행하지 않는다. OCX launch 직전에는
기존 preflight가 세 조건을 확인한다. managed-local/remote-client는 opencodex provider,
standalone은 openai provider에 OCX endpoint를 지정하므로 provider 이름만으로 모든
배포의 실제 경로를 판정하지 않는다.

## 일반 Chat의 전용 도구

owner binding을 활성화하고 기존 Workspace 플러그인에 실제 게시한 환경에서만 사용한다.
도구가 안 보이면 일반 exec·다른 계정·RDC로 우회하지 않는다. Codex turn token은 필요 없다.

1. 등록된 정확한 Git root alias의 write lease와 UTF-8 지시 파일을 준비한다.
2. 실제 aicc_codex_cli_start에 workspace_id/lease, 호출별 request_id, 지속할 operation_id,
   route(native 또는 ocx), model, reasoning_effort, prompt_path, prompt_sha256를 전달한다.
3. aicc_codex_cli_status로 같은 operation_id를 회수한다. 연결이 끊겨도 원 ID부터 조회한다.
4. TASK_STARTED는 실제 turn.started, COMPLETED는 종료0·turn.completed·최종파일 SHA 결속이다.
   DISPATCHING, thread ID, ready, PID는 작업 완료가 아니다.
5. 최종 응답의 원격 ID·업로드·배포 결과는 해당 업무의 별도 실제 근거로 판단한다.
6. 작업 종료 뒤 lease를 반환한다. 활성 프로세스·preflight가 있으면 close를 거절한다.

처리 중에는 같은 workspace의 일반 write를 차단한다. 시간 제한·lease 만료·host 종료 시
기존 Windows Job Object로 해당 자식 트리를 종료한다. 불명 결과는 journal/writer.lock을
보존하며 소유자의 원 작업 조정 전 자동 잠금 해제·재전송·경로 대체를 하지 않는다.

응답은 요청 route/model/effort와 설정 provider, 실제 관측 session/turn을 구분한다.
관측하지 못한 provider는 null이며 설정값을 관측 로그로 바꾸어 보고하지 않는다.
원 로그·tool 출력은 기본 반환하지 않고 최종 응답만 회수한다. 결과물의 승인 범위는
지시 작성자가 유지한다.

## 권한과 적용

일반 exec AppContainer는 해제하지 않는다. 전용 기능은 로컬 owner가 고정한 Codex 실행기,
PowerShell, Job launcher, 하나의 Git root, 허용 모델·effort, prompt/output/time 한도로 등록한다.
원격 입력에는 실행 파일·임의 shell·config·계정·절대 작업 경로를 받지 않는다.
child는 현재 Codex home/auth와 신뢰된 MCP 설정을 사용한다. workspace-write가 외부 MCP까지
격리한다고 주장하지 않는다. 이 실행 권한과 child의 도구 설정까지 검토한 뒤 활성화한다.

설정의 codexCli는 기본 미등록이다. 활성화에는 enabled:true, bindingFile, bindingSha256가
필요하다. owner binding schemaVersion1/kind aicc-codex-cli-owner-binding은 provider의
bindingFor 계약을 따른다. authority·operationDirectory·실행 코드는 task workspace 밖에 둔다.
blockedPromptHashes는 원 보안 거절을 보존하며 문구를 바꾸어 우회하지 않는다.

적용 준비에는 binding·고정 launcher/Job 사본·원 설정 SHA·desired config를 결속한다.
적용 담당은 실제 원본 byte 백업과 독립 복구 READY, fresh checkpoint·active=0·
unknown=0·rollback을 확보한 뒤 이 변경 파일만 설치본과 병합한다. dirty source 전체를
배포하지 않는다. 기존 Web 자산 관리 updater의 action 변경으로 위장해 Codex 권한을 설치하지 않는다.
Native/OCX/Desktop을 재시작하지 않고 Workspace schema와 기존 PRIVATE 플러그인 metadata를
같은 계약으로 배포한다. 실제 도구 발견·요청된 canary 전에는 사용 가능으로 표시하지 않는다.
롤백은 exact 이전 config와 Workspace/gateway 릴리스만 복원하고 journal·계정은 보존한다.
설정은 `codexCli: { enabled: true, bindings: { '<exact alias>': { bindingFile, bindingSha256 } } }`로 작업공간별 authority를 각각 결속할 수 있다. 각 binding은 하나의 등록 Git root만 허용한다. 현재 검토용 후보는 인용 작업의 private 저장소 한 곳이며 다른 등록 저장소는 활성화하지 않았다.

## 설치 어댑터와 적용 영수증

tools/platform/workspace-mcp/Install-AiccCodexCliRuntime.ps1 -PreimageRoot <owner-backup>는 기존 관리형 설치본에 이번 차이만 합성한다. CLI는 route/cli 두 파일, Workspace는 dispatcher·schema·lifecycle 접점과 필요한 CLI 의존을 반영한다. 다른 source 변경 전체를 배포하지 않는다. manifest와 runtime-stage.json을 기록하며 서비스는 시작하지 않는다.

Activate-AiccCodexCliRuntime.ps1 -OperationDirectory <prepared-review/workspace-activation>는 준비된 plan·원본 설정·Task·profile과 gateway operation을 사용한다. live lease가 있으면 강제 반환 없이 중단한다. 현재 executor가 대상 tree의 자손이면 독립 복구가 필요하므로 적용하지 않는다. 기존 gateway begin/consume으로 active/unknown=0 snapshot을 소비하고 정확한 idle tree를 planned-maintenance-stop한 뒤 config/registry/profile을 교체한다. 시작은 한 번만 요청하며 START_ACCEPTED_RUNTIME_UNOBSERVED로 기록한다. health·실제 ChatGPT 호출 성공과는 다르다. 시작 결과 불명은 원journal을 조정하고 재실행하지 않는다.

소스 메타데이터 직렬화는 gateway pin 구성에 사용하며 서버 시험 실행이나 실제 추론을 대신하지 않는다. 실제 노출된 schema가 우선한다. 기존 App 관리 페이지가 다른 origin/tenant로 이동해 기존 도구 범위를 벗어나면 연결·계정·공유를 바꿔 우회하지 않고 원격 갱신을 남긴다.
## 기존 앱의 마지막 갱신 단계

서버 설치만으로 ChatGPT의 승인된 도구 목록이 갱신됐다고 판단하지 않는다. 기존 App ID를 유지한 Workspace 설정의 Refresh/Action control에서 aicc_codex_cli_start·aicc_codex_cli_status를 검토·활성화하고 기존 앱 업데이트를 게시한다. 새 앱 생성·연결 제거·공유 변경으로 대신하지 않는다. 도구 갱신 전에는 APP_PUBLICATION_PENDING으로 남긴다. 이번 기존 앱은 Refresh 후 57개 enabled=true 및 actions_changed_since_review=false를 확인했고, 지원 계약 비교상 추가 publish가 필요하지 않았다.

공식 근거: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt — 게시된 MCP 연결의 도구 snapshot은 고정되며 변경에는 관리자의 refresh/review/publish가 필요하다. 관리 권한·유효 연결과 실제 지원되는 admin surface를 사용한다.
## 검증 근거와 적용 범위

현재 owner binding은 codex-chatgpt-web-private 한 곳만 활성화한다. 다른 저장소의 새 host 권한은 자동 확대하지 않는다.
로컬 CLI Native/OCX 실제 응답, route 12pass/1skip, Workspace 21pass, dispatcher fake-runner 4pass, runtime/server/publication 48pass/2skip을 회수했다.
전체 Windows gate는 공통 guidance/기존 skill 설명 등 범위 밖 4건이 남아 전체 PASS로 표시하지 않는다. 이번 capability 기대값 차이는 수정 후 관련 21개 시험을 통과했다.

영수증 root: C:\demo\owner\.ai-control-center\backups\codex-cli-dispatch-20261020-035059\review\verification.
app-publication-receipt.json은 실제 원격 도구 계약, gpt-e2e2-result.json은 첫 성공한 일반 Chat, binding-fix-activation은 최종 바인딩 적용/원본/독립 READY 기록이다.
과거 search UNKNOWN 1건은 job-fix-activation/unknown-generation-preserved 및 unknown-at-stop.json에 미확정 그대로 보존했다. 이를 완료/정상 drain으로 바꾸지 않았고 재전송하지 않았다.

최종 영수증: verification/FINAL-VERIFICATION.json, gpt-e2e3-result.json. 실제 대화: https://chat.example.invalid/c/demo. configured_provider와 observed_provider(null)를 구분하며 JSON 로그에 없는 제공자 관측을 만들어 보고하지 않는다.

트레이 내부 탭 후속: 2026-10-20 10:28 KST traybf3668efde6f5cb2 빌드·설치, exact PID32780 실행 관측. 상태 창 CLI 탭 안의 OCX/Native 드롭다운·Git 폴더·모델·medium/high를 적용했다. 우클릭과 도구 버튼도 같은 탭으로 이동하며 탭 이동 시 입력 보존, 선택만으로 실행0이다. 내부 탭 전환/바로가기 및 두 경로×dark/light 입력 상태5case PASS, 최종 exe 전체 탭 렌더 exit0·큰 배율 항목명 폭 조정 확인. 스킬 홈 배포·사용자 설명 갱신 완료. 다른 component 변경0·모델 서비스 재시작0. 이번 내부 탭에서 실제 모델 요청 재검증 미실행. 영수증 verification/tray-cli-internal-tab/FINAL.json.

Desktop에서는 모델 선택 목록의 OCX · 계정 N (이름) · Sol 6.1/Astra 6 · High를 고른다. selector는 내부 고정ID이고 번호는 등록계정 alias, priority는 별개다. 목록 적용은 실모델권한·UI표시 확인과 다르다. 2026-10-25 catalog34 적용·검증미실행, exact요청의 installed pin상한 충돌 잔여는 중앙 현재문서에 연결한다.

## command-route-r2 적용 준비와 정확 owner 의존

상태는 **소스 작성, 검증 미실행·미설치**다. 아래 명령은 root가 후속 소유 구간에서 쓸 입력이며 이번에는 실행하지 않았다. 원 task G1-OCX-FOUNDATION-CONTINUE-01의 같은 scope이고 새 서비스·큐·원장을 만들지 않는다.

### 명령·설정·인증 계약

- 일반 `codex`는 공식 CLI와 공유 HOME을 사용한다. 목표 base route는 custom provider `aicc-ocx`/10100이다. model·reasoning·approval/reviewer·sandbox·personality·skills/plugins를 상속하며 baseURL만 바꾸지 않는다.
- 공식0.165 V2의 `$CODEX_HOME/native.config.toml`과 `aicc-webgpt.config.toml`은 base 위에 layer한다. `codex -p native`는 독립 정비용, `codex -p aicc-webgpt`는 Web17841 통합용이다. `[profiles.*]`나 별도 깨끗한 HOME을 만들지 않는다. legacy `codex-native.config.toml`·rescue·저장 대화는 보존한다. Native credits 대기 중 임의 실행하지 않는다.
- `aicc codex ocx`는 endpoint·명시 account·readiness/admission·paused/account CAS를 보존하는 compat다. model/effort를 주지 않으면 `-m`/reasoning override가 없다. 일반 launch에는 legacy catalog override도 없다. 계정 선택에만 현재 configured OCX metadata의 scoped 임시 catalog가 필요하다.
- 표준 `-m`/`--model`과 기존 `--route-model`은 같은 명시 선택이며 중복은 거절한다. 승인·sandbox 등 좁은 사용자 -c만 허용하고 provider/endpoint/auth/catalog/profile 재정의는 차단한다. -- 뒤 지시문은 launcher 옵션이 아니다.
- 명시 `--route-model gpt-6.1-sol --route-effort high`는 기존 지원이다. 수정 대상은 암묵5.6/낡은 catalog 강제이며 '항상5.6강제'는 아니다. user-layer model 값은 advisory이고 실제 project/session/daemon effective model을 증명하지 않는다.
- plain의 `aicc-ocx.auth.command`는 등록 immutable `Read-AiccOcxAdmission.ps1`과 exact PowerShell을 호출한다. helper는 원 registry의 A1 credential writer·정확 home/token 경계를 확인해 기존 data token을 읽기만 한다. stdout은 공식 Codex의 secret pipe이므로 사람 터미널이나 일반 exec 출력으로 호출하지 않는다. token을 config·로그·command args에 쓰거나 발급·로그인·ACL 변경을 하지 않는다.
- 공식 schema는 auth.command와 env_key/requires_openai_auth/experimental_bearer_token을 같은 provider에 함께 쓰지 못하게 한다. compat는 별도 process-only provider `aicc-ocx-compat`와 기존 child-env handoff를 쓴다. credential 부재/실패를 Native나 다른 계정으로 우회하지 않는다.

공식 근거는 실제 읽은 [OpenAI configuration reference](https://developers.openai.com/codex/config-reference)의 V2 profile과 `model_providers.<id>.auth.*`다. 설치 CLI의 새 schema 생성·실행이나 daemon endpoint 확인은 하지 않았다.

### 1. private catalog owner의 같은 G1 의존

`manage-model-picker`가 가리키는 기존 private root의 `scripts/apply-ocx-config-account-catalog.mjs`가 단일 catalog writer다. 이 source loan은 그 Git root를 수정하지 않는다. 그 owner가 다음 계약을 구현·인수해야 한다.

1. 정상 인증된 실제 OCX `/v1/models`의 ID 집합과 기존 검증 metadata의 slug를 join한다. account 번호·namespace·paused admission을 보존한다. raw reasoning=null을 high 지원으로 채우지 않고 실제 metadata와 원 session high 관측을 구분한다.
2. 일반 CLI/Desktop base는 같은 OCX-only 파일을 가리킨다. chatgpt-web/*는 별도 Web-only 파일, Native는 기존 독립 공식 catalog다. 원 slug·지원 버전·숨겨 보존한 이전 행·저장 대화를 강제 이전하지 않는다.
3. 기존 lock/CAS/backup·owner journal에 public 후보 파일3개, helper pin과 원/후보 catalog의 exact target/hash를 결속한다. 아래 준비 manifest를 받아들이는 지원은 private owner의 후속 구현 의존이다. 없는 새 flag를 추정하거나 예전 integrated catalog apply를 그대로 재실행하지 않는다.

계약 인수 뒤의 기존 명령 형태는 다음과 같다. 새 옵션을 발명하지 않으며 이번에는 실행하지 않았다.

```powershell
# 기존 private owner의 등록 Git root에서 같은 G1 owner 구간에만 실행
bun scripts/apply-ocx-config-account-catalog.mjs --apply --operation $catalogOperation
# 검증 metadata 입력의 기존 지원 옵션: --native-catalog $verifiedMetadataFile
```

### 2. public CLI closure와 config 후보

기존 installed CLI builder의 구체 입력은 `specs/independent-codex-cli-routes/command-route-r2.overlay.json`이다. private manager·트레이 전체·기존 PK02 후보·불명 요청을 이 overlay에 섞지 않는다. 현재 금지된 release 생성·검증으로 아래 명령을 실행하지 않는다.

```powershell
node scripts/build-task-owned-installed-cli-candidate.mjs `
  --source-root $publicSourceRoot --base-root $verifiedInstalledCliRoot `
  --candidate-root $newImmutableCliCandidate `
  --spec (Join-Path $publicSourceRoot 'specs/independent-codex-cli-routes/command-route-r2.overlay.json')
```

root는 정상 설치 owner에게 closure를 인수한 뒤 immutable helper의 실제 경로/SHA, 원 shared HOME config SHA와 owner catalog3개를 결속한다. 아래 새 준비기는 live HOME을 쓰는 Apply 모드가 없다. 기존 owner operation에 config/profile `.candidate`3개와 `shared-home-config.preparation.json`을 create-once한다. secret 설정·중복 managed key·unowned provider·기존 default profile이 있으면 원본을 그대로 두고 정확 owner 조정을 요청한다.

```powershell
& (Join-Path $publicSourceRoot 'tools/platform/codex/Prepare-CodexSharedHome.ps1') `
  -CodexHome $sharedCodexHome -ExpectedConfigSha256 $beforeConfigSHA `
  -OcxCatalog $singleOwnerOcxCatalog -NativeCatalog $existingOfficialCatalog `
  -WebCatalog $separateWebCatalog -CredentialHelper $immutableCredentialHelper `
  -ExpectedCredentialHelperSha256 $helperSHA -PowerShellExe $registeredPwsh `
  -OperationDirectory $existingOwnerOperation -StateRoot $registeredAiccStateRoot
```

manifest는 PREPARED_NOT_APPLIED/activationReady=false다. 생성만으로 HOME 등록·인증·daemon 연결을 완료하지 않는다. 이번에는 이 준비기 자체도 실행하지 않았다.

#### 설치된 HOME 준비 consumer 인수 · 2026-11-03

위 미실행 표시는 과거 source 단위의 기록이다. 현재 등록된 immutable CLI의 `Prepare-CodexSharedHome.ps1`과 `Read-AiccOcxAdmission.ps1`은 release manifest 및 현재 source와 일치했다. 이미 설치된 파일을 사용했으므로 재설치·운영 registry 변경은 없었다.

`tools/platform/test/Test-AiccInstalledHomePreparation.ps1 -ReleaseRoot $registeredCliRelease -EvidenceDirectory $freshEvidenceDirectory`는 등록 release의 manifest pin을 확인한 뒤 **설치된 준비기**를 별도 PowerShell process로 실행한다. 전용 합성 HOME/config/catalog와 빈 state만 사용하며 실제 사용자 HOME·인증정보를 읽지 않는다. 인증 helper는 경로/SHA로만 결속하고 호출하지 않는다. 실행 증거와 fixture는 지우지 않고 보존한다.

실제 인수 7건이 통과했다: 정상 평문 후보3개와 원본/candidate pin·설정 상속·별도 Native/Web 경계, 동일 operation 재실행 거절과 기존 산출물 보존, config/helper preimage 불일치 거절, 미지원 catalog/profile 거절, HOME 내부 출력 거절. 모든 경우 원본을 보존했고 정상 영수증은 `PREPARED_NOT_APPLIED`, `activationReady=false`, `credentialInvocation=0`이었다. 첫 검사 harness의 파일 쓰기 함수/별칭 충돌은 fixture 생성 전 실패했으며 수정 후 fresh evidence에서 인수했다.

이 결과는 설치된 public HOME 준비 consumer의 실행 인수다. private owner의 v8 journal reader 설치/실행, 실제 공유 HOME 적용, 인증 pipe·daemon·Desktop·모델 사용은 별도 미완료다. v8 reader는 해당 owner의 등록 installer·원복 경로와 좁은 작성권 인수 후 진행한다. public 준비기를 v8 reader로 간주하거나 운영 경로 교체를 이 검사에 포함하지 않는다.

### 3. root의 적용·복귀와 caller 이전

- source loan의 정상 terminal/반환을 먼저 채택한다. root가 원 config/profile/catalog/CLI등록/launcher/helper의 hash·작은 backup·owner journal과 정확 변경 대상을 고정한다. 원 UNKNOWN·거절·active task는 보존한다.
- 기존 installed-cli-route updater의 exact operation/attempt·CAS/backup/rollback으로 CLI를 결속한다. HOME3파일은 private owner가 위 정상 지원을 추가한 뒤 같은 owner CAS로 적용한다. 등록 밖 Copy나 generic patch로 직접 덮지 않는다.
- 연결·daemon/Desktop에 영향을 주는 단계는 fresh independent RDC READY·device lease·active=0/unknown=0·quiet window·exact root RELEASE/정상 완료·private rollback·one signal/no replay가 필요하다. HOME baseURL이나 process args만으로 effective endpoint를 추정하지 않는다. 기존 daemon/새CLI/새Desktop의 설정 수용과 원 request correlation을 각각 기록한다.
  - G1-07 범위 정정(2026-10-31 source, 미설치): OCX 10100의 `unknown=0`은 **진행 중 작업**에만 적용한다. external OCX의 `unknownTurns`는 이미 정산된 대화별 durable fence 행이며 재시작 때 그대로 다시 읽혀 같은 대화만 계속 막는다. 그러므로 release 교체의 idle 조건은 health의 `activeTurns=0`, `inflightFenceTurns=0`(reserved/dispatching 행), 바쁜 WebSocket 0이며 새 source health는 이를 `maintenanceIdle`로 묶는다. 무관한 과거 UNKNOWN 행 때문에 전체 정비를 멈추지 않는다. 그 행을 지우거나 완료로 바꾸지도 않는다. Codex 로컬 프로세스 gate(`codex-work-gate.mjs`)의 lifecycle UNKNOWN과 RDC 17841 경로 계약은 이 정정의 범위가 아니다. 현재 설치판 `020bcf6c6c8773cc` health에는 새 필드가 없으므로, 설치 전에는 기존 `unknownTurns`를 정비 차단으로 쓰지 말고 activeTurns·바쁜 WebSocket을 확인한다.
- 트레이는 기존 `Install-AiccStatusTray.ps1 -Action Prepare -CliOnly` → owner 인수 → 같은 설치기의 `-Action Install -CliOnly`로 입력 상속 두 파일만 다룬다. 이번 실행·빌드·설치·화면 관찰은0이다. 이전 설치판이 새 기본값을 보여 준다고 안내하지 않는다.
- Workspace CLI provider의 기존 route/model/effort allowlist·prompt SHA·operation lock·sandbox는 유지한다. 후속 owner가 새 CLI closure에 정상 재결속하며 로컬 상속을 원격 자유 실행·모델 권한 확대로 바꾸지 않는다. 원 status/ACK/turn/결과부터 조정하고 재발신하지 않는다.
- guidance는 변경 원본만 기존 backup/deployer로 전달한다. 생성 AGENTS는 기존 배포기로만 만든다. root가 이미 반영한 routing 두 스킬/HOME 변경을 되돌리지 않고 이번 차이만 더한다. 이번 HOME·문서 배포는0이다.
- 지피티 global/project instructions·skills 본문/참조·plugin 설명도 같은 G1 의존이다. registered asset owner가 기존 exact binding·같은 asset ID·원 byte backup/GitHub+Notion VERIFIED·원 UNKNOWN을 조정한다. Web9222 offline 의도가 불명이므로 기동하지 않는다. source 작성을 GPT 반영·설치·실제 load로 표시하지 않는다.

rollback은 이번 exact bytes/등록만 전후 CAS로 복구한다. 다른 writer 변경·로그인·계정·ACL·기록·원 UNKNOWN·독립 rescue를 되돌리지 않는다. 기존 root task 전체완료·보관0이다. PK02 Native revision/stop epoch/consume CAS는 좁은 별도 HOLD이며 이 source slice를 막지 않는다.

## G1 plain checkpoint · 설치와 실제 인수 범위

같은 대화의 계정을 바꾸는 기능이 아니다. 정상 종료한 원 CLI의 작업 요약으로 새 대화를 한 번 시작하는 소비자이며 기존 issuer/history를 복사하지 않는다. 등록 CLI에 checkpoint 명령과 생산자/소비자 모듈이 포함된 것을 2026-11-03 확인했다. `aicc codex ocx --handoff-checkpoint ABSOLUTE_CHECKPOINT_JSON`의 새 모델 실행은 미실행이다.

설치 인수: 등록된 runtime과 `bin/aicc`로 `codex checkpoint draft --input FILE --json`을 실행했다. 전용 합성 입력에서 launcher 바인딩 부재 거절, 정상 평문 저장과 SHA readback, 동일 operation 재저장 거절, 암호화 carrier 표식 거절을 확인했다. 합성 attempt와 writer 원본은 보존했다. 재설치·공유 HOME/운영 등록 변경·모델 발신은 없었다. 이는 설치 명령의 로컬 저장 경계 인수이며 실제 원 CLI 종료·새 exact ACK·작성권 이전·결과 채택 완료를 뜻하지 않는다. 상세 설치 신원과 영수증은 owner-local G1 checkpoint 설치 결과에 둔다.

입력은 schemaVersion=1, kind=ocx-plain-checkpoint, operationId/sourceThreadId UUID, mode=automatic|preferred|strict, expiresAt(숫자 epoch ms, 최대5분), cwd(원 절대폴더), model(미지정 계정 native slug), goal(평문), completed/remaining/constraints/references(평문 문자열 배열), stopReceipt={path,sha256}, writerRecord={path,sha256}다. writerRecord는 schemaVersion=1, owner=sourceThreadId와 ownedRoots 절대경로 배열을 가진 기존 작성권 정본이다. 다른 owner나 변경된 SHA는 HOLD다. preferred만 preferredAccount(기존 계정 번호)를 제공한다. strict는 소비자에서 정지한다. remaining은 새로 이어갈 미완료만 쓰며 원 작업의 재발신을 넣지 않는다.

원 stop receipt는 schemaVersion=1, kind=codex-checkpoint-stop, 같은 operationId, threadId=sourceThreadId, normalExit=true, writerReleased=true, activeCount=0, unknownCount=0, pid(원 PID), observedAt(숫자 epoch ms,60초 이내), effects=[{operationId,state:completed|not_dispatched}]다. 이 증거는 실제 원 실행/controller가 생산해야 하며 빈값을0으로 만들거나 문서만으로 정상종료를 합성하지 않는다. 확인된 원UNKNOWN 하나라도 있으면 handoff를 차단한다. 원 effects와 journal은 삭제하지 않는다.

소비자는 기존 OCX launch prerequisite/admission/model 조회를 통과한 뒤 같은 operation 디렉터리의 operationId.launch-attempt.json을 wx+fsync로 먼저 기록하고 1회 spawn한다. crash/불명/기존 attempt면 재시도하지 않는다. 자식에게는 원 attempt의 절대경로만 AICC_CODEX_CHECKPOINT_ATTEMPT로 결속하며 계정별 history는 전달하지 않는다. CLI 종료 후 operationId.launch-result.json의 CLI_EXITED_NOT_ADOPTED는 결과채택 대기이며 성공 판정이 아니다. 자동 checkpoint 생산/실제 정상종료 관측은 기존 controller의 후속 연결이며 이 소비자가 합성하지 않는다.

### stop 영수증·checkpoint 생산자 · 2026-10-31 G1-06 source

원 CLI를 띄운 실행기가 `codex-checkpoint-stop`을 생산한다. 실제 종료 코드와 PID를 본 것은 그 실행기뿐이기 때문이다. 생산자 모듈은 등록 설치본에 포함되어 있다. 이번 인수는 설치된 draft 명령에 한정하며 실제 원 CLI 종료의 stop 생산은 미실행이다.

```powershell
aicc codex ocx --checkpoint-dir ABSOLUTE_DIR [기존 Codex 인자]
# 그 CLI 안의 AI가 끝내기 전에 한 번:
aicc codex checkpoint draft --input PLAIN_SUMMARY_JSON --json
```

1. 실행 전에 `DIR/<operationId>.source-launch.json`을 create-once로 남기고, 자식에게 `AICC_CODEX_CHECKPOINT_DRAFT`·`AICC_CODEX_CHECKPOINT_OPERATION`을 넘긴다.
2. draft 입력은 schemaVersion=1, kind=ocx-checkpoint-draft, mode, preferred일 때 preferredAccount, writerRecord(절대경로), goal, completed, remaining(비어 있으면 거절), constraints, references, 선택 model과 continueAfterExit다. 계정 귀속 carrier 문자열은 거절한다.
3. 종료 뒤 실행기는 이 실행이 만든(또는 `resume UUID`로 이어간) rollout 하나를 찾는다. 후보가 0개나 2개 이상이면 UNKNOWN이다. 그 대화의 OCX fence 행만 읽는다. exit0·PID·대화 행 0이면 `<operationId>.stop.json`(unknownScope=this-conversation, globalUnknownCount는 참고값)을 쓴다. 아니면 `<operationId>.stop-hold.json`에 이유를 남긴다. 영수증을 합성하지 않는다.
4. draft가 있고 strict가 아니며 writer record owner가 그 대화이면 `<operationId>.checkpoint.json`(5분 유효)을 만든다. continueAfterExit=true이면 같은 실행기가 기존 `--handoff-checkpoint` 소비자를 한 번 부른다. 그 소비자의 attempt 파일이 재발신을 막는다.
5. fence 키는 `session_id`/`thread-id` 헤더의 thread UUID에서 만든다고 가정한다(`external-pool-state.ts` threadKey). 헤더 없이 previous_response_id로만 키가 만들어진 요청은 이 대화 행으로 잡히지 않는다. 이 가정은 실요청으로 확인하지 않았다.
6. ACK의 provider 검사는 현재 HOME의 `opencodex`, r2 shared-HOME의 `aicc-ocx`, compat 실행기의 `aicc-ocx-compat`를 모두 받는다. handoff 자식이 compat 실행기로 시작하므로 이전 `opencodex` 단일 검사는 ACK를 항상 거절했을 가능성이 있다(실관측 없음). phone 재개 검사도 같은 세 값을 받는다.
7. G1-05: compat provider와 r2 `aicc-ocx` provider에 `request_max_retries = 0`, `stream_max_retries = 0`을 둔다(공식 `model_providers.<id>.*` 키). 실패 원장에서 한 requestId가 약 1초 간격으로 126번 거절된 것이 관측됐다. OCX는 같은 요청을 다시 보내지 않으므로 클라이언트 재시도는 fence에 다시 막힐 뿐이다. 대신 일시적 연결 끊김에도 자동 재시도가 없어 사용자가 직접 다시 보낸다. 기본값(4/5)만으로 126회가 설명되지 않아 다른 재시도 계층이 있을 수 있다.

### 새 exact ACK·작성권·결과 채택 · 2026-10-31 source

아래 명령 분기와 모듈은 등록 설치본에 포함되어 있다. 2026-11-03 설치된 CLI로 전용 합성 원장의 ACK→writer CAS→adopt 경계 10건을 인수했다. 실제 대화의 ACK·작성권 이전·adopt 실사용은 NOT_RUN이며 합성 실행과 구분한다.

```powershell
aicc codex checkpoint acknowledge --session-log ABSOLUTE_CURRENT_ROLLOUT --json
aicc codex checkpoint adopt --checkpoint ORIGINAL_CHECKPOINT --result EXACT_WORK_RESULT --sha256 RESULT_SHA256 --json
```

acknowledge는 현재 CODEX_THREAD_ID, 공유 HOME sessions 아래 동일 UUID 파일의 bounded session_meta/첫 turn_context, 원 attempt 이후 시작 시각·cwd·opencodex·선택 모델·on-request를 대조한다. prompt/tool 본문을 복제하거나 다른 대화를 탐색하지 않는다. endpoint/issuer를 신뢰할 원영수증이 없으면 UNKNOWN으로 남긴다. 먼저 create-once thread-ack를 저장하고, 원 writer SHA와 owner를 확인한 lock/CAS에서 기존 ownedRoots를 그대로 새 exact로 넘긴다. writer-transfer 영수증 전에는 source를 쓰지 않는다. 기존 current/task/execution 문서는 새 owner가 ACK 뒤 같은 정본에서 갱신한다.

결과 입력은 schemaVersion=1, kind=ocx-checkpoint-work-result, 원 operationId, ownerThreadId=새exact, state=SOURCE_COMPLETED|PARTIAL|HOLD, verification=NOT_RUN|USER_REQUESTED, completed/remaining/references 평문 배열이다. SOURCE_COMPLETED의 remaining은 비어야 하며 설치·실사용 완료를 뜻하지 않는다. adopt는 원 launch/ACK/작성권 영수증, exit0, 결과 SHA와 현재 작성권을 함께 확인한다. PARTIAL/HOLD는 PARTIAL_RESULT_ADOPTED로 채택하여 미완료를 보존한다. 원 launch-result는 덮어쓰지 않고 별도 result-adoption을 생성한다.

중단·CAS 충돌·부분쓰기·기존 ACK/intent는 새 attempt로 재생하지 않는다. 원 preimage/intent/lock을 보존해 정확한 작업에서 조정한다. 이전 설치된 draft 경계 4건과 합성 stop 근접 검사 4건은 이번에 반복하지 않았다. ACK/adopt 실사용·새 모델 요청은 미실행이다. 이 연결은 완료된 OCX 자동전환 설치를 교체하거나 계정간 전환 E2E를 증명하지 않는다.

설치 인수 하네스는 `tools/platform/test/verify-installed-checkpoint-ack-adopt.mjs`다. 기존 등록 runtime과 `bin/aicc`를 별도 process로 실행하며 source 함수를 직접 호출하지 않는다. 자식 process에만 합성 HOME·thread ID·attempt를 결속하고 stop/attempt/exit/rollout/owner는 전용 fixture에만 만든다. 정상 ACK·작성권 CAS·adopt, 잘못된 exact, stale writer/result SHA, 중복 ACK/adopt, 변경된 owner 거절, PARTIAL/HOLD 미완료 보존을 합쳐 10 PASS였다. 합성 transport 원본과 설치본·등록 해시는 실행 시 보존됐다. 이 fixture는 실제 종료·발신·대화 완료·계정 전환의 증거가 아니다.

중복 adopt는 `EEXIST`로 거절하고 writer와 기존 adoption 영수증을 보존했다. 이 단계의 합성 lock/intent는 정확 조정을 위해 남았으며 삭제·재시도하지 않았다. 설치 consumer가 이미 있었으므로 재설치·운영 CLI 교체는 0이다. 13:03 실행 결과가 저장된 뒤의 모델 경로 503은 이 10건의 검사 실패를 뜻하지 않는다. 후속 closeout에서는 저장된 결과를 재사용했고 재검사·새 fixture 생성은 하지 않았다. 상세 실행 로그·설치 pin·원본은 owner-local `G1.checkpoint-ack-adopt-installed-20261103.result.json`과 연결된 증거 폴더가 소유한다.

private 기존 catalog 생성기의 source 옵션 `--prepare-shared-home --operation NEW_ABSOLUTE_DIRECTORY --input PINNED_CONTRACT_INPUT`은 원 catalog-contract-r3 모듈을 소비해 OCX/Web/Native 후보와 prepared.json을 만든다. 입력·owner journal/원catalog hash와 대상 precondition을 보존하며 HOME나 journal을 적용하지 않는다. 실제 후보 생성0·검증 미실행. public HOME후보와 기존 private owner transaction을 묶는 적용 consumer는 같은 private 스크립트의 `--apply-shared-home --operation NEW_ABSOLUTE_DIRECTORY --input OWNER_INPUT`과 `--recover-shared-home --operation EXISTING_DIRECTORY --input FRESH_OWNER_RELEASE --intent-sha256 SHA`로 source 작성돼 있다(`src/codex-shared-home-transaction.ts`, 2026-10-31 G1 판별). 실행·검증은0이다. 설치 순서의 첫 단계인 r2 CLI candidate 생성이 build이므로 이번 무검증 정책에서는 시작하지 않았다. 임의 파일복사로 대체하지 않는다.

## G1 current delta v2 and v8 reader ordering · 2026-10-30

적용 상태 추가: 동결 OCX 후보 `585acc6dfb9e7e82`는 독립 RDC 작업 `g1-ocx-auto-20261030-2222`에서 실제 `ACTIVATED`(exit 0)로 완료됐다. 아래 source slice의 과거 미실행 기록과 구분한다. 원요청 재발신은 없으며 실추론·자동전환 동작의 사후 검증은 미실행이다. HOME v8, shared-HOME transaction, r2 CLI 관리기와 Desktop 설치는 이 OCX 적용에 포함되지 않는다.

Reuse the existing rotation/lifecycle/scrub and97% implementation. The legacy user-approved builder v1 remains restricted to its original thirteen inputs and runtime-only substitution. The same builder now accepts decision schema `aicc-exact-ocx-user-install-decision/v2`, scopeRevision `g1-rotation-lifecycle-r2-r3`, and a new exact operationId. Its input pack is `aicc-ocx-frozen-input-pack/v2`, state `FROZEN_SOURCE_INPUT_NOT_BUILT_NOT_INSTALLED`, with the same controller and scope, a pinned draft manifest and complete approved adapter inventory. It retains every baseline adapter and explicitly requires the lifecycle fence plus inflight monitor. All v2 bytes come from that frozen pack, including external-runtime.ts; no live-checkout runtime substitution is allowed. Historical baseline acceptance is identity evidence only, never proof that this delta passed tests.

The runtime recognizes that exact v2 decision/inventory through the existing USER_AUTHORIZED_UNVERIFIED admission, preserving NOT_RUN/compatibilityPassed=false. This does not create a READY, normal stop, idle or rollback receipt. The existing candidate composition entry remains:

```powershell
& (Join-Path $publicSourceRoot 'tools/platform/opencodex/New-AiccExternalOcxRelease.ps1') `
  -SnapshotPath $freshExactSoftwareSnapshot `
  -UserInstallDecisionPath $frozenCurrentV2Decision
```

This command is source-supported and was not executed for this slice. Do not substitute the old thirteen-input pack or copy old acceptance/READY/release values. The independent installer must consume fresh existing software snapshot and normal transition/recovery contracts; source packing does not authorize switching an active controller's model route.

Before applying HOME, install the private owner's v8-capable integration reader through its registered installer and preserve rollback. The reader recognizes the split HOME route and Native/Web profile boundaries; legacy Setup/connect/disconnect/uninstall writers refuse v8 instead of replacing its provider or partially restoring only config.toml. The shared-HOME transaction still owns explicit seven-file rollback. Public r2 preparation now emits state and status; its three exact file records bind each original, candidate and target together. Existing receipts are not rewritten. No unsupported private installation command is inferred from source-only reader support.

Application order remains owner-specific: complete source/installed-reader and CLI-helper binding; freeze current input identities; obtain fresh independent rescue/device lease and normal controller completion; prove target active0/unknown0 and exact rollback; then use one existing official signal for the exact route. Missing or UNKNOWN evidence is HOLD. During Sol/Astra implementation, tests/builds, code rereview and runtime/browser verification are not automatically executed or delegated. Source, frozen inputs, candidate composition, installation and runtime acceptance remain separate states.

### Verified supplier 2.96 compatibility lane

The existing release entry point also supports the explicit 2.96 lane:

```powershell
& (Join-Path $publicSourceRoot 'tools/platform/opencodex/New-AiccExternalOcxRelease.ps1') `
  -SupplierVersion '2.96.0' `
  -SnapshotPath $freshExactSoftwareSnapshot `
  -CompatibilityAcceptancePath $isolatedIntakeReceipt
```

This lane requires the prepared official archive inventory, actual supplier export and behavior fixtures, all fourteen contract receipts, and exact adapter/verification source hashes. It rejects the legacy unverified-install and search-only acceptance paths. The immutable release seals supplier dependencies as well as the adapter. Supplier files are unchanged; admission, issuer continuity, file/ciphertext handling and the 97% quota policy remain at the AICC boundary. The legacy builder remains available for its explicit 2.81 contract.

Building does not activate a release. The existing transition and model-free one-shot local recovery worker bind a fresh software snapshot, candidate manifest, nonce, live worker PID and creation time. Activation checks the affected service's actual response lifetime, drain acknowledgement and process ownership. Historical UNKNOWN request evidence survives restart: it is not a global zero prerequisite for this OCX maintenance lane. The same uncertain request remains fenced, while a new instruction remains independently admissible. These scoped rules supersede the preceding historical `target active0/unknown0` wording for this lane; they do not relax current active, writer or authentication protections.

Rollback restores only the four software files after exact preimage/applied-hash comparison and checks the restored version and owner. It preserves credentials, request history and the shared Codex configuration. Record source acceptance, installed release, actual version/ready/owner readback and model canary separately; health/ready does not prove a model response.

Periodic updates use the existing upstream monitor's 24-hour review policy and UpdateCoordinator records. The Windows durable scheduler now supports the scoped review lane documented in [upstream updates](../upstream-updates.md#windows-정기-에이전트-검토): a bounded tick creates one durable review todo per due and queues it to the registered exact existing agent. Registration, next OS run, next review due, queue acceptance and actual execution remain distinct. Do not enable paused automations or add a direct-install daemon.

### G1 2026-11-14: reviewed extra OCX adapter source closure (source-only)

The installed 2.96.0 manifest has **14** original AICC adapter files.
Current external-pool-state.ts imports external-original-quota-receipt.ts;
legacy builders iterating only baseline.adapterFiles.Keys omit that source.

Explicit review input: immutable JSON file with schemaVersion=1,
kind=aicc-ocx-reviewed-adapter-additions/v1, runtimeRegistrySha256,
baselineManifestSha256, targetSupplierVersion="2.96.0", and
adapterFiles={"external-original-quota-receipt.ts":"<exact source SHA256>"}.
Its **file SHA256** must also be pinned independently; unrelated dirty AICC
files are never enumerated into a release.

Prepare-AiccOcxUpstream.ps1 -Action PlanCompatibility forwards
-ReviewedAdapterAdditionsPath, -ExpectedReviewedAdapterAdditionsSha256 and
-AllowSameSupplierAdapterRevision to New-AiccOcxCompatibilityPlan.ps1.
The same-version flag permits 2.96.0 to 2.96.0 adapter-only review only
when official archive entries match the original installed source pins and
all remaining installed entries are separately pinned node_modules files.
The plan returns reviewedAdapterClosureSha256 and an exact static relative
ESM import graph. Each reviewed addition must be reachable from the 14
baseline modules. Missing, unpinned, traversing, dynamic or linked inputs HOLD.

New current isolated-intake acceptance must pin inputPlanPath and its
inputPlanSha256, sourceSha256 for ALL 15 members,
reviewedAdapterClosureSha256, reviewedAdapterAdditionsPath and
reviewedAdapterAdditionsSha256, 14 current verified PASS contracts, and
verification-source pins. Historical PASS or 14-file acceptance cannot be
upgraded by copying old receipt fields.

The existing New-AiccExternalOcxRelease.ps1 -SupplierVersion 2.96.0 routes
to New-AiccAcceptedOcxRelease.ps1, which revalidates registry CAS, previous
installed manifest/acceptance and 14 preimage files, complete supplier pins,
reviewed additions receipt, relative graph and all 15 new source SHA values
before a new immutable candidate is copied. The candidate has 15 exact
adapter files and both the current acceptance and manifest record closure
SHA; it does not itself activate a service.

Offline regression: node --test test/ocx-compatibility-plan.test.mjs
test/ocx-release-closure.test.mjs. The fake builder uses a marked, isolated
temporary owner home and emits accepted=false with
FIXTURE_PASS_NOT_ACTIVATABLE. The central owner still owns independent
acceptance, backups, READY/drain, CAS, rollback and actual install. No
source-only test changed installed signed binaries, accounts, task/stop,
ce9a pending or model traffic.

#### G1 same-version installed dependency reuse, 2026-11-14

A previous read-only Prepare rejected because it treated the 2.96.0 official
archive (2,454 pinned files) and its dependency-installed supplierRoot
(6,511 pinned files, including 4,057 node_modules files) as one inventory.
The 2,454 common SHA values match; no archive-only entry exists.

The source-only planner now requires an exact archived SHA512 and receipt,
all original archive member SHA values, the current registry/manifest CAS,
the previous immutable acceptance SHA and the complete **installed**
supplierRoot inventory, rehashed read-only. Every manifest-only member must
be an exact previously SHA-pinned node_modules/* file; no other additions
are allowed. Symlink/junction/reparse, deletion, insertion, tampering or
foreign supplierRoot cause HOLD. Neither removing dependencies nor running
an installer/resolver is permitted.

The opt-in plan includes installedSupplierReuse/v1 evidence, separating
officialArchiveFiles, installedSupplierFiles and installedDependencyFiles,
with full SHA pins and installedSupplierReuseSha256. The existing accepted
release builder recomputes that evidence, SHA512-checks the original archive,
rechecks the previous acceptance, registry and all installed supplier bytes,
and references the **unchanged original** supplierRoot in its candidate
manifest. It never vendors a different node_modules tree. Newer supplier
upgrades keep their prior official archive comparison branch.

Read-only PlanCompatibility remains separate from a newly accepted release,
production staging and activation. The central owner still supplies fresh
isolated-intake acceptance (14 current checks), current backup/CAS/READY/
drain/rollback proof and explicit install authorization. No private adapter,
live model, ce9a pending, stop fence, Task or owner registry was changed.

## 계정별 사전 한도와 실제 소진

### 모델 메타데이터 클라이언트 버전

CLI 업데이트와 OCX 모델 조회의 `codexClientVersion`은 별도다. 같은 계정에서도
오래된 조회 버전은 새 모델을 숨길 수 있다. 설치된 공식 CLI의 실제 버전과 서명을
확인하고, 기존 `New-AiccOcxCatalogClientRelease.ps1 -CodexPath <absolute signed exe>`로
현재 승인된 standalone 배포본의 메타데이터 전용 후보를 준비한다. 기존 adapter와
supplier의 파일·승인 해시를 검산하며 dirty 개발판을 끼워 넣지 않는다. 후보 준비는
운영 적용이 아니다. 새 snapshot·독립 복구 READY·실제 idle·정식 transition과 운영
catalog readback이 필요하다. shared launcher 배포본은 그 제품의 별도 계약을 따른다.

PowerShell 7의 private directory 생성은 `FileSystemAclExtensions.Create`, 5.1은
Framework의 ACL overload를 사용한다. `ocx-secure-directory.test.ps1`을 두 런타임에서
검사한다. 생성/검증 실패는 service stop 전에 거절하며 기존 unsafe ACL을 변경하지 않는다.
외부 worker의 stdout은 JSON 전용이다. readiness 진단은 stderr로 보내며
`ocx-readiness-output.test.ps1`로 실패 진단과 결과 분리를 확인한다.

계정의 사전 차단을 꺼도 실제 사용량 100% 계정은 신규 요청 후보에서 제외한다.
선택기·HTTP 최종 검사·응답 감시는 같은 `quotaThresholdHits` 판정을 쓴다.
이미 전송한 응답은 기존대로 완료를 기다리며, 429 뒤 원 요청을 다른 계정에 재전송하지 않는다.
다음 신규 요청은 가능한 계정을 고르고 기존 계정 변경 scrubber·파일/UNKNOWN guard를 통과한다.

`aicc-account-quota-policy.json`의 선택적 `windowOverrides[accountId]`는
`fiveHour`와 `longWindow`에 각각 `usedThreshold`(정수 1~100), `enabled`(boolean)를 받는다.
한 창의 사전 차단만 끄면 그 창은 100%까지 사용할 수 있고 다른 창의 임계값은 유지한다.
기존 boolean `overrides`는 전체 사전 차단 스위치이며 실제 소진 제외는 항상 유지한다.
기존 정책 파일에 창별 설정이 없으면 종전 임계값을 사용한다.

변경은 등록된 `Invoke-AiccAccountQuotaPolicy.ps1`의 정확 selector/identity와
`-FiveHourUsedThreshold`, `-LongWindowProtection`으로 준비한다. 실제 설치판의
`accountQuotaWindowOverridesSupported`를 먼저 확인하고, preview→같은 인수로 Commit→
계정별 `quotaProtection` 실제 재조회로 마감한다. 기존 트레이 boolean 변경도 창별 값을 보존한다.

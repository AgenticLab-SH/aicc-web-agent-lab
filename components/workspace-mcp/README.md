## 프로젝트 Source 명시 읽기와 원 다운로드 진단 · source 단계

<!-- source-read-install-current:start -->
## 프로젝트 소스 읽기 설치 계약 · 2026-10-24

기존 `Update-AiccWebManagementRuntime.ps1`의 명시적 추가 action 목록에 `project-source-read` 하나를 연결했다. 이는 소스 후보의 설치 경로 연결이며 설치된 manager·owner binding·gateway/provider·원격 tool snapshot의 적용 완료를 뜻하지 않는다. 기존 계정·신원·workspace·blockedRequestHashes/blockedAssetKeys·파일 pin·이중 백업과 fresh READY/정상 정지/rollback 조건은 그대로 적용한다. 임의 action이나 runtime 소스 덮어쓰기를 허용하지 않는다.

고정 제공판의 실제 dependency closure, before/desired binding과 gateway/provider pin, 실제 읽기 전용 MCP 계약 산출물을 기존 후보 준비 절차로 만들어야 한다. `closureVerified`, toolHash, 백업 영수증과 READY를 추측으로 채우지 않는다. 소유자의 기존 비공개 작업폴더에 고정 dependency 입력을 재사용한 manager 129파일 payload·변경 전 설정 복구사본·desired binding 초안과 workspace provider overlay를 준비했다. 이는 새 release의 실제 권한·완전한 workspace/gateway pin·실제 MCP 계약/toolHash를 아직 충족하지 않은 staging이며 설치기 candidate receipt는 발급하지 않았다. 검증 미실행·설치/실제 호출 미실행이다. 기존 소스 다운로드 불명을 새 action으로 재생하거나 완료 처리하지 않는다. 운영 작성자는 등록된 독립 복구 준비와 기존 권한 조건이 실제 충족된 뒤 정상 updater를 사용한다.
<!-- source-read-install-current:end -->

기존 owner-bound web management provider에 `project-source-read` 계약을 연결했다. owner allowlist·identity/workspace·Project ID/name·전체 preimage·정확 filename을 유지하고, `source: { filename, includeBody: true, maxBytes, expectedSha256? }`로 256 KiB 이하 UTF8 Markdown 한 개만 명시적으로 읽는다. commit은 허용하지 않는다. 원문 recovery는 owner의 private result에 보관하고 일반 CLI 출력에는 원문을 싣지 않는다. 인증된 workspace의 원 요청 status 결과에는 명시 요청한 private recovery가 포함되므로 공개 로그에 복제하지 않는다.

이 읽기는 실제 다운로드를 동반하므로 request ID는 `read-`와 request SHA-256 앞 40자를 결속한다. 같은 요청의 재호출은 기존 결과/상태를 반환한다. 다운로드 발신 전/클릭/이벤트/바이트/임시파일 정리를 구분하는 sidecar metadata를 기존 operation status로 회수하며, 프로세스가 사라져도 새 다운로드로 바꾸지 않는다. 구형 결과에 진단이 없으면 원 outcome을 불명으로 보존한다. 원 불명 다운로드를 다른 ID·action·계정으로 다시 보내는 해제 근거가 아니다.

검증 미실행. 소스 계약만 작성했고 고정 manager/provider release·allowlist 배포·실제 원격 읽기/삭제/업로드는 미실행이다. 기존 backup·삭제 gate·권한과 복구 조건은 유지한다. 정확 원요청/담당/원 operation/다음 행동은 owner의 기존 execution 정본이 소유한다.
# AICC Workspace MCP

ChatGPT Business의 Secure MCP Tunnel이 직접 실행하는 AICC 소유 STDIO 서버입니다.
별도 로컬 HTTP 포트나 공개 reverse proxy를 열지 않습니다.

Codex 로컬 plugin은 같은 서버를 직접 STDIO로 실행할 수 있습니다. 원격 Tunnel config를
공유하지 말고 아래 전용 설치기를 사용합니다. 원격 config·identity·marker는 변경하지 않습니다.

```powershell
node bin/aicc workspace configure-local --surface personal-read-fetch --dry-run
node bin/aicc workspace configure-local --surface personal-read-fetch
node bin/aicc workspace doctor --local --surface personal-read-fetch
node bin/aicc workspace serve --local --surface personal-read-fetch
```

마지막 명령은 MCP client가 STDIO를 소유할 때만 시작합니다. plugin에서는 설치 결과의
`command.executable`과 `command.args`를 그대로 사용합니다. shell·추가 HTTP 포트·Tunnel key·
LaunchAgent·예약 작업·별도 네이티브 helper는 필요하지 않습니다. plugin manifest와 marketplace
설치는 plugin 소유자가 공식 helper로 수행하며 이 설치기는 plugin 파일을 변경하지 않습니다.

로컬 read 설정은 owner state의 `workspace-mcp-codex/config.json`, runtime·read session·cache는
그 디렉터리 아래에 둡니다. Windows에서는 PowerShell 7로 사용자와 SYSTEM만 허용하는 NTFS
ACL을 적용합니다. macOS는 기존 POSIX owner-only 모드를 사용합니다. 기존 root의 부적합한
보호 ACL은 자동으로 권한을 확대하지 않고 거부합니다.

기본 source는 기존 Personal registry입니다. 등록 alias만 복사하며 새 경로를 발견하거나
추가하지 않습니다. 로컬 write가 필요하면 정확한 Git root alias를 선택하고 별도로 생성합니다.

```powershell
node bin/aicc workspace configure-local --surface business-full --alias EXACT_REGISTERED_GIT_ALIAS --dry-run
node bin/aicc workspace configure-local --surface business-full --alias EXACT_REGISTERED_GIT_ALIAS
```

write 설정은 `workspace-mcp-codex-business-full`로 분리하며 `guarded`, 기본 read-only lease,
명령·네트워크 차단을 유지합니다. 부모 projects 디렉터리는 write 대상으로 허용하지 않습니다.
쓰기에는 이 로컬 identity에 결속된 승인·활성 durable job/attempt·single-writer lease·고유 request가
필요합니다. 읽기 canary 성공은 이 쓰기 승인을 만들지 않습니다. 기존 job authorizer를 우회하거나
`owner-unrestricted`로 변경하지 않습니다.

## 진단과 복구

- `doctor --local`은 config, authority, runtime dependencies, ripgrep, process identity와 시작
  guard만 읽습니다. `ok`는 prerequisites 통과이며 실제 tool call 성공이 아닙니다. `canStart`는
  독립 필드입니다. 기존 `workspace status`는 원격 Tunnel 진단으로 남습니다.
- 원격 Tunnel은 같은 config의 두 번째 서버를 거부합니다. 로컬 STDIO는 같은 config를 여러
  Codex 세션이 함께 사용할 수 있습니다. marker·read session·snapshot은 각
  `runtime/local-stdio/<instance-id>/`로 분리하고 서로의 lease는 사용할 수 없습니다.
  guarded writer job/attempt와 single-writer authorizer는 계속 공유하여 충돌을 차단합니다.
  EOF는 자신의 marker만 stopped로 전환합니다. `doctor`의 `startGuard`와 `repairGuard`는
  별개이며, 세션 추가가 가능해도 어느 한 프로세스라도 활성/UNKNOWN이면 repair는 거부합니다.
- 기존 로컬 config가 달라지면 `configure-local ... --dry-run`으로 검토한 뒤 같은 선택에
  `--repair`를 붙입니다. exact owner가 중지된 경우에만 기존 config를 백업하고 교체합니다.
  원격 root, plugin cache, 계정, 포트와 자동 시작은 대상이 아닙니다.
- 시작 도중 강제 종료되어 `startup.lock`만 남으면 자동 삭제하지 않습니다. 소유자가 lock의
  exact PID가 사라진 것을 확인하고 해당 lock 하나를 정리한 뒤 doctor부터 재시도합니다.
  malformed marker, 권한 오류나 PID 확인 불가는 idle로 간주하지 않습니다.
  로컬 시작은 config 변경과 짧은 reservation 구간만 같은 lock으로 직렬화합니다(최대 5초 대기).
  프로세스 식별 조회 중에도 pending marker가 있어 repair가 끼어들지 않습니다. 구버전의
  root 단일 marker가 활성 상태면 자동 이전하지 않고 기존 세션 종료를 기다립니다. instance
  기록은 자동 삭제하지 않으며, 4096개를 넘으면 owner의 exact stopped-instance 정리가 필요합니다.
- Node와 `rg`는 검증 가능한 실행 파일이어야 하고 Windows process identity에는 `pwsh.exe`가
  필요합니다. 서버와 supervisor의 시작 UTC ticks를 한 번의 .NET 조회로 읽으며 제한은
  최대 15초입니다. 부하로 제한을 넘거나 한 PID라도 조회하지 못하면 시작/ready를 거부합니다.
  PID만으로 만든 값·캐시·반복 재시도로 증명을 대체하지 않습니다. `doctor` 실패를 tunnel key
  복원이나 계정 변경으로 우회하지 않습니다.
- 실제 검증은 새 Codex 호출에서 list/open/read/close, 민감 경로·잘못된 lease·위조 write 거부를
  확인합니다. `node --test test/workspace-mcp-server.test.mjs`는 임시 등록 Git root에서 같은
  동시 두 로컬 client, 교차 lease 거부, 한쪽 종료 후 나머지 동작과 원격 singleton 거부를
  실행하며 live 계정이나 Tunnel을 사용하지 않습니다.

Business full 표면은 등록 워크스페이스 열기·목록, 범위 읽기, 검색, 패치, macOS
샌드박스 명령, 프로세스 입력, Git 변경 검토, AICC 정본 스킬 목록·읽기입니다.
Personal read/fetch 표면은 write·exec·process 도구를 게시하지 않습니다.
임의 절대 경로는 받을 수 없고, 쓰기와 명령 실행에는 만료되는 workspace lease가
필요합니다. `.env`, 개인 키, 패키지 인증 파일, Git 내부 메타데이터는 차단합니다.

브라우저 및 Computer Use는 이 서버에 섞지 않습니다. 두 기능은 Codex가 제공하는
별도 네이티브 도구와 AICC의 브라우저 lease 정책을 따릅니다.

검색은 LaunchAgent의 제한된 PATH에서도 동작하도록 `rg`의 absolute executable을 결정합니다.
명시적 `AICC_RG_EXECUTABLE`, PATH, owner runtime 후보 어디에도 실행 파일이 없으면 bare
command 재시도 없이 명확하게 실패합니다. 검색 descriptor는 ChatGPT tool card의 실행 중·완료
상태 문구도 함께 게시합니다.

read-only session 기록은 surface별 `read-sessions/<surface-profile>` store를 사용합니다. durable
job writer와 lock root를 공유하지 않으므로 write job이 실행 중이어도 read-only open, search,
read는 계속 사용할 수 있습니다. write lease, replay 원장과 single-writer 판정은 기존 durable
job store에 남습니다.

exact Git workspace의 read-only open은 기존 `workspace-snapshots` 엔진에 immutable fingerprint를
결속합니다. `workspace_read` byte 페이지와 `workspace_search`는 기존 bounded reader/고정 문자열
검색 및 민감 경로 검사를 그대로 사용합니다. 완전한 snapshot이면 같은 lease에서 최대 8개×256KiB의
응답만 메모리 재사용하고 snapshot ID·cache hit를 표시합니다. 큰 페이지도 직접 읽을 수 있으며
캐시에 넣지 않습니다. `workspace_read_many`는 기존 제한 페이지 직접 읽기를 유지합니다.
요청 전과 실제 load 뒤 fingerprint를 검사해 tracked 변경은 `snapshot_stale`로 fail closed합니다.
선택되지 않은/새 untracked 파일이 있으면 직접 bounded 경로를 사용하며
`complete_workspace_view=false`와 `cache_hit=false`를 표시하므로 파일을 조용히 누락하지 않습니다.
포트·프로세스·Tunnel·계정 한도·readiness를 캐시하지 않습니다. 2026-10-23 source 회귀20통과/제외2이며
설치본 반영·실제 등록 root/운영 검증과 별개입니다. 인수/명령/남은 gate는 기존 account-picker 명세와
owner operation CURRENT.md에 기록합니다.

현재 published Business/Personal 도구 수는 이 최적화 때문에 바꾸지 않습니다. 향후 high-level
`workspace_context` successor는 read lease와 같은 snapshot을 사용하고 query 5개, path 20개,
명시적 byte/result limit 안에서 path/hash/reason/excerpt만 반환해야 합니다. 결론·수정 명령·live
process 사실은 만들거나 캐시하지 않습니다. 선택되지 않은 untracked 파일을 조용히 누락하지
말고 live no-cache 또는 `incomplete_workspace_view`로 처리해야 합니다.

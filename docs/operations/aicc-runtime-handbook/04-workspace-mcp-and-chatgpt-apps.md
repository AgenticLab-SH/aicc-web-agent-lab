# Workspace MCP와 ChatGPT 앱

## 현재 앱 권한 관리 — 2026-10-08 KST

`demo-owner` Business workspace의 관리 대상은 AICC Workspace 앱 한 개다.
소유자 승인에 따라 관리 정책의 기본은 **모든 도구 허용**, **도구 모두 활성화됨**,
**새 도구 모두 활성화**다. 2026-10-07 변경 전 실제 관리자 화면에서 세 설정을 확인했다.
현재 앱을 다시 게시하거나 같은 앱을 중복 생성하지 않았다.

관리자는 등록된 owner 역할·workspace·정확한 앱 ID를 대조한다. AICC 관리 대상의 `sync`에서
권한 상태도 함께 처리하며 `verify`는 읽기 전용으로 불일치를 보고한다. 별도 `permissions` 명령은
기본 preview, `--commit`일 때 적용한다. 정책의 `toolPermissionPolicy: "preserve"`로 명시한 앱은
변경하지 않는다. member 역할·Personal 앱·제3자 앱은 이 기본 권한 동기화 대상이 아니다.
옛 화면의 “액션”과 현재 “도구” 문구를 모두 인식한다. 제어 대상이 중복되거나 상태를
판별할 수 없으면 중단하며, 불확실한 원격 변경을 자동 반복하지 않는다.

명령 예시는 설치된 `aicc-apps`에서 등록된 역할과 정확한 앱 ID를 전달한다.

```powershell
aicc-apps permissions --role <등록된-owner-role> --app-id <관리대상-app-id> --policy <정책-절대경로>
# preview의 대상과 변경 내용을 확인하고 같은 명령에 --commit을 붙여 적용한다.
```

홈의 immutable app-manager 릴리스 `eb0eae7c5d6025bb2f193c0f79286772eee3395c71b787333150453c1aa195f4`로
포인터와 component 등록을 함께 승격했다. 이전 `c45af298…` 포인터는 rollback 파일에 보존했다.
새 상주 서비스·주기적인 권한 변경을 만들지 않았다. 새 코드의 실행·원격 동기화·permission prompt 해소는
**검증 미실행**이다. 설치기의 manifest 확인은 전달 무결성 확인이며 기능 검증이 아니다.

앱의 기본 승인, Workspace의 guarded-write 승인, Codex 실행 정책과 OpenAI의 별도 확인 화면은
서로 다른 계층이다. 이 변경으로 모든 종류의 허용 화면이 사라졌다고 판단하지 않는다.
기존 workspace 등록·쓰기 정책을 전역으로 풀거나 별도 복구 경로의 권한을 바꾸지 않는다.

공개 카탈로그의 **Flaim Fantasy**, **WPVibe**, **Tarot** 세 앱은 용도가 맞지 않아 사용 가능 상태를
되돌릴 수 있게 비활성화했다. 영구 삭제하거나 연결된 데이터·계정을 지우지 않았다.
Slack, Google Drive, Gmail, RDC, GitHub, Notion과 용도가 불확실한 다른 앱은 보존했다.
카탈로그 비활성화는 로컬 플러그인 제거가 아니므로 메모리 절감 효과로 보고하지 않는다.

## 요청된 실제 클릭 검증과 수정 — 2026-10-08 KST

사용자의 명시적 검증 요청으로 기존 all-tools 상태를 유지한 채 실제 메뉴를 열고 같은 항목을 클릭했다.
관리 코드와 같은 공유 클릭 함수를 task-owned Chrome CDP에 연결해 실행했으며 새로고침 뒤에도 **모든 도구 허용**을 확인했다.
현재53개 도구의 읽기31/쓰기22 그룹 checkbox는 모두 checked였다. 임시로 운영 권한을 제한하거나 확장하지 않았다.

발견한 실패 원인은 공백 없는 DOM 라벨, 숫자만 표시하는 도구 버튼, 설명이 붙은 `menuitemcheckbox`,
그리고 화면 아래로 벗어난 좌표였다. 최신 라벨을 정규화하고 숫자 count와 실제 group 상태를 분리했다.
메뉴 안의 유일한 대상만 고르고, 원래 라벨·역할·활성 상태를 다시 대조한 뒤 스크롤·viewport·가림 여부를 확인해 클릭한다.
이전 “액션” 화면도 유지하고 대상 중복/미확인/비활성 상태에서는 클릭을 거절한다.

회귀 테스트6/6 PASS, 관리 릴리스 빌드 PASS. 새 설치본은
`4fe099118070d57a46f3489d6139cef06386bab0e24d8d5ec918a474e1673e44`이며 이전 포인터를 보존했다.
증거는 owner home `receipts/plugin-policy-20261007/permission-click-20261008.jpg`와 actual-permission-fixture.json이다.
이번 검증은 실제 공유 클릭 함수와 상태 판독을 증명한다. 권한 default→all 변경과 CLI 전체 sync/lease/ledger 경로를
운영에서 억지로 발생시킨 시험은 아니다. 다른 플랫폼의 모든 승인 화면 제거까지 완료로 주장하지 않는다.

## 두 개의 MCP 표면

| 표면 | 시작점 | 도구 범위 |
|---|---|---|
| Web GPT full harness | Codex의 `chatgpt-web/*` turn | 현재 Codex task가 광고한 동적 도구 |
| AICC Workspace | 외부 ChatGPT 대화 | 등록 workspace의 고정 파일·검색·명령·스킬 도구 |

두 표면은 같은 control plane에서 관측할 수 있지만 Tunnel, 인증과 lease를 공유하지 않는다.

## Codex 로컬 STDIO와 원격 Tunnel 분리

Codex 로컬 plugin은 원격 ChatGPT connector와 독립적으로 실행한다. 설치·repair·doctor 명령과
보호 범위는 [Workspace MCP README](../../../components/workspace-mcp/README.md)의 로컬 STDIO
절차를 따른다. 기존 Personal registry를 복사하되 별도 local identity·config·marker·read store를
사용한다. 원격 config는 singleton을 유지한다. 로컬 config는
`runtime/local-stdio/<instance-id>/`별 marker·read store·snapshot으로 동시 세션을 지원한다.
repair는 모든 instance의 pending/active/unknown owner를 검사하고 하나라도 있으면 거부한다.
원격 marker를 로컬 프로세스로 덮어써서 Tunnel ready를 가장하지 않는다.

Windows 로컬 기본 구성은 18개 read/fetch 도구이며 별도 Tunnel key, macOS Keychain helper,
launchd 또는 HTTP listener를 필요로 하지 않는다. Windows guarded-write 구성은 선택한 exact
Git root의 19개 도구이며 command/process 도구는 없다. `guarded` write job 승인은 별도로
필요하다. 로컬 plugin 설치와 실제 새 Codex 호출 검증은 plugin 소유자가 수행한다.

원격 developer-mode Tunnel은 여전히 별도 복구 대상이다. Windows 예약 작업 설치기는
surface별 `tunnel-client.exe`, profile과 DPAPI key를 요구한다. 파일이 없을 때 local STDIO
설정으로 대체하거나 임의 key를 생성하지 않는다. 오래된 macOS native helper/Keychain/launchd
자료는 Windows 실행 계약이 아니다. 암호화 백업 자격증명 복원과 계정 연결은 별도 소유자 범위다.

### Windows 보호 키와 예약 작업

저장 계약은 각 원격 state root의 `secrets/tunnel-runtime.key.dpapi`이다. 원래 key 파일의
bytes 전체를 DPAPI `CurrentUser`로 보호한 **binary**이며 JSON/base64 wrapper가 아니다.
entropy는 UTF-8 `aicc-workspace-tunnel:v1:<surface>`이다. surface는 `business-full` 또는
`personal-read-fetch`만 허용한다. 다른 사용자나 surface로 복호화하지 않으며 legacy `.key`,
pro, 별도 bridge 키는 자동 변환하거나 덮어쓰지 않는다. secrets 폴더는 상속 차단, 소유자와
SYSTEM만 허용한다. key 파일도 동일한 유효 ACL이어야 한다. 넓은 ACL이나 잘못된 cipher는
오류로 끝나며 plaintext fallback이 없다.

저장소 루트에서 실행한다. `status`는 복호화 성공 여부만, `doctor`는 파일/authority/guard만
읽는다. 키·profile 본문을 출력하지 않고 네트워크나 daemon을 시작하지 않는다.

```powershell
node tools/platform/workspace-mcp/windows-tunnel-secret.mjs status --surface personal-read-fetch
node tools/platform/workspace-mcp/install-windows-task.mjs doctor --surface personal-read-fetch
node tools/platform/workspace-mcp/install-windows-task.mjs install --surface personal-read-fetch --dry-run
node tools/platform/workspace-mcp/install-windows-task.mjs repair --surface personal-read-fetch --dry-run
```

예전 AICC 예약 작업이 현재 installer의 hidden PowerShell 형식이 아닌 legacy VBS 형식으로 남아 있는
경우에는 일반 `install`/`repair`가 이를 덮어쓰지 않는다. 다음 조건을 모두 fresh-read한 뒤에만
명시적으로 legacy 인수를 미리 볼 수 있다.

```powershell
node tools/platform/workspace-mcp/install-windows-task.mjs repair --surface business-full --adopt-legacy --dry-run
```

`--adopt-legacy`는 정확한 AICC description, 현재 사용자 SID, 동일 state root와 runtime alias, 기존
owner-only receipt/backup, 비활성 task, idle guard를 모두 확인할 때만 계획을 반환한다. 외부 task,
receipt가 없거나 불일치하는 task, 실행 중인 task에는 계속 거부한다. dry-run이 PASS한 뒤에도 실제
repair는 현재 Codex turn과 다른 writer/lease가 idle인 별도 변경 창에서 한 번만 실행하고, post-read로
task owner·Tunnel health·Workspace ready를 확인한다.

`import-stdin --surface <surface>` 또는 exported `importWindowsTunnelSecret(bytes, options)`는
복구 owner가 메모리의 원래 bytes를 전달할 때만 사용한다. 값을 CLI 인수나 shell 문자열에
넣지 않는다. 동일 bytes는 no-op, 다른 기존 키는 교체 거부다. import는 native DPAPI
roundtrip과 ACL을 검사한다. 보호된 키를 만드는 것과 새 credential 발급은 다르다.

live owner가 exact tunnel ID, 계정/조직 연결, native Windows MCP command와 remote config
경로를 먼저 확인한다. `doctor`의 `profileSemanticsVerified:false`는 upstream profile의
의미·원격 권한까지 검사한 결과가 아님을 뜻한다. 파일이 있는 것만으로 live ready를 선언하지
않는다. 없는 profile을 임의 ID로 재생성하거나 runtime 키를 관리자 키로 재해석하지 않는다.
client `admin tunnels list --help`가 요구하는 관리자 키와 명시적 scope가 없으면 remote 목록을
호출하지 않는다. `runtimes list --json`의 local 목록만으로 원격 association을 증명할 수 없다.

preview와 active guard 확인 뒤 승인된 owner만 `install` 또는 `repair`에서 `--dry-run`을 뺀다.
둘 다 현재 사용자 InteractiveToken/LeastPrivilege task를 한 번 등록하고 한 번 시작한다.
task는 Node + `windows-tunnel-secret.mjs run --surface ... --state-root ...`를 실행한다.
key는 child의 `CONTROL_PLANE_API_KEY` 환경에만 들어가며 task XML/argv/receipt에는 없다.
child stdout/stderr는 폐기하고 log destination은 stdout으로 강제해 파일 로그를 만들지 않는다.
raw HTTP logging·remote UI·자동 browser open은 강제 해제한다. health는 `192.0.2.1:0`
(OS가 배정하는 loopback 임시 포트), PID/health URL metadata는 해당 `tunnel/runtime`에만 쓴다.
새 listener를 실제 시작하기 전에 이 계획과 포트·guard를 runtime owner에게 전달한다.

활성 또는 신원 불명 MCP/PID, helper/startup lock, 실행 중인 task는 repair를 거부한다.
다른 surface나 local STDIO 서버는 중지하지 않는다. 강제 종료 뒤 남은 lock을 자동 삭제하지
않는다. live owner가 해당 PID/자식 종료와 lease 종료를 확인한 뒤 exact stale marker/lock만
정리한다. foreground helper는 SIGINT/SIGTERM에 자신의 child tree만 종료하지만 OS 강제
종료 뒤 cleanup 완료는 보장하지 않는다. `stop`/`rollback`도 활성 guard를 우회하지 않는다.
기존 task는 정확한 description/command/args/root로 확인하고, 실패 시 비활성 상태에서만
원래 XML을 복원한다. `status`의 installed와 실제 health/ready·ChatGPT 호출 성공은 별개다.

공식 확인 경로:
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Plugins](https://developers.openai.com/plugins)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

공식 Tunnel 절차의 `CONTROL_PLANE_API_KEY`, `init --sample sample_mcp_stdio_local`,
`--profile`, `--tunnel-id`, `--mcp-command`는 원격 transport 설정이다. key는 명령 인수·보고서·
저장소에 기록하지 않는다. 실행/선택에는 기존 Tunnels Read + Use와 정확한 Platform organization/
ChatGPT workspace 연결이 필요하며, 이 복구를 이유로 Manage 권한을 확대하지 않는다. private
developer-mode Tunnel 지원을 public plugin 배포 지원으로 해석하지 않는다. 원격 SSE/404는
로컬 STDIO canary 성공으로 해결되었다고 판정하지 않는다.

## 계정·워크스페이스별 권한

- Business: 관리자/소유자가 full MCP 앱을 만들고 게시할 수 있으며, write/modify actions는
  workspace 정책과 게시 검토를 통과해야 한다.
- 공식 [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)는
  Plus·Pro 개인 계정과 Business·Enterprise·Education에서 read/write MCP 도구를 지원한다.
  Personal 전체를 read/fetch 전용으로 판단하지 않는다. 실제 계정의 구독·개발자 모드·공간
  신원과 앱 정책을 따로 확인한다.
- 현재 AICC에 등록된 `personal-read-fetch` 프로필은 소유자가 제한한 별도 서버 정책이다.
  이는 ChatGPT 제품 전체의 쓰기 제한을 뜻하지 않으며, 보호된 다른 계정의 정책을 임의로
  확대하지 않는다. 두 업무 계정의 full 기능은 현재 공유 Business 앱에서 검증한다.
- 한 Business workspace에 게시한 앱은 그 workspace에서 허용된 멤버가 사용한다. 다른
  Personal 계정이나 별도 workspace로 자동 복제되지 않는다.

## 게시·갱신 체크리스트

1. exact account identity와 workspace를 확인한다.
2. draft의 endpoint, 인증, 도구 수와 input schema hash를 기록한다.
3. Scan Tools 뒤 모든 risk section을 펼친다.
4. 각 확인 checkbox와 action permission을 검토한다.
5. 예상 write/read 도구가 모두 보이는지 확인한다.
6. 게시를 한 번만 실행하고 Enabled/Approved 목록에서 stable asset identity를 다시 읽는다.

Business의 게시된 custom app은 live MCP 변경을 자동 반영하지 않을 수 있다. frozen tool
snapshot이므로 incompatible schema 변경이나 새 action은 refresh/recreate/review가 필요하다.
중복 앱은 이름만 보고 삭제하지 말고 endpoint, tool hash, 게시 상태, 실제 사용 참조를 비교한
뒤 recoverable quarantine 또는 승인된 삭제를 사용한다.

### CLI 관리와 관측 경계

private adapter의 관리 source를 고정 bundle로 배포한 `aicc-apps --help`가 운영 UI 관리 명령이다.
`bun run chatgpt:apps`는 개발 source를 실행한다. 운영 명령과 구별한다.
소유자 Windows에서는 `aicc-apps --help`와 `aicc-apps inventory --role default|secondary`로
어느 폴더에서나 같은 관리 코드를 실행한다. shim은 private `manage-chatgpt-apps.ps1`만
호출하고 Native Bun 실행 파일 하나를 선택한다. wrapper는 고정 release pointer의 manifest hash와
manager/worker/driver 파일 hash를 확인한다. 구 전역 `aicc` release를 바꾸지 않는다.
`status --role ROLE --policy ABSOLUTE_JSON`은 policy의 각 contractFile로 설치·도구 상태를 확인한다.
실행 runtime이나 전체 RDC acceptance를 대신하지 않는다.
`inventory`, `catalog`, `schema`, `admin-inspect`, `reconcile`은 읽기와 계획이다.

2026-10-03 manager release `56bbc07b0af043e2dbde3ad43124bd25ece7dd03a19c7534e4d7d3276e907b8c`를
기존 pointer에 적용했다. 이전 pointer는 hash가 고정된 rollback 파일로 유지한다.
이 release는 exact app의 최신 JSON·화면 제어를 읽고, 과거 관리 메뉴 문구를
필수 조건으로 사용하지 않는다. 계정·workspace 신원은 작업 전후에 확인한다.
메모리 1 GiB 미만에서는 새 lease/target 생성 전에 `browser_memory_pressure`로
멈추며 cleanup은 허용한다. 실패는 CDP timeout, renderer crash, lease/identity
문제로 나눠 비밀 없는 코드만 남긴다. 관련 53개 테스트와 typecheck가 통과했고,
적용된 CLI의 1번(demo-ownerd28)·2번(wntlrqpdj) fresh 50-tool contract도 통과했다.

Chrome port/profile 중복 여부와 renderer 응답 여부는 별개다. 2026-10-03 조사에서
메인 Chrome, 9222, 9223은 서로 다른 profile을 사용했고 포트 충돌은 없었다.
9223은 설치 버전 `.93`보다 이전 `.59`로 실행 중이며 renderer가 응답하지 않았다.
정상 Browser.close 뒤 직접 재실행 명령은 실행 도구에서 차단됐지만, 기존 등록
`Start-AiccCdpChromeSlot.ps1 -Port 9223 -Action Ensure`는 정상 실행됐다.
같은 프로필·로그인·workspace, 최신 `.93`과 확장 검증이 통과했다. 자동 승인 검토로
단정한 최초 설명은 정정한다. 로컬 설정은 reviewer=user이며 검사한 로컬 규칙·
AICC 삭제 방지 hook에는 Chrome 실행 금지가 없다. 원래 거부의 정확한 원인은 미확인이다.
Chrome 설치나 9223 포트 자체의 차단으로 단정하거나 권한을 넓히지 않는다.
다른 port/profile로 대체하거나 no-sandbox로 우회하지 않는다.

RDC 비교 시험은 새 Chat·합성 파일만 사용한다. 최신 device discovery는
실제 `list_devices` 1회 호출했지만 해당 Windows host가 없다는 JSON을 반환했다.
같은 host에서의 RDC/AICC 속도 비교는 아직 수행할 수 없고 속도 우위를 주장하지 않는다.
원래 HOLD 영수증은 보존하고 제출 사실을 독립 readback 영수증으로 보정한다.
`settings --role default|secondary [--plugins]`는 기존 등록 크롬의 현재 계정 설정을 읽는다.
새 관리 프로필을 요구하지 않으며 공간을 전환하지 않는다. 화면의 `개인 설정`은 Personal
workspace 신원이 아니다. 조회 앞뒤의 실제 계정·workspace hash를 확인한다.
프로필 버튼은 exact aria label과 menu 역할로 확인한다. 구 `accounts-profile-button` testid만
기다리지 않는다. 설정은 dialog 또는 exact `/settings/general-settings`와 유일한 설정 heading/main을
요구한다. 플러그인 이동은 기존 tab 또는 현재 settings nav의 exact aria label을 사용한다.
화면이 바뀌었다고 이름이 비슷한 다른 버튼을 누르거나 OS 좌표 입력을 사용하지 않는다.
`install`/`uninstall`은 해당 계정의 설치이고 `disable`/`publish`는 공유 앱 관리다.
`refresh`의 성공은 exact ID의 변경 요청과 독립된 갱신 확인이 필요하다.
POST `/ps/apps/batch`는 조회이므로 HTTP200만으로 갱신 성공을 기록하지 않는다.
현재 settings UI의 도구 갱신은 `/aip/connectors/mcp/refresh_actions`로 `link_id`만 보낸다.
앱 ID 문자열만 감시하면 실제 응답을 놓친다. 화면 이동 전에 응답 감시를 준비하고, UI가
조회한 exact connector의 `/link` 응답에서 ACTIVE 연결을 확인한 뒤 그 연결 ID 한 개에만
변경 응답을 결속한다. 연결 ID·인증값·tool output 원문은 기록하지 않는다. 화면 로딩은
고정 3초 대기로 판정하지 않고 활성 연결·버전·버튼이 모두 확인될 때까지 제한 안에서 기다린다.
`reconcile-refresh --receipt ... --expectation ... --state-root ...`는 기존 관측 유실 기록을
보존하면서 exact 앱·계정·공간·버전의 도구 정의만 한 번 다시 조회해 조정한다. 다른 변경이나
tool 실행에는 적용하지 않는다. 기본은 preview다. commit의 조정 기록은 한 번만 만들며,
정확한 갱신 응답과 독립된 최종 도구 계약이 없으면 UNCERTAIN을 유지한다.
목록의 pagination 종료가 확인되지 않으면 부재·삭제 가능 상태를 추정하지 않는다.
새 admin catalog의 `nextPageToken`도 확인하며 중복 페이지를 제외한 bounded traversal을 한다.
마지막 페이지 증거가 없으면 `complete=false`, CLI exit 3이다. 재시도는 읽기에만 허용한다.
`catalog`는 검증된 workspace UUID 경로에서 실제 관측한 `scope=WORKSPACE` 링크를 따른다.
기본 공개 marketplace 목록은 소유자의 등록 목록이 아니다. 반환 record의 WORKSPACE scope와
페이지 종료를 모두 확인한다. 필터 구조가 바뀌면 `catalog-filters`로 현재 컨트롤부터 확인한다.

브라우저 생성 요청은 lease token 없는 durable receipt를 먼저 기록한다. 생성 명령의 시간
기준을 넘겨도 process를 강제 종료하지 않는다. 종료가 확인된 뒤 그 요청의 exact owner,
account, workspace lease만 회수한다. 바깥 Node driver도 worker 종료까지 기다리며 확정된
늦은 응답에는 `driverDeadlineExceeded:true`를 표시한다. 불명확한 요청은 같은 공간의 다음
생성을 막는다. `aicc-apps recover-leases --role ROLE`로 확인하고 `--commit`으로 회수한다.
owner/helper PID가 살아 있거나 target/신원이 불명확하면 회수하지 않는다.

관리자 UI가 `admin.openai.com/workspace/<uuid>/plugins/<app-id>`로 이동하면
UUID SHA-256이 승인된 workspace binding과 같아야 한다. 최초 ChatGPT 계정 신원을
검사하고 작업이 만든 탭에서만 이동하며, 종료 전에 원래 신원을 다시 검사하고 탭을 닫는다.
등록 scope `USER`는 Personal workspace를 뜻하지 않는다. Personal은 별도 exact identity
inventory가 있어야 조사 완료다. 지금 Business의 Workspace 고정 도구와 Native 현재-task
동적 도구는 서로 다른 기능이며 이름 유사성은 삭제 근거가 아니다.
통합 gateway는 두 authority를 분리한 채 22+28 도구를 같은 앱에 제공할 수 있다.
로컬 50개 제공, 웹 도구 갱신, 두 계정의 활성·검토 상태, 새 Chat의 실제 호출은 각각 확인한다.
Native의 앱 선택은 `select-managed-chatgpt-app.ts`로 원격 이름·도구·계정 계약과 idle을
확인하고 이전 설정을 보관한 뒤 변경한다. Full Harness의 후속 업데이트는 선택한 앱 이름을
보존해야 한다. 이전 앱 정리는 현재 작업의 기능 동등성과 참조·복구 조건을 충족한 뒤 진행한다.
앱을 선택하는 검색어도 현재 `appName`의 이름으로 만든다. 통합 앱을 선택하면서 과거
`@codex` 검색어를 고정하면 전송 전에 선택이 실패한다. 검색 뒤에는 전체 이름과 선택된
pill을 정확하게 검증하며, 검색어만 일치하는 다른 앱은 허용하지 않는다.
17841의 프로세스 판정은 실제 listener 또는 해당 state root의 `cli.js serve`와 launcher
`serve` 명령만 대상으로 삼는다. 같은 설치 폴더의 `mcp-helper.cjs`나 browser helper는
별도 연결의 소유자이므로 router 재시작을 막거나 종료 대상으로 삼지 않는다. 선택 실패 뒤
router 부재가 증명되면 이전 설정을 복구할 수 있으며, UNKNOWN에는 복구를 진행하지 않는다.
복구도 실패한 경우에는 원래 선택 오류와 복구 오류를 함께 남긴다.
새 Chat 전송은 정확한 user message ID·전체 prompt·선택된 앱과 해당 conversation POST의
HTTP 성공 응답으로도 확인할 수 있다. 화면이 늦게 나타나는 경우를 전송 실패로 오인하지
않는다. 준비 요청·다른 사용자 메시지·다른 앱·실패 응답은 이 증거로 사용할 수 없다.
최종 성공은 별도로 저장 대화의 메시지 연결, 실제 tool 결과와 완료 상태를 확인해야 한다.
저장 대화 조회에는 제한 시간을 둔다. 전송 결과가 불명확한 요청은 재전송하지 않는다.
PowerShell 명령은 선언된 shell에 직접 전달한다. 변수 `$name`이 있는 명령을 다시
`powershell -Command "..."`로 감싸면 부모 shell이 변수를 먼저 치환할 수 있다.
자식 shell이 필요한 경우 single quote 또는 encoded command로 인수 경계를 보존한다.
검증 중 명령 하나라도 실패하면 fallback 명령 성공으로 전체 통과를 만들지 않는다.
Windows Scheduled Task의 stop은 하위 실행을 모두 종료한다는 뜻이 아니다. 통합 변경과
복구에서는 exact helper/Tunnel/server의 부모 관계·시작 token·command hash를 확인하고
해당 유휴 tree만 종료한다. 이전 프로세스 부재, 새 instance, Running task와 실제 gateway
경로를 확인해야 성공이다. 복구 영수증은 원래 설정·task 파일 hash와 독립 Native PID도 결속한다.
실제 장애 시험에서 운영 secure-Tunnel Workspace와 같은 config로 두 번째 STDIO server를
띄우지 않는다. 단일 소유자 방어의 `runtime_owner_active`는 의도된 거부다. Native를 유휴
상태에서 한 번 중단하고, 기존 운영 AICC를 새 Chat에서 조회해 독립 생존을 확인한다.
Native upstream 호출은 연결 부재에서 거부돼야 한다. 중복 기동 없이 원래 설정을 복구하고,
시작 관측이 늦으면 같은 소유자에 대한 읽기 조회로 확인한다. 최초 실패 기록은 보존한다.
별도 Native Tunnel의 `runtimes status`는 원격 조회를 포함하므로 10초를 넘을 수 있다.
조회 제한은 30초이며 timeout·실패 exit·잘못된 JSON·누락된 필드는 UNKNOWN이다.
프로세스 부재나 stopped로 바꾸지 않으며 UNKNOWN에서 자동 connect/restart하지 않는다.

`verify`는 exact 계약의 도구 이름·분류, 원격 활성 상태와 게시 검토 상태를 확인한다.
설치 목록·schema는 작업용 CDP session에서 UI가 보낸 exact API 요청에만 `Cache-Control`과
`Pragma: no-cache`를 적용한다. JavaScript 등 화면 파일의 캐시는 유지한다. 전체 캐시를 끄면
화면 파일을 매번 다시 내려받느라 hydration이 끝나지 않고 앱 API 요청도 없을 수 있다.
다른 계정·공간 헤더는 유지하고 다른 CDP session의 요청은 변경하지 않는다. 작업 끝에는
interception을 해제한다. disk/memory cache나 service worker 응답은 최신 설치 근거로 쓰지 않는다.
HTTP 200 헤더만으로 목록을 확정하지 않는다. 전체 JSON 본문을 읽어 해석할 수 있어야 하며,
`loadingFinished` 이벤트가 누락돼도 본문 읽기의 성공을 독립 근거로 사용한다.
새 화면으로 이동한 관측은 최대 90초, 기존 화면 관측은 최대 45초 안에 본문을 얻지 못하면
UNKNOWN으로 남긴다. 관측·전체 status 경과 시간도 기록한다. cache/profile 전체 삭제나
Personal을 겨냥할 수 있는 임의 fetch는 사용하지 않는다. 신원 조회는 자체 30초 제한을 갖고,
관리 session은 앞뒤의 실제 계정·공간 hash가 같아야 한다.
`status`는 exact 계정·공간 정책에 묶인 앱 상세 화면에서 전체 설치 목록을 한 번 읽고
앱별 schema를 확인한다. 일반 `/plugins` 랜딩의 공개 목록·화면 로딩 여부로 설치를 추측하지 않는다.
설치 목록은 `/plugins/<exact-id>`, 도구 정의는 `/settings/plugins-settings/<exact-id>`에서
관측한다. 상세 화면의 `include_actions=false` 응답으로 도구 계약을 검증하지 않는다.
작업용 탭은 ChatGPT 시작 화면에서 신원을 확인한 뒤, 응답 감시와 exact API 재검증을 먼저
설정하고 exact 화면으로 이동한다. 처음 로딩 중인 앱 화면을 즉시 reload하면 요청이 없을 수
있다. `status`, `reconcile`, public bridge 모두 같은 정책 기반 exact 앱 anchor를 사용한다.
`status`는 하나의 lease와 탭에서 설치 목록을 한 번 읽고 모든 앱의 schema를 순차 관측한다.
작업 전체의 앞뒤 신원 검증은 유지한다. 마지막 신원 검증 실패는 앞선 도구 응답이 있어도
전체 PASS가 아니다. 원격 tool contract와 실제 runtime/canary의 성공은 별도로 기록한다.
정확한 설치가 활성 상태이고 도구
계약·검토가 모두 일치해야 PASS다. 앱 부재·비활성·신원 불일치·관측 실패는 HOLD다.
읽기 실패도 안전한 phase·failureClass·관측 통계를 담은 JSON으로 출력하고 exit 1을 반환한다.
실패 파일이 비어 있거나 이전 PASS처럼 보이지 않게 한다. 외부 변경의 불명확한 결과는
UNCERTAIN으로 기록하며 자동 재전송하지 않는다.
`sync`는 비교 미리보기이며 commit은 refresh → reviewed publish → independent post-read다.
이미 일치하면 변경하지 않는다. 불확실한 sync는 app별 영수증이 다음 변경을 막는다.
원격에 없는 manifest hash는 검증됐다고 쓰지 않는다. public planner의 명시적
`verificationBasis=remote-catalog`는 source manifest 비교와 구별되는 검증 계약이다.

public CLI는 sealed private driver로 읽기부터 실행한다. driver 파일의 SHA-256을 매번 확인하고
한 변경만 dispatch한다. private Node driver는 모든 local import가 포함된 worker bundle hash를
확인한 뒤 structured stdin을 전달한다. driver만 고정하고 dirty worker를 실행하지 않는다.
`AICC_CHATGPT_APP_MANAGER_BUN`, `AICC_CHATGPT_APP_POLICY`,
`AICC_CHATGPT_APP_MANAGER_STATE_ROOT`는 비밀이 없는 exact 로컬 경로다.

```powershell
node bin/aicc workspace app-sync inventory --request-file ABSOLUTE_JSON --driver-file ABSOLUTE_MJS --driver-sha256 HASH --json
node bin/aicc workspace app-sync plan --topology-file ABSOLUTE_JSON --inventory-file ABSOLUTE_JSON --json
node bin/aicc workspace app-sync execute --plan-file ABSOLUTE_JSON --operation-id ID --driver-file ABSOLUTE_MJS --driver-sha256 HASH --state-root ABSOLUTE_DIRECTORY --json
```

inventory request는 schemaVersion 1, exact `accountAlias`, explicit `surfaceProfile`을 가진다.
관측되지 않은 manifest/count/reference는 null/unknown으로 유지한다. `delete`는 installed 목록과
별도의 complete registered 목록, disabled exact ID, reference zero, 대체 canary, backup SHA-256과
복구 시험을 요구한다. 정확한 삭제 확인·요청·후속 registered 목록이 없으면 UNCERTAIN이며
재전송하지 않는다. 이 삭제 adapter는 guard 시험만 통과했고 live 삭제는 미검증이다.
`enable`과 `disable`은 계정 설치가 아닌 공유 등록 변경이다. 완전한 registered 목록과
Business owner 신원을 확인하고, 정확한 availability control·요청·후속 등록 상태를 검증한다.
`enable`은 disabled 등록에만 적용한다. live 복구 시험 전에는 구현만으로 복구를 보장하지 않는다.
최신 admin은 변경 뒤 `변경 사항 검토` 확인창을 보여준다. 정확한 앱 route와 작업에 연결된
단일 확인창에서 원하는 상태를 검증한 뒤 `변경 사항 확인`을 누른다. 앱 이름이 확인창에
반복되지 않는다는 이유로 구형 확인창을 계속 기다리지 않는다. 요청 결과를 post-read 전에
VERIFYING 영수증에 보관하며, 상태가 불명확하면 원래 결과를 유지하고 재전송하지 않는다.
`reconcile-availability`는 완전한 등록 목록과 exact admin 상태를 다시 읽어 원본 hash에
연결된 applied/not-applied 결과만 기록한다. 원래 UNCERTAIN 영수증은 덮어쓰지 않는다.
공유 disable 뒤 앱이 complete WORKSPACE 목록에서 사라지고 exact admin에서
`플러그인을 사용할 수 없음`이 보일 수 있다. 두 근거가 함께 있을 때만 UNAVAILABLE로 조정한다.
이 상태를 definition 삭제로 바꾸지 않는다. 숨겨진 정의의 실제 복구 경로가 검증되기 전에는
`enable` 구현이나 disabled 등록 guard만으로 복구가 보장됐다고 보고하지 않는다.
driver는 adapter가 없는 create를 변경 전에 거부한다. Personal live 조사와 generic executor의
존재를 전체 앱 관리 완료로 보고하지 않는다.

### Native MCP 반복 장애 예방

JSON-RPC STDIO의 stdout에는 JSON frame만 출력한다. 진단은 stderr로 보내고 실제 bundled
helper의 큰 응답·재초기화·오류 응답을 엄격 decoder로 검사한다. console.info 한 줄이
Tunnel decoder 종료와 EPIPE를 일으킬 수 있다. SDK client가 경고만 남기고 계속 읽는
시험으로 이 장애를 통과시켜서는 안 된다.

Windows Native `workspaceWrite`는 전역 owner cache에 쓰지 못한다. snapshot helper는
exact task 안의 `.aicc-workspace-snapshots`를 사용하며 외부 경로·junction은 거부한다.
새 Git 시험 폴더에는 tracked marker와 HEAD가 있어야 한다. root 밖 권한을 넓혀 해결하지
않으며 읽기 전용 task는 쓰기 cache를 사용할 수 있다고 광고하지 않는다.
snapshot cache의 ACL owner는 그 명령을 실제 실행한 Windows 사용자다. Native sandbox가
만든 cache를 다른 로컬 사용자로 읽다 ACL 거부가 나면 권한을 넓히지 않는다.
private release build는 `AICC_WORKSPACE_SNAPSHOT_SOURCE`의 standalone public engine을
Node bundle로 고정하고 release manifest/hash에 포함한다. runtime은 설치된 고정본을
사용한다. 수정 중인 source root를 live helper로 계속 참조하지 않는다.

live 현재 revision·실패·복구 경로는 [운영 정본](../../../context/PROJECT.md)에만 기록한다.

### 장애 시험과 늦은 저장 결과

`smoke-unified-workspace-failure.ps1`은 기본 preview이며 exact gateway/provider hash,
profile/config hash, Native PID, task XML, Workspace lease 0과 Native turn 0을 요구한다.
commit은 소유한 Workspace tree만 중단한다. `IncludeBoth`는 이어서 Native를 정상 중단하고
OCX 생존을 확인한다. finally에서 같은 설정을 복구하며 다른 route/account/app은 바꾸지 않는다.
Workspace startup의 일시적인 status 실패는 UNKNOWN으로 기다리고 start를 반복하지 않는다.
이 시험의 성공은 runtime outage/복구 증거다. 두 서비스 중단 중 모델 추론 증거가 아니다.

새 Chat 도구 시험은 저장된 user marker, 최종 assistant 완료, 실제 assistant 도구 호출,
tool-role 결과와 오류 부재를 확인한다. 사용자 질문·일반 답변·resource catalog 안에 도구 이름이
있다는 이유만으로 호출을 증명하지 않는다. 완성된 화면 뒤에도 API의 tool record가 늦게 붙을 수
있으므로 최대 30초 더 읽는다. 안정된 DOM 문장만으로 시험을 통과시키거나 즉시 재전송하지 않는다.
실패에는 safe canonical conversation URL과 분류만 남긴다. 원본 HOLD는 보존하고 같은 시험 대화의
독립 readback 및 hash-bound 조정으로 회복을 기록한다. 대화 원문은 증거 파일에 복제하지 않는다.

## Workspace 검색

Workspace MCP의 검색은 `rg`를 사용한다. GUI·LaunchAgent의 PATH는 로그인 shell과 다르므로
bare `rg` 실행에 의존하지 않는다. `AICC_RG_EXECUTABLE`, PATH의 executable, 알려진 owner
runtime 순서로 absolute executable을 결정하고, 찾지 못하면 명확하게 실패한다.

live 검색은 `rg` 전체 출력을 메모리에 모으지 않는다. stdout을 줄 단위로 읽고 요청한
`max_results`보다 결과 하나를 더 관찰하는 즉시 해당 검색 프로세스만 종료해 `truncated`와
`limit_reason`을 반환한다. 따라서 큰 workspace에서도 `ENOBUFS`가 검색 결과가 되지 않아야 한다.
본문 검색은 JSON event의 exact path/line을 사용하므로 단일 파일 `path`에서도 파일명이 사라지지
않으며, `files_only=true`는 `query`가 상대 경로에 포함된 파일만 반환한다. 민감 파일과 무시
디렉터리는 `rg`가 읽기 전에 glob으로 제외하고, 반환 path는 canonical workspace root 내부의
상대 경로로 다시 검증한다.

read-only session은 surface별 owner-only store를 사용하며 durable job writer lock과 분리한다.
따라서 active writer가 있어도 read open/search/read를 막지 않는다. write lease와 replay
원장은 계속 durable job store를 사용한다.

exact Git workspace에서는 read-only open이 기존 snapshot/cache 엔진에 immutable fingerprint를
결속한다. tracked 전체 범위를 대표할 때 search/read 결과를 캐시하고 cache hit를 응답에
표시한다. 선택되지 않은 untracked 파일이 있으면 전체 검색은 live `rg`를 사용하고, tracked
상태가 open 뒤 변하면 `snapshot_stale`로 fail closed한다. snapshot PASS를 live workspace
최신성으로 오인하지 않으며 포트·프로세스·Tunnel·account quota·readiness는 항상 live probe한다.

현재 Business 22/17/5와 Personal 18/18/0 published ABI는 유지한다. 후속 app의
`workspace_context`는 기존 read lease/snapshot 위에서 bounded evidence만 묶는 compatibility
layer다. query는 최대 5개, path는 최대 20개이며 path/hash/reason/excerpt와 snapshot/cache 상태를
돌려준다. untracked 파일은 명시 선택되지 않으면 live no-cache 또는 incomplete 판정으로 처리하고,
결론·명령·프로세스 상태는 반환하거나 캐시하지 않는다.

## 개인 클라이언트 설정 후보 생성

`aicc workspace prepare-client-config --surface personal-read-fetch`는 stdin의
schemaVersion1 owner bindings로 후보 JSON을 출력한다. 최소 입력은
`{"schemaVersion":1,"serverName":"owner_workspace"}`다. 현재 실행 Node/source와
기존 configure-local 설정을 resolver로 결속한다. 다른 호스트/설치본을 준비할 때는
nodeExecutable, sourceRoot, stateRoot의 명시 절대경로를 입력한다. 공개 source에는
사용자의 홈·계정·고정 실행 파일·공급자 버전을 기본값으로 넣지 않는다.

결과 workspaceMcpJson은 `.mcp.json` 후보이고 파일을 쓰지 않는다. marketplace를
입력하려면 `{root: 절대경로, pluginRelativePath: root 아래 상대경로}`를 사용한다.
marketplace root를 checkout으로 추측하지 않으며 미지정이면 UNBOUND로 남긴다.
구형 plugin·marketplace·manifest를 생성하거나 기존 plugin을 재등록하지 않는다.
기존 로컬 STDIO owner/config/surface만 재사용하고 새 권한·원격 인증을 만들지 않는다.
로컬 설정이 없으면 기존 `configure-local --surface ...` manager의 지원 설정이
선행돼야 하며 이 후보 명령은 그 단계를 자동 실행하지 않는다.

nodeRepl 미지정은 기존 공급자 설정 보존이다. 명시 후보가 필요하면
`nodeRepl: {sourceOwner: 설치 담당 식별, config: 기존 설정 객체}`를 입력한다.
허용 필드는 command/args/env/env_vars/startup_timeout_sec/tool_timeout_sec/enabled다.
알 수 없는 필드는 버리지 않고 거부한다. 후보 TOML은 별도 nodeRepl.fragmentToml에
두며 Workspace plugin에 node_repl을 중복 등록하지 않는다. env/pipe/runtime 값은
명시 입력만 보존한다. 다른 호스트·세션으로 그대로 복사하지 않고 공급자 installer가
현재 경로와 pipe를 재결속해야 한다. 결과는 소유 PC에만 보관하고 원격 게시하지 않는다.

이 명령은 프로세스·서비스·테스트·설치·활성 config 쓰기 없이 PREPARED_ONLY를 출력한다.
실제 적용은 현재 exact plugin/marketplace와 지원 installer owner, 원본·rollback이
확인된 manager의 별도 단계다. 현 설치 목록에는 AICC 개인 plugin이 관측되지 않았고
원 생성기 영수증/installer owner는 미확정이므로 이 작업에서는 활성 등록을 하지 않았다.
구현 후 검증·명령 실행·후보 생성·등록은 미실행이다.

# Windows native operations

이 문서는 macOS에서 이관된 저장소가 Windows에서 어떤 경로를 실제로 사용하고, 어떤 경로를
명시적으로 격리하는지 정의한다. 상태 조회는 read-only이고 각 외부 probe는 유한한 timeout 뒤
`attention`/`timedOut`으로 실패 닫힘 처리한다.

## 승인된 파일 작업과 격리 계정

파일 접근 오류는 실행 신원·OS DACL·도구 승인으로 나눠 처리한다. `whoami`와 정확 대상의 `Get-Acl -LiteralPath`로 확인하고, 격리 계정의 읽기 전용 권한을 사용자 소유권 상실이나 관리자 권한 부재로 해석하지 않는다. 관리형 격리 설정은 현재 세션의 실제 도구 계약을 따르며 사용자 config만으로 덮어쓰지 않는다.

소유자 파일의 승인된 쓰기·기존 비공개 백업·설치 준비는 현재 제공된 정상 승인 실행 경로를 사용한다. `on-request + auto_review`를 유지하며 같은 대상에 실패할 격리 쓰기를 반복하지 않는다. Git의 소유권 오류도 실제 저장소 소유자 실행으로 처리하고 전역 `safe.directory=*`, 홈 전체 ACL, 보안 guard를 바꾸어 숨기지 않는다. 정상 승인 경로가 거절되면 정확 대상·동작·이유와 해제 조건을 원 작업에 남기며 다른 실행기로 우회하지 않는다.

설치 후보의 전체 gateway graph 검사는 기존 owner-local dependency까지 읽으므로 처음부터 등록된 정상 host 실행 경로를 사용한다. 이번 세션의 `require_escalated` 승인 경로는 `AUTOTRADER\demo-owner`의 비상승 token이며, 관리형 `CodexSandboxOffline`의 파일 DACL 범위와 구분한다. 같은 exact 후보에 대한 읽기 전용 `Validate-Candidate`가 격리 계정에서 기존 Native dependency 파일의 `AccessDenied`를 반환한 것은 그 파일을 바꿀 권한 요청이나 도구 정책 거절의 증거가 아니다. 이미 승인된 동일 명령을 정상 owner 경로에서 회수하고 신원·결과를 기록한다. ACL·격리 정책·모델 경로는 변경하지 않는다. 정상 경로의 자동 검토가 명시적으로 거절하거나 owner도 접근 거절이면 그 경계를 보존한다.

도구 입력의 보안 거절, 일반 OS 접근 거절, 입력 hash 변경, 미구현 설치 단계, 외부 서비스 기능 한계는 서로 다른 원인이다. 필요한 기능이 없으면 기존 정식 도구에 해당 단계를 보완하고, 현재 pin·원본·복구·불명 요청을 보존한다. 제한된 도구의 크기 한도를 분할·인코딩으로 우회하지 않는다. 비대화형 실행의 stdin EOF는 전송 전 입력 준비 실패이며 POST/발신 영수증과 구분한다.

## 분류

| 영역 | 분류 | Windows 계약 |
| --- | --- | --- |
| `aicc status --json` | Windows 구현 | OCX 상세 조회와 계정 목록은 짧은 bounded probe이며 계정 quota refresh는 자동 실행하지 않는다. 비동기 component는 12초 deadline으로 격리하고, 동기 native child probe는 더 짧은 자체 timeout 뒤 나머지 상태를 반환한다. |
| command runner | Windows 구현 | timeout 시 AICC가 시작한 process tree만 `taskkill /T /F`로 종료하고, 종료 이벤트가 오지 않아도 grace deadline에 결과를 반환한다. |
| OpenAI API guard key | Windows 구현 | Windows Credential Manager의 AICC 소유 Generic Credential을 PowerShell helper로 읽는다. key는 argv, 환경변수, 로그, 원장에 넣지 않는다. macOS는 기존 Keychain 항목을 유지한다. |
| Workspace Tunnel scheduler | Windows 구현 | `install-windows-task.mjs`가 현재 사용자·최소 권한의 exact Scheduled Task와 owner-only receipt를 관리한다. 변경은 명시적 install/stop/rollback에서만 가능하다. |
| Workspace local STDIO | Windows 구현 | `workspace configure-local`이 기존 registry에서 전용 config·identity·runtime·read store를 만든다. `workspace doctor --local`은 Tunnel 없이 prerequisites와 active guard를 판정한다. PowerShell 7 owner/SYSTEM ACL과 exact Git-root guarded write를 유지한다. |
| notification process-due scheduler | Windows 구현 | hidden `wscript.exe` launcher와 exact Scheduled Task를 사용한다. rollback은 기존 schema 1 및 현재 schema 2 receipt를 모두 검증해 복구한다. |
| Codex task callback | Windows 구현 | bundled App Server/stdio callback은 OS 중립 경로를 사용한다. Desktop 강제 재시작 권한을 암시하지 않는다. |
| shared-daemon Desktop callback | macOS 전용 격리 | `launchctl setenv`와 Desktop 재시작을 묶는 worker는 Windows에서 첫 동작 전에 거부한다. |
| project services | macOS 전용 격리 | LaunchAgent status/start/stop은 Windows에서 `supported: false`로 반환하고 `launchctl`, `plutil`, `lsof`를 실행하지 않는다. |
| upstream 에이전트 검토 scheduler | Windows 구현 | `Manage-AiccSchedulerTask.ps1`가 같은 local scheduler의 review 전용 tick을 최소 권한·숨김·5분 간격으로 연결한다. 24시간 due별 검토 할 일과 exact 기존 agent queue 접수만 수행하며 설치하지 않는다. |
| Dashboard·전체 scheduler 자동 시작 | macOS 전용 격리 | 전체 LaunchAgent installer의 플랫폼 제한은 유지한다. Windows review 전용 예약과 다른 알림·크롤러 실행을 혼합하지 않는다. |
| Codex Desktop restart UI | macOS 전용 격리 | `osascript`, Finder, `launchctl`을 쓰는 수명주기 함수는 macOS guard 뒤에만 있다. Windows status/CLI의 정상 경로가 아니다. |
| CM auth portal sync | macOS 전용 격리 | `mac_sync.py`와 해당 LaunchAgent plist는 macOS machine-token sync 전용이다. Windows에서는 URL을 읽는 read-only status만 공용이며 sync를 가장하지 않는다. |
| Linux auth broker deploy | 플랫폼별 운영 자료 | systemd broker/cloudflared unit은 원격 Linux 배포 자료이며 Windows 로컬 서비스가 아니다. |
| 이전 macOS migration/recovery 문서 | 역사적 보존 | Keychain·LaunchAgent·Finder 언급은 과거 또는 macOS runbook 문맥으로만 보존한다. Windows 실행 계약으로 해석하지 않는다. |

## 검증 경계

- fixture runner로 slow/hung command, per-component timeout, Windows process-tree 종료 결과를 검증한다.
- Windows status 실측은 read-only로만 수행한다. 계정 refresh, route 전환, browser 조작, Tunnel 설치,
  token 저장은 status 검증에 포함하지 않는다.
- 전체 게이트는 `npm run verify:windows`다. macOS 전용 파일은 parse/test fixture로 보존하되 Windows에서
  `launchctl`, `osascript`, Finder를 호출하는 통합 경로를 만들지 않는다.

## Native Codex와 Workspace 복구 (2026-10-04)

평소에는 `codex`를 사용한다. 문제가 생기면 `aicc doctor`, 안전한 자동 복구는
`aicc repair`를 실행한다. 설치 배너만 계속되면 `codex-repair --sandbox`가 공식
`codex sandbox setup --elevated --current-user`를 한 번 실행하고 상태를 다시 확인한다.
관리자 승인이 필요한 sandbox 복구는 background 모드에서 창을 띄우지 않고
`NEEDS_FOREGROUND`로 반환한다. `aicc repair --background`는 이 경계를 지킨다.

- 복구 명령은 해시로 검증된 `.codex/windows-health/releases/<hash>`의 파일을 사용한다.
  npm의 다른 AICC 명령, OpenAI standalone updater와 실행 파일은 바꾸지 않는다.
  기존 shim의 원본과 설치 영수증을 보존하며 source/release/wrapper drift이면 중단한다.
- 진단은 공식 standalone Codex와 실제 Tunnel profile에 고정된 50-tool gateway를 확인한다.
  이전 global AICC CLI의 19-tool 조회를 현재 Workspace 계약으로 해석하지 않는다.
- `native`, `ocx`, 다른 provider를 구분한다. 현재 복구는 정상 native `openai` 경로만
  유지한다. OCX의 의도적인 중지는 장애로 판단하지 않으며 자동 시작하지 않는다.
  auth, OCX 계정, provider 정의, rollout과 SQLite DB는 복구 대상으로 삭제하지 않는다.
- Workspace 재시작은 기존 최소 권한 Task의 소유와 source hash, 활성 lease 0,
  원래 profile을 확인한 뒤 기존 installer를 사용한다. 사용자나 다른 프로세스는 종료하지 않는다.
  지속 실행해야 하는 tunnel의 exit 0도 `unexpected_tunnel_exit` 실패로 처리하여 기존
  Scheduler의 유한한 restart 정책을 적용한다. secret과 stderr 원문은 남기지 않는다.
  외부 프로세스 종료가 Scheduler 실패로 잡히지 않는 경우도 있으므로 같은 Task에
  1분 간격의 복구 trigger와 `IgnoreNew`를 둔다. 실제 종료 후 새 instance 복구를 확인했고,
  정상 실행 중에는 중복 프로세스를 만들지 않았다. profile만 바꾸는 검증된 cutover는
  기존 installer의 `rebind-profile`로 해시 영수증만 갱신한다. Task와 프로세스를 재시작하지 않으며
  profile/Task 원본과 갱신 전 영수증을 보존한다.

이번 Sandbox 실패 로그는 WFP 등록 후 `.sandbox-bin` 디렉터리 lock/open 실패를 기록했다.
marker는 Windows 사용자와 CODEX_HOME에 연결되고 ChatGPT 계정 ID를 저장하지 않는다.
계정 전환 직후 배너가 재현됐지만, 계정 전환이 상태를 무효화하는 정확한 경로와 어느 프로세스가
디렉터리 접근을 거부받았는지는 확정할 수 없다. 임의 ACL 변경이나 registration 변수를
강제로 설정하지 않는다. 현재 공식 App Server `windowsSandbox/readiness`는 `ready`다.
현재 대화를 실행하는 Desktop 강제 재시작은 이 복구의 일부가 아니다.
`codex sandbox windows --help`는 0.160.0에서 도움말 대신 실행 경로를 타고 설정을 갱신했다.
진단에 이 명령을 사용하지 않는다. 이번 호출은 프로젝트 ACL 갱신 실패를 기록했지만,
기존 setup marker와 실제 readiness는 유지됐다. 공식 current-user setup은 관리자 실행을
요구하여 현재는 사용자 관리자 실행 대기다. 실패 파일을 지워 정상처럼 표시하지 않는다.

`CODEX_WINDOWS_REGISTERED_CORE`는 MSIX가 등록한 packaged core에 관한 값이다.
일반 standalone CLI에서 값이 없다는 이유로 전역 환경 변수에 추가하지 않는다.
Defender 차단 근거가 없는 상태에서 제외 경로나 비활성화를 적용하지 않는다.

AICC notification hook은 Codex가 선택한 PowerShell에서 실행한다. 따옴표로 감싼
실행 파일을 단순 나열하면 `exit code 1`이므로 installer가 `& 'node 경로' 'script 경로'`
형식으로 생성한다. 같은 script/인자만 복구하고 기존 hook의 승인 hash만 갱신했다.
`probe-native-hook-launch.mjs`는 ephemeral turn과 loopback 오류 fixture를 사용하여
실제 `hook/completed`를 확인한다. notification binding이 있으면 시작하지 않으며
모델 추론이나 알림 발송을 수행하지 않는다. 이번 실제 결과는 수정 전 `failed`,
수정 후 `completed`이고 관련 13개 테스트도 통과했다.

History parity 경고는 정상 DB의 선택된 rollout과 복구/분기 사본의 목록 차이다.
이번 조사에서 missing으로 센 20개 파일의 metadata thread ID는 모두 DB에 있었고,
9개 ID에는 여러 파일이 있었다. 파일명 끝 UUID로 재색인하거나 사본을 삭제하지 않는다.
`ocx recover-history --ocx-compaction`은 해독 가능한 OCX compaction을 백업 후 plain
summary로 복구하는 기능이며, provider migration이나 DB reindex가 아니다.

Workspace의 `appcontainer-windows` 실행은 `Set-Location C:\...`에서 접근 거부가 재현됐다.
허용된 프로젝트를 `AiccWorkspace:` 드라이브에 직접 연결하여 volume root metadata 조회를
피한다. `Out-Default`로 명령의 출력 형식을 종료 전에 완성한다. OS 권한, ancestor capability와
network 정책은 유지한다. 실제 로컬 임시 파일 쓰기와 출력 표식, exit 0을 확인한 broker만
새 immutable release에 적용했다. 웹에서는 실행/poll/stop 호출까지 확인했으나 마지막 응답과
close 확인이 시간 초과됐다. 따라서 전체 웹 exec 검증은 보류다. 재전송하지 않았으며 최종
activeLeases는 0이다. 기존 release는 보존한다.
등록 alias `open-aicc`는 `C:\demo\projects\ai-platform\repos\open-AICC` 별도 사본을 가리킨다.
소스 작업 경로 `C:\demo\open-AICC`와 혼동하지 않으며 등록을 임의로 바꾸지 않는다.

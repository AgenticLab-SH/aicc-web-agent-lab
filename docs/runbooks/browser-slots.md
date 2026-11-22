# CDP 브라우저 슬롯 이식 설치 (macOS / Windows)

최신 private coordination에 등록된 전용 Chrome CDP 슬롯을 새 Mac 또는 Windows
장치에서 재구성하는 절차다. 아래 포트 예시는 기존 런처 자산을 설명하며
현재 계정·역할·사용 권한이나 미래 포트 지원을 뜻하지 않는다. 이 저장소 체크아웃만으로 런처·아이콘·포트 배지
확장이 모두 갖춰진다. 브라우저 프로필과 로그인 세션은 포함되지 않으며, 장치별로
새로 생성하거나 별도 승인된 세션 이전 절차를 따른다.

마지막 창 종료 뒤의 controller/vendor process, Dock 표시, exact PID 소유권,
target lease와 client 보존 및 live 교체 규칙은
[`browser-resource-lifecycle.md`](browser-resource-lifecycle.md)를 따른다. Dock 아이콘,
경과 시간, CPU 또는 RAM만으로 idle을 판정하지 않는다.

## 계정과 포트 점유 계약

포트는 계정 번호나 요금제가 아니다. 실제 역할은 owner-private coordination에서 정하고 현재 로그인과 작업공간을 별도로 확인한다. 계정 전용 슬롯을 Pro 전용으로 추정하지 않는다.

자동 배정은 `AccountAlias`와 `Workspace`를 반드시 지정한다. 일반 자동화의 선호 포트가 점유됐으면 `PreferredPort`를 사용해 같은 신원의 등록 포트 중 다음 번호를 고르고, 이후 낮은 번호로 돌아간다. 정확한 포트 지시는 `SlotPorts`로 고정하며 다른 포트로 이동하지 않는다. 임의의 미등록 포트를 열거나 프로필·로그인을 복제하지 않는다. 선택 가능한 같은 신원의 슬롯이 없으면 bounded busy/HOLD다.

```powershell
pwsh -NoProfile -File tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1 `
  -Action Acquire -AccountAlias <등록별칭> -Workspace <등록작업공간> `
  -PreferredPort <선호포트> -ExclusiveSlot -AsJson
```

전용 자동화 슬롯은 private coordination의 `cdp_slotN_exclusive = true`로 한 agent의 lease만 허용한다. 여러 소유 탭을 허용하는 다른 슬롯의 상한은 기존 정책을 유지한다. 만료 시각이 잘못됐거나 JSON이 손상됐거나 회수가 실패한 점유는 빈 자리로 판정하지 않는다.

기본 동작은 실행 중인 기존 브라우저를 재사용한다. `PreferredPort` 풀에서는 offline 슬롯을 제외하며 identity 불일치는 HOLD다. 등록된 기존 프로필의 기동까지 명시적으로 허용된 작업만 `AllowBrowserStart`를 사용할 수 있다. 이 옵션도 다른 프로필이나 미등록 포트를 만들지 않는다.

작업은 짧은 action interval의 target 하나만 만들고 즉시 반환한다. 반환이나 만료된 소유 lease 회수는 exact target만 닫는다. 사용자 탭·다른 작업 탭·모호한 탭은 유지한다. 백그라운드 실행, 낮은 CPU 또는 오래된 탭만으로 사용하지 않는다고 판단하지 않는다. QA 포트는 인증된 계정 포트 풀에 넣지 않는다.

## 전제

- 정식 서명된 벤더 브라우저가 설치되어 있어야 한다.
  - Chrome 슬롯: macOS `/Applications/Google Chrome.app`,
    Windows `C:\Program Files\Google\Chrome\Application\chrome.exe`
- PowerShell 7 이상과 Node.js가 필요하다. 배지 설치기는 Node의 내장 WebSocket을
  사용한다.
- Chrome for Testing은 사용하지 않는다.

## 1. 저장소 체크아웃

```bash
git clone https://github.com/AgenticLab-SH/aicc-web-agent-lab.git
```

체크아웃 루트를 이후 단계에서 `<aicc>`로 표기한다. 설치 위치는 자유지만 개인
프로필과 설정은 항상 `~/.ai-control-center`에 둔다.

## 2. 슬롯 프로필 루트 확인

프로필은 반드시 기본 브라우저 사용자 루트가 아닌 전용 non-default 루트를 쓴다.
Chrome 136 이후 기본 사용자 루트에 대한 원격 디버깅은 차단된다.

| 슬롯 | macOS | Windows |
| --- | --- | --- |
| Chrome 9222 | `~/.ai-control-center/browser-profiles/chrome/9222/UserData` | `%USERPROFILE%\.ai-control-center\browser-profiles\chrome\9222\UserData` |
| Chrome 9223 | `~/.ai-control-center/browser-profiles/chrome/9223/UserData` | `%USERPROFILE%\.ai-control-center\browser-profiles\chrome\9223\UserData` |
| Chrome 9224 | `~/.ai-control-center/browser-profiles/chrome/9224/UserData` | 장치별로 명시 등록 |
| CDP Chrome slot 4 · 9225 | `~/.ai-control-center/browser-profiles/chrome/9225/UserData` | 장치별로 명시 등록; 실제 role은 private coordination이 권위 |
Chrome 슬롯의 프로필 디렉터리 이름은 `Default`다.

### 슬롯 포트와 자동화 surface는 같은 말이 아니다

`CDP 9224`처럼 포트가 명시된 작업은 정확히 `http://192.0.2.1:9224`의 registered CDP slot만
사용한다. 일반 Chrome/Chrome connector, Codex 인앱 Browser, routed Web GPT는 같은 ChatGPT URL이나
같아 보이는 계정을 표시해도 해당 요청을 충족하지 않는다. 등록되지 않은 slot이거나
profile·account·workspace 검증이 실패하면 다른 surface로 fallback하지 않고 prompt 입력·첨부·전송 전
HOLD한다. 등록 slot의 listener가 단지 꺼져 있는 것은 정상적인 dormant 상태다. 이때
기본 Acquire는 기존 실행 브라우저만 재사용한다. 기존 등록 프로필의 기동이 승인된 작업은 `Manage-CdpChromeSlotLease.ps1 -Action Acquire -SlotPorts <port> -AllowBrowserStart -Url <url>`로 exact launcher를 기동하고
identity 검증 뒤 소유 target을 만든다. 기동 승인이 없으면 dormant 슬롯은 HOLD다.

Dock 아이콘과 포트 배지는 사람이 창을 구분하기 위한 단서다. 실제 자동화 identity는 listener PID,
전용 profile root, private coordination의 slot account/workspace, task-owned target ID, in-page identity를
각각 확인한다. visible `Pro` 하나만으로 9224 연결을 증명하지 않는다.

현재 lease helper는 등록 slot 안에 새 task-owned background target을 만들며 기존 사용자 탭을 선택하거나
활성화하지 않는다. 기존 saved conversation을 이어갈 때도 새 target에서 exact conversation URL을 열어
post-read한다. existing-user target 자체가 꼭 필요하지만 전용 lease가 없으면 `HOLD`가 맞으며 Chrome
connector로 우회하지 않는다.

ordinary Chat의 exact CDP 준비에는 다른 Codex task active/UNKNOWN 수나 17841 non-browser HTTP counter를
사용하지 않는다. 해당 값들은 CDP slot의 identity, target capacity 또는 provider rate limit 증거가 아니다.

사용자가 exact slot/account와 prompt·첨부 또는 작업 목적을 지정해 1회 Chat 제출을 명령했다면 그 명령이
전송 승인이다. 위 증명과 identity·privacy·cadence preflight가 PASS한 뒤 `보내도 될까요?`를 다시 묻지
않는다. `WAIT_UNTIL`은 같은 승인으로 재개하고, mismatch·unknown·HOLD는 prompt 입력이나 upload·send 없이
종료한다. 이 규칙은 route·로그인·publication·Project/GPT 자산 변경에는 적용하지 않는다.

## 3. 런처 설치

macOS:

```bash
pwsh -NoProfile -File "<aicc>/tools/platform/web-automation/Install-SeparatedBrowserAppsOnMac.ps1" -Replace
```

`~/Applications` 아래에 `CDP Chrome 9222.app`, `CDP Chrome 9223.app`이
생성된다. 두 앱 모두 벤더 엔진을 복제하거나
재서명하지 않는 경량 상주 런처이며, 포트·프로필·실행 경로가 모두 일치할 때만
기존 창을 활성화한다. Dock 등록이 필요하면 `-RegisterDock`을 추가한다.
일반 브라우저는 벤더 `/Applications/Google Chrome.app`을 그대로 사용한다.
AICC의 과거 일반 Chrome controller는 폐기되었고 설치 소스에서도 제거되었다.
일반 Chrome을 위한 별도 AICC 앱이나 Dock 항목을 만들지 않는다.

추가 슬롯 9224와 slot 4 기본 launcher 9225는 기존 런처/Dock을 건드리지
않도록 선택적으로 설치하고 append-only Dock 도구로 등록한다.

9225의 과거 로그인은 현재 역할의 증거가 아니다. launcher 이름은 역할 중립
`CDP Chrome 9225`로 유지하고 private coordination이 정한 exact workflow가 권위다.
예약된 profile을 자동 shared lease 대상으로 사용하거나 다른 로그인 profile로
fallback하지 않는다.

```bash
pwsh -NoProfile -Command '& "<aicc>/tools/platform/web-automation/Install-SeparatedBrowserAppsOnMac.ps1" -OnlyPorts @("9224","9225") -SlotOnly'
pwsh -NoProfile -File "<aicc>/tools/platform/web-automation/Register-CdpChromeDockEntriesOnMac.ps1"
```

Windows:

```powershell
pwsh -NoProfile -File "<aicc>\tools\platform\web-automation\Install-SeparatedBrowserAppsOnWindows.ps1"
```

`%USERPROFILE%\.ai-control-center\browser-launchers`에 슬롯별 실행 파일을 빌드하고,
`시작 메뉴 > AI Control Center`에 아이콘이 연결된
바로가기를 만든다. 바로가기를 만들지 않으려면 `-NoShortcuts`, 특정 슬롯만
처리하려면 `-OnlyPorts @('9222')`를 쓴다. 기존
`start_shared_chrome.ps1`도 그대로 사용할 수 있다.

### 아이콘 자산

아이콘은 저장소에 포함되어 있어 새 장치에서 따로 만들 필요가 없다.

| 용도 | 파일 |
| --- | --- |
| macOS 9222~9225 번들 아이콘 소스 | `tools/platform/app-icons/cdp_chrome_9222.png` ~ `cdp_chrome_9225.png` (1024px) |
| Windows 9222/9223 런처 아이콘 | `tools/platform/app-icons/cdp_chrome_9222.ico`, `cdp_chrome_9223.ico` (16~256px 6종) |

PNG 원본을 바꿨을 때만 macOS에서 `.ico`를 다시 생성하고 결과를 커밋한다.

```bash
pwsh -NoProfile -File "<aicc>/tools/platform/app-icons/Build-CdpSlotIcons.ps1"
```

## 4. 포트 배지 확장 설치

현재 Chrome은 `--load-extension` 실행 스위치를 제거했다. CDP의
`Extensions.loadUnpacked`도 세션 범위라 작업자나 확장 service worker가 종료된 뒤
사라질 수 있다. 따라서 배지는 검증된 프로필의 `chrome://extensions`에서 사용자가
한 번 **압축해제된 확장 프로그램 로드**를 승인해 영구 등록하고, AICC는 그 뒤 슬롯
값과 툴바 고정만 자동 구성한다.

확장 소스는 `tools/platform/web-automation/extensions/aicc-cdp-port-badge`이고,
압축 해제 확장 ID는 그 절대경로에서 파생된다. AICC를 다른 경로에 두면 ID도 바뀌므로
ID를 고정값으로 가정하지 말고 설치기 출력의 `extension_id`를 근거로 삼는다.

설치 준비 명령은 정확한 포트·프로세스·프로필을 먼저 검증하고 해당 프로필의 확장
관리 화면을 연다.

```bash
pwsh -NoProfile -Command "& '<aicc>/tools/platform/web-automation/Install-CdpPortBadgeExtension.ps1' -OnlySlots @('9224','9225') -PreparePersistent"
```

각 정확한 창에서 **압축해제된 확장 프로그램 로드**를 누르고 압축 파일이나
`manifest.json` 하나가 아니라 아래 폴더 자체를 선택한다.

```text
<aicc>/tools/platform/web-automation/extensions/aicc-cdp-port-badge
```

선택이 끝나면 AICC가 정확한 경로, 활성 상태, 툴바 고정, 슬롯 배지를 구성하고
검증한다.

```bash
pwsh -NoProfile -Command "& '<aicc>/tools/platform/web-automation/Install-CdpPortBadgeExtension.ps1' -OnlySlots @('9224','9225')"
```

팝업에서도 22/23/24/25 가운데 현재 프로필 값을 직접 선택할 수 있다.

슬롯이 실행 중이어야 하며, 각 슬롯을 하나씩 처리하는 것이 안전하다. 설치기는
포트 소유 프로세스와 프로필 일치를 먼저 검증하고, 확장이 `storage` 권한만
사용하는지 확인한 뒤 배지 텍스트까지 검증한다. 반복 실행해도 중복 설치하거나 다른
경로의 확장을 제거하지 않는다.

### 재시작 시 자동 복구

영구 등록된 unpacked 확장은 프로필과 함께 재시작 후에도 유지된다. 런처는 새
브라우저 PID에서 정확한 경로의 기존 확장을 최대 세 번 조회하고 슬롯 값만 다시
적용한다. 확장이 없거나 잘못된 경우 브라우저는 계속 사용할 수 있지만 런처가
세션 임시 확장을 반복 로드하지 않으며, 설치 준비 명령이 사용자 조치를 요청한다.

service worker 타깃은 유휴 상태에서 정상적으로 사라질 수 있으므로 타깃 존재만으로
설치 여부를 판단하지 않는다. `chrome.developerPrivate.getExtensionsInfo`에 보고되는
영구 등록 경로·활성 상태·툴바 고정과 실제 배지 값을 함께 검증한다.

### 별도 Git 저장소 확장 등록

확장 소스를 open-AICC 아래로 복제하지 않는다. owner registry editor의 `TrustRoot`는
확장 폴더 자체가 symlink/junction이 아닌 clean Git worktree root인지, exact origin과
40자 HEAD가 승인값과 일치하는지 확인한 뒤 그 정확한 경로만 신뢰한다. `Register`는
고정 근거를 다시 확인하고 manifest의 permission·host permission·content script가
정의의 allowlist와 정확히 같을 때만 항목을 만든다.

host/content 범위가 하나도 없는 확장은 빈 allowlist를 `forbid_host_permissions:true`로
정규화한다. 기존 배지를 `Register -Replace`해도 이 fail-closed guard를 낮추지 않는다.
host 범위가 있는 확장은 세 allowlist를 모두 명시해야 한다.

`ON_SPECIFIC_SITES`는 configuration enum만 쓰면 안 된다. Chromium은 runtime-granted
site가 하나도 없으면 상태를 `ON_CLICK`으로 계산한다. manager는 먼저 기존 runtime
grant를 정리한 뒤 registry의 exact `allowed_host_permissions`만 `updateSiteAccess`로
부여하고, 후속 상태에서 host mode와 정규화된 runtime host 집합을 모두 비교한다.
postcondition이 실패하면 핀·옵션·runtime hosts·storage·badge·title 가운데 불일치한
필드의 기대값과 실제값만 구조화해 반환하며 페이지·탭 내용은 수집하지 않는다.

```powershell
pwsh -NoProfile -File "<aicc>\tools\platform\web-automation\Install-AiccChromeExtensionRegistryEditor.ps1" -DryRun
pwsh -NoProfile -File "<aicc>\tools\platform\web-automation\Install-AiccChromeExtensionRegistryEditor.ps1"
pwsh -NoProfile -File "$HOME\.ai-control-center\browser-extensions\Edit-AiccChromeExtensionRegistry.ps1" -Action TrustRoot -SourceRoot "<extension-repo>" -ExpectedGitHead "<40-char-head>" -ExpectedGitRemote "<origin>" -DryRun
```

일반 Chrome의 확장·프로필은 이 레지스트리 범위 밖이며 변경하지 않는다.

## 5. 검증

```bash
pwsh -NoProfile -File "<aicc>/tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1" -ExpectedBrowser chrome -Endpoint http://192.0.2.1:9222 -ExpectedProfileDir "$HOME/.ai-control-center/browser-profiles/chrome/9222/UserData" -AsJson
pwsh -NoProfile -File "<aicc>/tools/platform/test/Test-AiccBrowserPolicy.ps1" -AsJson
```

슬롯별로 리스너 PID, 프로세스, 프로필이 모두 일치해야 한다. 불일치 시 다른
브라우저나 프로필로 대체하지 않고 실패로 처리한다.

## 포함되지 않는 것

- 브라우저 프로필, 쿠키, 로그인 세션, 인증 자료
- 사용자별 `~/.ai-control-center/guidance/coordination.toml` 값.
- Windows DPAPI로 암호화된 가져온 프로필. 보존 자료로만 취급하며 live 경로로
  다시 연결하지 않는다.

## 휴면 Whale 복구

Whale과 CDP Whale 9335는 기본 설치·Dock·포트 registry·브라우저 선택 대상이 아니다.
벤더 앱, 사용자 profile과 지원 소스는 삭제하지 않는다. 다시 필요해지면
[`dormant-whale-recovery.md`](dormant-whale-recovery.md)의 명시적 복구 절차를 따른다.

## 미래 슬롯은 비활성 설정 준비부터

기존 프로필·로그인·포트·런처를 보존한 채 필요한 후보 1개부터 준비한다. 이 단계는
config-only 문서 작성이다. live coordination/registry/count, 홈 배포, Chrome 실행,
프로필 생성·복제와 새 로그인은 수행하지 않는다. 17841과 주식 전용 9336은 현상유지이며
후보·대체 포트로 쓰지 않는다. QA 또는 다른 서비스의 등록 포트도 인증 풀에 합치지 않는다.

### 기존 코드가 지원하는 범위

Manage-CdpChromeSlotLease.ps1은 cdp_slot_count까지의 cdp_slotN_* 키를 읽고
usage의 pending/disabled/reserved를 후보에서 제외한다. exclusive=true의 lease 상한은
1이며 일반 상한은 cdp_targets_per_slot 또는 MaxTargetsPerSlot 계약을 따른다.
lease 상한은 RAM·CPU·프로세스·target 여유를 측정한 값이 아니다.

Windows Start-AiccCdpChromeSlot.ps1은 현재 Port ValidateSet이 9222/9223/9224/9225다.
Windows Install-SeparatedBrowserAppsOnWindows.ps1의 OnlyPorts는 내부 자산 목록의
필터다. 일반 lease parser가 새 index를 읽는다는 사실만으로 새 포트의 런처·확장 관리·배지·
identity bootstrap까지 지원된다고 주장하지 않는다. pending은 lease 제외 조건이고
직접 시작기의 기동 차단과 동일하지 않다. 지원 부족은 별도 승인된 좁은 소스 변경이 필요하다.

### 실행되지 않는 후보 예시

아래는 기존 키를 사용한 주석 전용 계획이다. 새로운 enabled/auto_start 같은 미지원
키를 만들지 않는다. N은 기존 count 다음의 미사용 index, PORT는 충돌 확인 전 후보다.
실제 account/workspace alias는 UI identity 확인 전 비워둔다. count는 이 단계에서 그대로다.

~~~toml
# [browser]의 미래 후보 한 개; live 파일에 합치지 않음
# cdp_slotN_port = PORT
# cdp_slotN_profile_dir = "<승인된 전용 profile 절대 경로>"
# cdp_slotN_profile_directory = "Default"
# cdp_slotN_launcher = "<해당 포트를 지원하는 기존 등록 launcher>"
# cdp_slotN_account_alias = ""
# cdp_slotN_workspace = ""
# cdp_slotN_usage = "disabled_pending_identity_capacity"
# cdp_slotN_exclusive = true
~~~

이 예시는 배포할 TOML이 아니다. placeholder를 실제값으로 확정하기 전에는 예약 완료라고
표현하지 않는다. 기존 전용 profile이 있으면 그대로 보존한다. 없으면 프로필·로그인
생성이 포함된 별도 범위를 확인하며 다른 프로필을 복사하거나 새 로그인을 자동 수행하지 않는다.

### 나중에 활성화할 때 필요한 근거

- 최신 등록과 OS listener를 대조해 중복 port/index/profile/launcher가 없음을 확인한다.
  profile은 non-default 전용 root이고 symlink/junction으로 경계를 넘지 않아야 한다.
- 실제 account/workspace identity와 해당 작업 권한을 별도로 확인한다. port·role 문자열,
  과거 계정표와 UI 요금제는 증거가 아니다.
- 변경 대상 슬롯과 영향받는 구성요소의 active lease/target/client/turn 및 unknown 수가
  모두 0임을 확인한다. 손상·만료 불명·반환 실패 lease는 빈 슬롯으로 취급하지 않는다.
  일반 1회 Chat의 CDP 준비에 무관한 17841 HTTP counter를 적용하지 않는다.
- 현재 RAM 여유, CPU 부하, Chrome 프로세스와 열린 target 수, 예상 증가와 여유 한도를
  작업 시점에 확인한다. 측정하지 않았으면 capacity UNKNOWN이며 활성화하지 않는다.
  메모리 여유만으로 idle을 판정하거나 target 상한을 임의 확대하지 않는다.
- 실제 런처·확장 manager·배지·identity/lease 지원이 갖춰진 exact 대상의 preview,
  1회 확인, 단독 writer, preimage·rollback을 준비한다. 기존 live 슬롯이나 주식 9336은
  건드리지 않는다. 승인된 기동도 하나씩 하며 브라우저·로그인을 늘리는 것 자체를 목표로 삼지 않는다.

현재 Sol·Astra 정책에서는 이 문서·지침 수정 후 자동검증·테스트·빌드·린트·실행 확인·
브라우저 확인·검증 목적 소스 재읽기와 위임 검증을 하지 않는다. 위 단계와 기존 문서의
검증 명령은 사용자 명시 검증의 범위·시점에만 실행한다. 43개 실제 사용점검을 최후로
미룬 작업에서는 먼저 작성만 끝내고, 홈 복사·live 적용·실제 작동을 각각 미실행으로 보고한다.

## 기존 원 target의 정식 읽기 인수 source — 2026-10-23 KST

기존 사용자 탭을 선택하지 않는 원칙은 유지한다.
canonical Manage-CdpChromeSlotLease.ps1의 별도 ReadExisting은 broker가 직접 만든
동일 원 owner의 task target에 한하여 공식 생성·KeepTarget 반환 이력과 원 receipt bytes SHA256/
prompt/실제 신원·등록 slot을 대조한 exclusive 읽기 lease다.
계약·미래 Acquire -RecordReadHistory 및 원 Release의 receipt 결속 인자는
[broker 현재 계약](../../tools/platform/web-automation/README.md#미래-원요청을-결속하는-순서)을 따른다.
기본 Acquire의 신원 미증명 이력, 과거 stdout·mtime·현재 탭만으로는 인수할 수 없다.
공식 과거 이력이 없으면 HOLD_HISTORY_UNPROVEN이며 backfill하지 않는다.

읽기 target은 반환·만료 회수에서도 닫지 않는다. 다른/미반환/손상 lease와 고아 history는
강탈·초기화하지 않고 HOLD한다. token/응답 본문은 history에 복제하지 않는다.
이번은 source만 작성·검증 미실행·설치/실lease/실target 읽기0이다.
PRIVATE 미래 원 caller의 opt-in/receipt 결속 연결과 설치판 인수는 메인/기존 owner의 다음 범위다.
현재 설치된 도구의 기존 미지원 HOLD를 이 소스만으로 해제하지 않는다.

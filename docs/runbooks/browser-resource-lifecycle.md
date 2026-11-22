# macOS 브라우저 리소스 수명주기

> **운영체제 구분 (2026-11-10):** 이 문서의 기존 Dock, Swift launcher,
`NSRunningApplication.terminate()`, `SIGTERM`, `lsof`, LaunchServices와 macOS CDP
종료 조건은 **macOS 전용**이다. Windows에서 그대로 실행하거나 창 닫기를
브라우저 전체 종료로 간주하지 않는다. Windows 등록 CDP 슬롯의 별도 계약과
현재 지원 한계는 문서 마지막 [Windows 등록 CDP 절](#windows-등록-cdp-슬롯의-필요시-기동과-안전-반환-2026-11-10)을 따른다.


이 문서는 AICC CDP 경량 런처가 시작한 Chrome의 마지막 창 종료, Dock 표시,
CDP 작업 보존 정책을 설명한다. Whale 계열은 이 Mac의 활성 표면이 아니며
[`dormant-whale-recovery.md`](dormant-whale-recovery.md)에만 복구 절차를 보존한다.
소스 변경과 설치된 런처는 별개다. 이 정책은 해당
Swift 런처를 다시 빌드·설치한 뒤 시작되는 새 vendor 브라우저 프로세스부터 적용된다.

## Dock 아이콘과 실행 상태

- **고정 아이콘**은 Dock의 바로가기 항목이다. 아이콘만 남아 있는 상태는 프로세스나
  RAM을 사용하지 않는다.
- **실행 점**은 그 Dock 앱 identity의 프로세스가 실행 중이라는 표시다. CDP AICC 타일의
  점은 경량 controller가 살아 있다는 뜻이고, Chrome 창은 vendor 앱 identity로
  별도 그룹화될 수도 있다.
- controller는 exact vendor PID/profile/port를 감시하기 위해 vendor 브라우저와 함께
  살아 있다. vendor 프로세스가 종료되면 controller도 종료하므로 실행 점이 사라진다.
- 고정 아이콘은 두 프로세스가 모두 끝난 뒤에도 남는 것이 정상이다. 아이콘 존재만으로
  잔류 프로세스를 판정하지 않는다.

## 창 닫기와 앱 종료

macOS에서 마지막 창의 닫기 버튼이나 `Command-W`는 앱 `Quit`과 다르다. Chromium은
background app 모드 외에도 macOS `AppController` keep-alive를 가져 창이 0개여도 vendor
프로세스를 유지한다. Chromium의 `--disable-background-mode`는 background app이 Chrome을
붙잡는 경로를 끄지만 macOS AppController 자체를 해제하지는 않는다.

AICC 런처는 두 동작을 결합한다.

1. 모든 launcher-started Chrome에 `--disable-background-mode`를 전달한다.
2. 런처가 이번 실행에서 직접 시작한 exact PID에만 마지막 창/페이지 종료 정책을 적용한다.

이미 실행 중이던 같은 프로필에 controller가 붙은 경우에는 그 PID의 수명을 소유하지
않는다. CPU, RAM, 키보드 입력 부재, 일정 idle 시간만으로 종료하지 않으며 자동 idle
정책은 `SIGTERM`이나 `SIGKILL`을 보내지 않는다. 조건이 충족되면 macOS의 정상
`NSRunningApplication.terminate()`만 한 번 요청한다.

CDP Chrome controller의 Dock `Quit`은 이 controller가 현재 실행에서 직접 시작한 exact
PID만 함께 정상 종료한다. 이미 실행 중인 같은 프로필에 나중에 붙은 controller는 브라우저
수명을 인수하지 않으므로 controller만 끝낸다. active lease나 `ESTABLISHED` CDP client가
있거나 상태가 UNKNOWN이면 Quit을 취소하고 브라우저를 보존한다. 정상 종료 요청이 응답하지
않으면 같은 identity를 다시 확인한 뒤 bounded `SIGTERM`까지만 허용하고 `SIGKILL`은 사용하지
않는다. 창 닫기를 앱 `Quit`이나 강제 종료와 혼동하지 않는다.

## Idle 판정

### 등록 CDP Chrome

CDP controller는 다음 조건이 세 번의 1.5초 monitor tick 동안 모두 유지될 때만 정상 종료를
요청한다.

- 이 controller가 시작한 exact PID다.
- 시작 뒤 적어도 한 개의 `page` target을 실제로 관찰했다.
- 현재 `page` target이 0개다. 숨김·최소화 창이나 background task target은 여전히 page
  target이므로 종료 조건이 아니다.
- `~/.ai-control-center/browser/cdp-target-leases/<port>.leases`에 만료되지 않은 active
  lease가 없다. `AICC_CDP_LEASE_ROOT` override도 그대로 따른다.
- 해당 PID와 CDP port 사이에 `ESTABLISHED` client 연결이 없다.

lease 파일을 읽거나 JSON/만료 시간을 해석하지 못하거나 CDP client 상태를 확인할 수 없으면
idle로 추측하지 않고 browser를 보존한다. active lease가 있는데 target이 일시적으로 없어진
경우도 보존한다. lease가 release되고 client와 page target이 모두 없어진 뒤에만 종료된다.

## 프로필·포트별 정책

| 표면 | identity/용도 | 마지막 창 뒤 정책 |
| --- | --- | --- |
| 일반 Chrome | 벤더 Google Chrome, 일반 user-data root, CDP 없음 | 사용자와 벤더 Chrome이 직접 소유 |
| CDP Chrome 9222 | 등록 authenticated shared slot | page 0 + active lease 0 + CDP client 0일 때만 정상 종료 |
| CDP Chrome 9223 | 두 번째 등록 authenticated shared slot | 9222와 동일하며 profile/port identity를 서로 대체하지 않음 |
| CDP Chrome 9224 | 선택 등록 slot | 9222와 동일하며 pending/disabled 상태를 자동 우회하지 않음 |
| CDP Chrome 9225 | 2026-09-24부터 다중 사이트 자동화용; profile 계정/workspace 신원은 미확인 | 신원 확인 전 lease broker에서 제외; 확인 후 task-owned target lease 사용 |

모든 활성 표면은 기존 user-data root, profile directory, CDP port, bundle ID와 start 인자를
그대로 사용한다. Whale vendor 앱과 9335 profile은 삭제하지 않지만 활성 런처·포트 registry·
브라우저 선택에서는 제외한다.

## 재발 방지 계약

다음 두 증상은 별개로 보이지만 macOS의 브라우저 process identity와 launcher ownership이
어긋났을 때 함께 나타날 수 있다.

| 증상 | 먼저 확인할 근거 | 대표 원인 | 금지되는 우회 |
| --- | --- | --- | --- |
| 일반 링크 무반응 | HTTP/HTTPS handler, 일반 Chrome PID/인자, headless PID/인자 | 종료되지 않은 stale headless Chrome이 vendor identity로 링크를 수신 | 기본 브라우저를 wrapper로 변경, 모든 Chrome 일괄 종료 |
| CDP 타일을 Quit해도 Chrome 잔류 | controller PID, listener PID, user-data root, port, lease/client | 구형 controller가 자신만 종료했거나 새 controller가 기존 browser에 attach해 ownership이 없음 | 다른 포트/프로필로 대체, live listener 위에 launcher 재설치 |
| 같은 포트가 꼬이거나 다른 계정이 열림 | private coordination과 listener 전체 인자 | port/profile/account tuple 불일치 | 열린 탭이나 최근 사용 계정만 보고 identity 추측 |

다음 불변조건을 설치·운영·장애 복구에서 모두 지킨다.

1. 일반 HTTP/HTTPS handler는 private coordination의 `default_browser_bundle_id`와 일치하고,
   이 Mac에서는 vendor `com.google.Chrome`이다.
2. 등록 CDP slot identity는 executable + user-data root + profile directory + port의 전체
   tuple이다. 포트나 앱 이름 하나만으로 판단하지 않는다.
3. controller는 현재 launcher lifetime에 자신이 시작한 exact browser PID만 종료한다.
4. active lease, `ESTABLISHED` client, 읽을 수 없는 상태는 모두 browser 보존 조건이다.
5. live listener가 남은 상태에서는 launcher bundle을 교체하지 않는다. 그렇지 않으면 새
   controller가 기존 PID에 attach하여 종료 ownership을 갖지 못한다.
6. screenshot/headless 작업은 task-owned isolated QA 수명주기를 사용하고 완료 시 정리한다.
   일반 vendor Chrome identity를 임시 headless worker로 남겨 두지 않는다.
7. `SIGKILL`, profile 삭제·복사, 계정/포트 교환, 모든 Chrome 일괄 종료로 증상을 숨기지 않는다.

## 장애 진단과 표준 유지보수 절차

아래 순서는 등록 slot 하나를 대상으로 수행한다. `<port>`, `<profile-dir>`, `<bundle-id>`,
`<launcher.app>`은 반드시 `~/.ai-control-center/guidance/coordination.toml`에서 해석한다.
개인 계정 별칭이나 절대 profile 경로를 공개 보고서에 복사하지 않는다.

### 1. 변경 전 증거와 복구점

```bash
pwsh -NoProfile -File tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1 \
  -Action Status -AsJson
lsof -nP -iTCP:<port> -sTCP:LISTEN
lsof -nP -a -iTCP:<port> -sTCP:ESTABLISHED
ps -axo pid=,ppid=,comm=,args= | rg -- '--remote-debugging-port=<port>|CDP Chrome <port>\\.app'
```

- listener PID의 executable, `--user-data-dir`, `--profile-directory`,
  `--remote-debugging-port`가 private coordination과 모두 일치해야 한다.
- active lease/client가 있으면 기본 동작은 HOLD다. 사용자가 그 작업 중단을 명시 승인한
  경우에만 owning workflow로 lease/target을 release하고 정확한 client session을 종료한다.
- installer가 만드는 timestamped `.app.backup` 복구 사본을 보존한다. recovery bundle의
  leaf는 `.app`으로 끝나면 안 된다.

### 2. 정확한 slot 종료와 교체

정상 controller Quit을 먼저 요청한다. 구형 controller가 자신만 끝내고 browser를 남기면,
listener PID를 다시 해석하고 lease/client 0과 전체 identity tuple을 재검증한 뒤 그 exact
browser PID에만 bounded `SIGTERM`을 허용한다. `SIGKILL` fallback은 없다.

controller와 listener가 모두 사라진 것을 확인한 뒤에만 교체한다.

```bash
pwsh -NoProfile -File tools/platform/web-automation/Install-SeparatedBrowserAppsOnMac.ps1 \
  -OnlyPorts <port> -SlotOnly -Replace
/usr/bin/open -gj --env AICC_BACKGROUND_LAUNCH=1 '<launcher.app>'
```

installer가 live listener 때문에 거부하면 그 보호 장치를 우회하지 않는다. 원래 listener의
소유권을 먼저 해결한다.

### 3. 재실행 identity와 실제 종료 검증

```bash
pwsh -NoProfile -File tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1 \
  -ExpectedBrowser chrome -Endpoint http://192.0.2.1:<port> \
  -ExpectedProfileDir '<profile-dir>' -AsJson
codesign --verify --deep --strict '<launcher.app>'
```

유휴 slot에서는 한 번의 실제 Quit smoke를 수행한다. controller PID와 browser PID가 모두
사라지고 listener가 해제되는 것을 확인한 뒤 같은 launcher를 다시 열고 identity guard를
한 번 더 통과시킨다. UI의 실행 점만으로 PASS하지 않는다.

### 4. 일반 링크와 중복 등록 post-check

- HTTP와 HTTPS가 모두 coordination SSOT의 vendor bundle을 가리키는지 확인한다.
- Spotlight와 LaunchServices에서 각 active AICC bundle의 canonical path가 정확히 하나만
  등록됐는지 확인한다. `.app.backup`은 검색 결과나 앱 선택기에 나타나면 안 된다.
- vendor Chrome의 stale headless process가 없는지 확인하되, 일반 Chrome이나 다른 CDP
  slot은 종료하지 않는다.
- `python3 tools/platform/inspect/local_port_inventory.py --write`로 private post-state를 남기고,
  CDP 외 충돌은 별도 owner 문제로 명시한다.
- Swift typecheck, `Test-AiccBrowserPolicy.ps1`, 필요 시 `npm run verify:mac`을 통과시킨다.

## 빠른 증상별 복구

### 일반 링크 무반응

1. HTTP/HTTPS handler가 vendor Chrome인지 확인한다.
2. 일반 Chrome과 headless Chrome의 full command를 분리한다.
3. task owner와 수명주기가 확인된 stale headless PID만 정상 종료한다.
4. 일반 Chrome process와 profile이 그대로인지 확인하고 테스트 링크를 한 번 연다.
5. headless 작업의 종료 누락 원인을 isolated QA workflow에서 수정한다.

### CDP Quit 뒤 Chrome 잔류

1. launcher binary가 owner-scoped Quit 정책을 포함하는지 확인한다.
2. controller가 그 browser PID를 이번 lifetime에 시작했는지 확인한다.
3. active lease/client가 있으면 정상적인 종료 차단이므로 먼저 작업을 release한다.
4. 구형 bundle이면 위 표준 유지보수 절차로 exact slot만 교체한다.
5. 실제 Quit smoke와 재실행 identity guard를 모두 통과해야 완료다.

## 재실행과 복구

1. 실행 점이 없고 고정 아이콘만 있으면 해당 AICC 아이콘을 한 번 클릭한다.
2. controller는 설치된 plist/environment의 exact profile과 port만 시작한다. 다른 정상
   브라우저, 다른 계정, 다른 CDP port로 fallback하지 않는다.
3. CDP 작업은 새 task-owned target lease를 얻은 뒤 시작한다. 기존 사용자 탭을 재사용하거나
   최근 탭 순서로 추측하지 않는다.
4. 시작 실패나 identity 충돌이면 listener PID, executable, user-data root, profile directory,
   port를 함께 대조하고 중지한다. 프로필 삭제나 임의 process kill로 숨기지 않는다.

읽기 전용 점검 예시는 다음과 같다.

```bash
pwsh -NoProfile -File tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1 -Action Status -AsJson
lsof -nP -iTCP:9222 -iTCP:9223 -iTCP:9224 -iTCP:9225 -sTCP:LISTEN
```

## 설치 전 조건과 rollback

이 소스 변경만으로 설치된 앱은 바뀌지 않는다. live 설치는 별도 유지보수 작업에서 다음을
모두 만족한 뒤 launcher bundle만 대상으로 수행한다.

- 대상 CDP port의 active lease/turn과 `ESTABLISHED` client가 0임을 현재 시점에 확인
- 대상 launcher controller와 CDP listener가 모두 종료된 뒤에만 bundle을 교체
- exact launcher bundle과 plist의 복구 사본
- 영향받는 Swift source compile, `Test-AiccBrowserPolicy.ps1`, identity/default-browser 검증 PASS
- HTTP/HTTPS handler가 private coordination의 `default_browser_bundle_id`와 계속 일치하는지 전후 확인

rollback은 profile이나 vendor 앱을 바꾸지 않는다. 설치 전 launcher bundle을 복구하고
LaunchServices에 exact canonical path만 다시 등록한 뒤 bundle/profile/port/default handler를
재검증한다. 소스 rollback은 네 launcher의 resource-lifecycle block과
`--disable-background-mode` 인자를 함께 되돌린 뒤 다시 컴파일한다.

## 근거

- Chromium은 macOS AppController가 창이 없어도 process를 유지하도록 별도 keep-alive를
  만든다고 설명한다: <https://chromium.googlesource.com/chromium/src/+/master/chrome/browser/app_controller_mac.mm>
- Chromium의 background-mode switch는 background app이 Chrome을 계속 실행하는 경로를
  비활성화한다: <https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_switches.cc>
- Apple Window List API의 `optionAll`과 `optionOnScreenOnly`는 서로 다른 명시적 범위다:
  <https://developer.apple.com/documentation/coregraphics/window-list-option-constants>

## 조회·슬롯 확보의 자동 실행 금지

`Manage-CdpChromeSlotLease.ps1 -Action Acquire`는 기존 등록 Chrome에만 연결하는 것이 기본이다. 오프라인이면 종료하며 다른 프로필이나 창으로 fallback하지 않는다. 실제 브라우저 실행을 요청한 작업에서만 별도 명시적 launch를 사용한다. 저수준 helper의 `-AllowBrowserStart`는 명시적 기동 전용이며 `-NoStart`가 함께 있으면 기동할 수 없다. private managed acquisition은 항상 `-NoStart`를 전달하고 `-AllowBrowserStart`를 거절한다. 계정 신원은 포트가 아니라 실제 session/workspace로 확인한다. 브라우저가 연결되지 않았다는 이유로 사용자 프로필을 복제하거나 메인 Chrome을 재시작하지 않는다.

---

## Windows 등록 CDP 슬롯의 필요시 기동과 안전 반환 (2026-11-10)

이 절만 Windows의 등록 Chrome/CDP 소유권에 적용한다. 위 Dock/Swift/macOS
NSRunningApplication·SIGTERM·.app bundle 종료·설치 절차는 Windows에 적용하지 않는다.
포트는 등록 슬롯 선택 키이지 계정 증명이 아니다. 프로필·Chrome·인증 상태를 바꾸지 않는다.

### 기존 기능과 명확한 한계

| 구분 | 현재 소스에 있는 기능 | 범위와 남은 한계 |
| --- | --- | --- |
| Start-AiccCdpChromeSlot.ps1 | 등록 슬롯/profile 검증, Status/Ensure -DryRun -NoStart/Ensure -NoStart; 별도 승인한 차가운 기동에서만 NoStart 생략 뒤 identity 재검증 | OS Chrome 유휴 Quit 관리자가 아님; owner-local 런처 설치 SHA는 별도 확인 |
| Start-CdpChromeSlot.ps1 | 등록 Chrome user-data root와 listener 사용; URL을 생략하면 about:blank#aicc-webgpt-standby 대기 창 기동 | 대기 창도 page target. 작업 target 반환은 전체 page 0의 증거가 아님 |
| Manage-CdpChromeSlotLease.ps1 | exact 등록 account/workspace/slot, Target.createTarget, 독립 lease/heartbeat/원 token Release | AllowBrowserStart 기본 꺼짐. offline/신원 불일치면 HOLD, 무단 다른 포트/계정 fallback 없음 |
| CdpLeaseProvider 및 host-control/cdp-browser.mjs | task-created target ID와 원 lease를 검증하고 Release 확인 뒤 Playwright disconnect | 현재 Host acquire는 AllowBrowserStart를 전달하지 않음. browser.close는 OS Chrome Quit 아님 |
| host-control/server.mjs | CDP 기본, Aside 명시적 보조 attach, 원 session 600초 idle close와 UNKNOWN fence | 600초는 Host session의 유휴 판정, Windows 전체 browser process의 유휴·Quit이 아님 |

**마지막 소유 작업 탭 반환:** Manage-CdpChromeSlotLease.ps1 -Action Release는
원 lease token의 정확한 target ID만 닫고 안정적 부재를 관측한 뒤 lease를 지운다.
실패 시 release_pending_cleanup/cleanup_failed 등 원 기록을 보존하며,
unknown, provisioning, releasing, reclaiming, cleanup_failed는 만료만으로
유휴로 승격하지 않는다. KeepTarget은 의도적 탭 보존이다.
ReadExisting/CloseCompleted는 원 작업·원 owner·완료 증거가 있어야
특정 탭에만 쓸 수 있고, 일반 Chrome 마지막 창 Quit 명령이 아니다.

### Windows Chrome 전체 종료를 아직 지원한다고 말할 수 없는 이유

Windows 등록 launcher와 lease helper는 browser_started_by_lease 여부를 기록하지만
**현재 실행에서 직접 소유한 정확한 Chrome PID+생성시각과 OS 정상 종료 권한**의
검증 영수증을 제공하지 않는다. 마지막 작업 탭/lease 반환 → 전체 page/client 0 확인 →
해당 PID만 정상 Quit→exit ACK까지 연결하는 **지원 계약도 확인되지 않았다**.
CDP browser.close는 Playwright client 연결을 끊을 뿐 OS Chrome을 종료하지 않는다.
또한 base launcher의 standby page가 남을 가능성이 있다. 이것이 실제 상주의
원인인지는 현재 프로세스/target·lease를 같은 시점에 측정하지 않아 **미입증**이다.

후속 운영자가 Windows Chrome 전체 종료를 검토할 최소 조건:

1. 자신이 직접 시작한 **단일** Chrome의 exact PID·생성시각·executable·
   user-data root·profile·listener 등록 tuple/소유권 확인
2. 원 owner의 활성 명령·target lease 0, 오래된 UNKNOWN/cleanup_failed/
   read-existing/KeepTarget 및 과거 원 Host 미반환의 정확한 조정
3. 대기·숨김·다른 GPT·사용자 창 포함 **모든 page target 0**과
   CDP client/ESTABLISHED 연결 0, 불명 소유자·미반환 자원 0
4. 이 Chrome 하나만의 공식 정상 종료/exit ACK와 설치된 재기동·복구 경로

어느 하나라도 미입증이면 **HOLD**한다. 600초 Host idle, CPU/RAM 낮음,
lease count 0이나 프로세스 이름만으로 전체 Chrome을 종료할 수 없다.
사용자/다른 계정 Chrome·기존 서비스·터널 강제종료나 daemon/예약은 금지한다.

### Source / 설치 / 실제 운영 근거 구분

- **설치(중앙 인수 완료):** 정식 Host 후보 Prepare→독립 READY→3 provider
  active/unknown 0 consumed drain→Apply→설치 SHA/runtime ready와 실제 remote
  capabilities/workspace_list PASS. CDP 기본·Aside 보조 및 등록 신원 목록을 확인했다.
- **코드/기존 가짜 근거:** Aside는 승인된 명시적 요청에서만 attach한다.
  remote capabilities 성공만으로 현재 Aside 자식의 생성·exit, 원 Chrome 소유
  PID, 임대/유휴·물리 RAM 감소를 실제 입증한 것은 아니다.
- **남은 원 증거:** ce9a 자동재개 QUEUE_ACCEPTED,
  yt_project_inspect_20261108_01의 HOST_HISTORY_UNPROVEN, G3 66da UNKNOWN
  및 활성/불명 임대는 그대로 보존한다. Host·Workspace·OCX 수신부,
  Windows registered launcher, Aside 실행기, CDP target broker는 각각 독립 소유 경계다.
- **다음 담당:** 중앙의 정확 원 등록 owner가 설치 런처 SHA, OS PID·target·lease·client
  동시 관측과 실제 정상 exit 지원 여부를 확인. 동조건 RAM/지연 전후 비교는 미실행.
  서버 이전은 PRODUCT의 기존 비교만 재사용하며 가격 조사·배포 0.

읽기 전용의 등록 Status 액션(Start-AiccCdpChromeSlot.ps1 및
Manage-CdpChromeSlotLease.ps1)을 사용하되, owner/프로필/endpoint 등
개인 정보는 공개 결과에 복사하지 않는다. Status만으로 OS Quit 권한이 생기지 않는다.

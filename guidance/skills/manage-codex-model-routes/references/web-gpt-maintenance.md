# Web GPT 17841 유지보수

> 플랫폼 경계: 아래 launchd/plist transaction은 macOS 전용이다. Windows에서 이를 번역해
> 추측 실행하지 말고 read-only route/listener 상태만 수집한 뒤, 검증된 Windows service-owner
> installer와 rollback runbook이 없으면 `HOLD`한다.

## Windows runtime

Windows 지원 private adapter에서는 `scripts/install-runtime.ps1`와 `runtime doctor` 계약을 사용한다.
실제 설치 전에 같은 bundle의 별도 폴더 통합시험(설치·중복 거부·시작·정지·정확한 rollback)을 통과시킨다.
설치된 config의 `runtimeCommand`는 영구 버전 폴더의 native `.exe`와 분리된 argv여야 한다.
임시 build 경로, `.cmd`, macOS wrapper, 독립 17842 rescue를 main 17841 명령으로 대체하지 않는다.

- `runtime install --bundle <verified-bundle>`은 exact target 부재 증명 후 설정·명령을 설치하며 로그인이나
  Native/OCX route를 바꾸지 않는다. 기존 사용자 설정과 복구본을 보존한다.
- `runtime start` 뒤 동일 PID·version·health·owner marker를 확인한다. 브라우저 일시정지는 별도 경계다.
- `runtime stop`은 exact owner와 세 active counter 모두 0, atomic drain 확인 뒤 정상 종료한다.
- `runtime rollback`은 정지와 설정 hash가 맞을 때만 직전 byte를 복구한다. live/UNKNOWN에는 실행하지 않는다.
- 사용자 지정 계정·workspace는 private coordination에서 읽고 실제 로그인·권한을 별도로 확인한다.
  Pro 만료 예정 이후 실제 권한을 재검증하며 블로그 등 예약 slot으로 우회하지 않는다.

## Bridge transaction

1. source·candidate·설치 version, config/plist hash, 단일 launchd owner와 rollback을 고정한다.
2. `active_http_turns`, `active_browser_http_turns`, `active_browser_turns`가 모두 정확히 0일 때만
   인증된 drain을 호출한다. drain 응답도 0/0/0과 `accepting_turns=false`여야 한다.
3. 17841 app/service만 교체한다. Desktop, OCX, 다른 browser/task를 종료하지 않는다.
4. 최종 app 경로의 CLI로 설치한다. staging 경로를 launchd `ProgramArguments`에 남기지 않는다.
5. 새 version, accepting state, single owner, `runs=1`, MCP child, OCX/Native/17842 생존을 확인한다.
6. 실패하면 같은 transaction에서 이전 app/config/plist를 한 번 복구하고 `HOLD`한다.

GUI 앱이 descriptor를 소유하면 구 launcher가 살아 있는 동안 최종 경로 설치를 먼저 끝낸다. 이후
앱을 정상 종료·재실행해 descriptor hash와 MCP child를 검증한다. 종료가 거부되면 반복·강제 종료하지
않는다. restart budget은 maintenance window당 두 번이다.

## 모델·컴팩션·harness

- Web 모델은 temporary/saved와 reasoning 수준을 하나의 slug에 고정한다. Pro는 실제 권한과
  account identity가 검증된 경우에만 노출한다.
- compact 변환은 한 번만 수행하고 compaction item과 completion을 모두 확인한다. 중간 종료나
  결정적 4xx를 자동 재시도하지 않는다.
- install journal은 사용자 원래 값을 byte-for-byte 복원할 수 있어야 한다.
- source test는 배포 증거가 아니다. 현재 bundle의 route, compact, six-mode, harness canary를
  각각 검증한다.
- harness app은 exact app/version/workspace와 typed tool schema를 비교한다. 교체와 rollback이
  입증된 뒤에만 old/duplicate app을 제거한다.
- AICC Workspace app 게시와 model route는 다른 failure domain이다. 하나를 고칠 때 다른 하나를
  바꾸지 않는다.

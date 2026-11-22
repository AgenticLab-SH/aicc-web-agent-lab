# OCX 10100 유지보수

## Windows

현재 구조는 `context/PROJECT.md`와 `runtime/ocx-local/current.json`을 따른다.
로컬 등록이 있으면 Windows OCX가 사용자 요청을 처리하고 A1은 자격 증명의 단일 갱신
주체다.10100/10101의 data Bearer와 관리자 token은 별개다.17841은 OCX outbound에만
data Bearer를 적용하며 공식 Native에는 기존 인증을 유지한다.

기존 `Invoke-AiccLocalOcx.ps1`의 Status/Recover/Upgrade/RollbackUpgrade를 사용한다.
업그레이드는 immutable 후보·기존 설치 해시·AICC 독립 복구의 fresh 상태·17841 인증
전달 계약·전체 HTTP/browser/OCX 유휴 상태와 maintenance lock을 요구한다. 준비 상태가
UNKNOWN이면 현재 소유자를 보존한다. 기존 `aicc-ocx-update`의 stock 두 대상 갱신으로
로컬 fork를 덮어쓰지 않는다. 계정·사용자 설정·history를 software rollback으로 복원하지
않는다. 활성 제어 대화가 이 경로를 쓰고 있으면 배포와 재시작을 연기한다.

Upgrade는 변경 전 실행기·서비스 등록·로컬 등록·서비스 등록 사본과 예상 변경 해시를
하나의 소프트웨어 복구 기록에 보관한다. 실패 시 원복은 한 번만 시도하고, 미확인 실행
주체·활성 요청·다른 작성자의 변경이 있으면 중단한다. `RollbackUpgrade`는 등록된
`upgradeBackup` 또는 명시한 `-UpgradeBackup` 기록만 사용한다. 기존 `Rollback`은 최초
로컬 전환의 Native/터널 구조를 되돌리는 별도 기능이므로 소프트웨어 업데이트 원복에
사용하지 않는다. 이미 같은 후보가 실행 중이면 Upgrade는 재시작 없이 반환한다.

Workspace/gateway를 OCX 유지보수와 동시에 변경하지 않는다. 이를 모델 인증이나 OCX
health에 종속시키지 않는다. 다른 모델로 실패 요청을 자동 재전송하지 않는다.

## macOS의 기존 유지보수

> 플랫폼 경계: 아래 LaunchAgent 절차는 macOS 전용이다. Windows에서는 route가 사용자 요청으로
> 켜져 있는지 먼저 확인하고, 정확한 Windows service owner·설치 receipt·rollback이 없으면
> 시작·중지·복구하지 않고 `HOLD`한다.

정상 background owner는 AICC가 관리하는 exact LaunchAgent와 별도 owner-only service home이다.
인증·provider state는 기존 OCX home에 두며 복사하거나 재인증하지 않는다.

1. 10100 health, listener/service PID, launchd label·plist·ProgramArguments와 Codex config/catalog
   fingerprint를 고정한다.
2. 같은 service PID의 active request가 5회 연속 0인지 확인한다. read 실패는 `UNKNOWN`이다.
3. 유지보수 worker는 대상 route 밖의 Native one-shot이며 `KeepAlive=false`다.
4. 일반 `ocx stop`으로 사용자 route/config를 복원시키지 않는다. exact service owner만 graceful
   drain/unload하고 PID 종료를 bounded wait한다.
5. stale runtime record, unmanaged listener, ProgramArguments/PID 불일치는 fail closed한다.
6. 새 owner의 ready, `runs=1`, PID 일치, config/catalog fingerprint 불변, 17841·17842·Native
   생존을 확인한다.
7. 실패하면 이전 service를 한 번만 복구하고 `HOLD`한다. terminal worker는 PASS/HOLD 뒤 끝낸다.

## 사용자 승인된 제한 Daybreak 인계

일반 작업의 기본은 OCX gpt-6.1-sol/high다. 사용자가 Daybreak 병행을 선택한 경우 실제 막힌 세부 항목만 Native 현재 로그인 계정 gpt-6-sol/high/daybreak_blue에 잠시 맡기고 결과 후 OCX로 반환한다. 전체 그룹/일반 구현을 Native에 넘기지 않는다. quota reset 후 fresh 동일계정 근거, credits와5시간 한도 구분, 한 writer·불명 재전송 금지는 [관제의 세부 인계 계약](../../control-project-work/references/ocx-daybreak-handoff.md)을 따른다. 이 명시 사용자 예외는 원 보안 거절·승인 실패·권한 경계를 우회하는 허가가 아니다.


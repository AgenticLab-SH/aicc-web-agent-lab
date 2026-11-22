# OCX upstream-only 및 저장소 운영 경계

OCX는 AICC의 통합 route owner가 아니라 독립 upstream이다. 정상 topology는 다음과 같다.

```text
Codex integrated profile -> 17841 -> non-Web request -> OCX 10100
OCX direct rescue profile ---------------------------> OCX 10100
Native direct rescue profile ------------------------> official Codex endpoint
```

`routingInjected=false`, 10100 liveness·readiness와 Responses endpoint가 준비된 상태는 실패가 아니라
`upstream-only ready`다. AICC의 `ocx.start`는 이미 설치된 서비스에 `service start`만
요청한다. `ocx.sync`는 이름의 하위 호환성을 유지하지만 실제 동작은 health, provider,
model catalog의 읽기 전용 재확인이다. 두 작업은 전후 Codex config SHA-256이 같아야
성공한다. AICC는 이 경로에서 `ocx sync`, `ocx restore`, account/provider 전환, 17841,
Web GPT 또는 Native Codex 재시작을 호출하지 않는다.

`/healthz`는 listener liveness이고 `/readyz`는 post-startup sync가 끝난 readiness다. AICC
wrapper와 installer는 둘의 exact service/port/PID를 모두 runtime service PID와 대조한다.
health 200을 `readinessSeen=true`로 기록하지 않는다. upstream-only owner는 OCX 설정에
`clientIntegrations.codex=false`를 명시해 OCX가 격리된 CODEX_HOME에 native route/catalog
동기화를 시도하지 않게 해야 한다. 이 intent가 없으면 wrapper와 installer는 fail closed한다.

계정 사용량 기반 전환은 AICC가 아니라 OCX가 소유한다. `autoSwitchThreshold=0`은 꺼짐이고,
1~100은 선제 전환 임계값이다. AICC status는 자체 account switch가 false라는 사실과 OCX의
실제 enabled/threshold를 별도 필드로 표시한다.

`ocx.stop`은 active turn 수가 정확히 0일 때만 10100 서비스에 전달된다. 수가 UNKNOWN이거나
1 이상이면 fail-closed 한다. 업데이트·서비스 설치·route 전환은 별도의 maintenance
lease와 rollback이 필요한 작업이며 이 시작/상태/catalog 동작에 포함되지 않는다.

## macOS background service와 격리

사용자가 실행한 `ocx start`는 foreground 실행이라 터미널 프로세스가 끝나면 10100도 종료될 수
있다. 정상 상시 경로는 `com.opencodex.proxy` LaunchAgent 한 개다. 이 owner는 로그인 시 한 번
시작하되 `KeepAlive=false`이고, AICC runtime 아래의 별도 owner-only `CODEX_HOME`을 OCX child에
전달한다. 기존 Codex home은 입력 fingerprint와 catalog source로만 읽으며 OCX child의 시작·종료
side effect 대상이 아니다. OCX provider·OAuth·account state는 기존 OCX owner home에 남는다.

설치 또는 owner 교체는 `tools/platform/ocx/cutover-upstream-launch-agent.mjs`의 bounded transaction을
사용한다. 같은 service PID에서 active request 0을 5회 연속 확인하고 exact launchd owner만 graceful
unload한다. `ocx stop`은 route/config restore side effect가 있으므로 이 handoff에서 사용하지 않는다.
installer는 launchd wrapper owner PID, Node launcher PID, 10100 `/healthz`와 `/readyz`가 증명한 Bun service PID를
구분하고 모두 postcondition으로 확인한다. stale state, unmanaged listener, PID/ProgramArguments 불일치,
config 또는 catalog fingerprint 변화는 fail-closed이며 이전 service 복구는 한 번만 수행한다.

성공 조건은 10100 ready, service PID 일치, launchd `runs=1`, `KeepAlive=false`, isolated home, route
fingerprint 불변과 17841·17842·Native direct·Codex Desktop 생존이다. foreground Terminal은 필요하지
않다. maintenance one-shot은 terminal state에서 exact label만 bootout하고 service label은 유지한다.

## Direct rescue

`ocx-direct`는 `http://192.0.2.1:10100/v1`을 명시하는 read-only 기본 profile이다.
identity는 owner-local alias로 명시해야 하며 AICC public source에는 계정 식별자나 인증을
넣지 않는다. 17841 장애가 이 profile이나 Native direct profile을 재시작하거나 변경하지
않고, OCX 장애도 Web GPT와 Native 경로를 변경하지 않는다. cross-route fallback은 새
attempt로만 기록하며 같은 workspace writer를 재사용하지 않는다.

## Windows 원 TUI 빌드 후보 · 2026-11-19

기존 `retained-child-bootstrap/v1` wire protocol은 유지한다. release producer는
선택적 `artifactContract=shipping-cli-appserver/v1`에서 launcher·Node-API addon과
`codex.exe`·`codex-app-server.exe` 네 파일을 불변 후보에 포함한다. 빌드 exit 0,
각 절대 경로·SHA-256·크기 및 CLI/AppServer 0.166.0 버전을 빌드 영수증과 대조하고
영수증 SHA를 후보 identity와 manifest에 결속한다. 기존 두 파일 후보도 유지한다.

`SHIPPING_BUILD_CANDIDATE_ONLY`는 실제 설치·원 TUI 작동·issuer admission을 뜻하지
않는다. 두 후보 모두 accepted/canActivate=false이며 transition은 파일·버전을
확인한 뒤 stop/start 전에 거절한다. JSON flag를 바꿔 활성화하지 않는다.
실제 원 TUI 인수와 지원되는 handoff/복구·idle·미결 정산 후 별도 운영 전환 계약이 필요하다.
근접 검사는 `ocx-shared-launcher-closure.test.ps1`, `ocx-shared-launcher-transition.test.ps1`,
`ocx-release-closure.test.ps1 -WithShippingCaller`다. 개인 빌드·계정 근거는 owner 원장에 둔다.

## 저장소 bucket과 기본 정책

OCX 인증·provider 상태와 Codex 호환 session 저장소는 소유자가 다르다. 인증·provider
상태는 OCX owner home에 남고, session DB·rollout·attachment는 OCX가 선택한 application
Codex home에 남는다. AICC가 둘을 이동하거나 하나의 DB로 합치지 않는다.

| Bucket | 기본 retention / quota | cleanup 및 복구 |
| --- | --- | --- |
| auth/account state | owner-managed, 자동 만료 없음 | AICC cleanup 금지, owner procedure만 허용 |
| active sessions | owner가 archive할 때까지 유지 | archived cleanup 대상이 아님 |
| archived sessions | cleanup 기본 OFF, 5 GiB owner-policy trigger | exact preview digest, active turn 0, backup, integrity, 명시 승인 뒤 quarantine만 허용 |
| logs DB | owner-managed | 단일 SQLite writer와 online backup 뒤 owner checkpoint/vacuum만 허용 |
| state DB | 참조가 있는 동안 무기한 유지 | 직접 삭제 금지, owner transaction만 허용 |
| response spill/cache | runtime memory budget 256 MiB | rebuildable eviction만 허용, pinned continuation은 제외 |
| attachments/artifacts | reference가 있는 동안 유지 | reference-count와 backup 없는 삭제 금지 |
| deletion manifests | rollback 기간 동안 유지 | restore 불가능 또는 만료 전 삭제 금지 |
| other | path별 분류 전 UNKNOWN | aggregate bucket cleanup 금지 |

live dry-run은 candidate의 relative path, physical path, bytes, mtime과 전체 digest가 모두
있고 `candidate.length == count`, candidate byte 합계가 preview bytes와 같아야 한다.
`archived_sessions/` 밖의 target, 경로 traversal, truncated preview, active turn UNKNOWN/nonzero,
backup 또는 SQLite integrity 미검증, quarantine 외 mode, 명시 승인 없음 중 하나라도 있으면
apply는 HOLD다.

실제 cleanup과 restore는 OCX owner API가 수행한다. quarantine manifest와 satellite DB
backup을 먼저 보존하고, rollback은 owner trash restore 뒤 storage scan과 SQLite
`quick_check`로 확인한다. AICC는 raw auth/account state나 live DB를 직접 삭제하거나 vacuum하지
않는다. quota 초과는 보고하고 cleanup을 보류할 수 있지만 10100, 17841 또는 Web GPT를
종료하는 이유가 되지 않는다.

# 네이티브 코덱스 복구

지피티는 ChatGPT Web 일반 Chat, 코덱스는 로컬 Codex CLI·Desktop이다. 지피티 스킬은 지피티에 등록·설치된 작업 절차, 지피티 플러그인은 지피티에서 연결·설치하는 도구·스킬 묶음, 지피티 지침은 사용자 지정 지침과 프로젝트 지침, 지피티 프로젝트는 지피티의 프로젝트 공간, 지피티 대화는 그 안팎의 개별 대화다. 코덱스 스킬은 코덱스가 사용하는 로컬 스킬이다. 코덱스의 일반 작업은 OCX 경로를 사용한다. 네이티브 코덱스는 OCX를 거치지 않는 코덱스이며, OCX·AICC 업그레이드로 OCX 연결이 끊기는 구간의 독립 유지보수·복구에만 사용한다. 작업 범위·독립 복구·복귀 조건을 갖추고, 정비 후 원래 OCX 작업으로 돌아간다. 지피티 자산과 도구 호출은 위 명칭으로 설명하며, 실제 slug·API 키·불변 ID는 유지한다.

- 공식0.165 V2 `native.config.toml`은 `codex -p native`로 선택하는 공유 HOME 독립 정비 profile이다. 기존 `codex-native.config.toml`/rescue는 보존한다. Desktop
  통합 catalog에 가짜 Native 모델을 주입하지 않는다.
- 설치된 Codex의 help/schema와 작은 read-only smoke로 공식 endpoint를 검증한다.
- Native rescue catalog는 Desktop이 다시 쓰는 `models_cache.json`을 직접 정본으로 삼지 않는다.
  owner-only manifest의 검증된 모델과 hash를 사용한다.
- `models_cache.json`은 `etag`와 `fetched_at`을 제외한 payload hash로 비교한다. 시간 필드만 바뀐
  경우를 모델 변경으로 판정하지 않는다.
- CM 계정을 Native direct로 사용할 때는 지원되는 `cm native <account>` 경로만 쓴다. OCX provider,
  Desktop auth·route, session DB를 복사하거나 바꾸지 않고 caller의 model/profile/route override를 거부한다.
- 17841 자체를 유지보수하는 worker는 일반 `codex`가 아니라 명시적 Native profile이어야 하며,
  process socket으로 17841·10100을 사용하지 않음을 확인한다.
- 변경 전 OS에서 직접 실행하는 AICC 명령으로 Native rescue와 독립 Web GPT rescue 17842를 확인한다.
  Windows에서는 `aicc native-rescue status --json`과 `aicc web-gpt rescue status --json`을 쓰고,
  설치되지 않았거나 active-turn read가 실패한 대상은 `UNKNOWN`으로 취급한다. 두 rescue는 서로
  다른 home·port·runtime identity·로그를 사용하고 서로의 supervisor가 되지 않는다. macOS의
  launchd label이나 Windows의 process/task identity는 해당 OS에서 실제로 존재할 때만 검증한다.
- Windows 복구에서 macOS 경로·LaunchAgent·POSIX permission bit를 활성 계약으로 복사하지 않는다.
  owner-only 상태는 Windows SID/ACL로 확인하고 실행 파일과 catalog는 `aicc native-rescue status
  --json`이 보고한 절대 경로·hash를 기준으로 삼는다. route launcher가 없다는 사실만으로 Native
  공식 endpoint를 손상으로 판정하거나 17841/10100을 설치하지 않는다.
- Desktop 전체 route를 복구하는 명령은 현재 대화를 끊을 수 있다. 활성 작업 안에서 자동 실행하지
  않고 공통 계약과 Desktop maintenance 계약을 모두 만족할 때만 수행한다.

## 독립 CLI와 일반 Chat

Windows 터미널의 `aicc codex native|ocx --route-model MODEL --route-effort medium`은
동일 공식 실행 파일의 경로·추론 수준만 process별로 고정한다. route/auth/catalog/profile 재정의는 차단하며 command-route-r2의 좁은 사용자 -c와 표준 -m/--model만 지원한다.
`aicc codex status`의 ready는 로컬 prerequisite이며 live inference 증거가 아니다.
일반 Chat은 호스트 명령을 격리 exec로 실행한다고 가정하지 않고 실제 노출되고 owner-bound인
`aicc_codex_cli_start/status`를 사용한다. 없으면 필요한 등록/게시 상태를 보고한다.
`docs/runbooks/workspace-codex-cli.md`에 권한 범위·실제 접수 근거·원 요청 조정·복구를 둔다.

### 로컬에서 고르는 방법

- 평상시 명령은 공식 `codex -C '<Git root>'`다. 공유 HOME의 기본 OCX10100은 정상 적용 목표이며 source만으로 설치판/daemon 전환을 주장하지 않는다. 명시 계정이나 진단만 `aicc codex ocx` 호환 실행기를 사용한다.
- 경로를 따로 지정하지 않은 일반 코덱스 작업은 OCX를 사용한다. OCX·AICC 업그레이드로 연결이 끊기는 독립 정비에만 실행 인수의 ocx를 native로 바꾸고, 정비 후 OCX로 복귀한다.
- 작업 폴더는 정확히 선택하고, model/effort를 별도 명시하지 않으면 사용자 설정을 상속한다. 호환 명령은 endpoint/명시 account만 고르며 낡은 기본 model/catalog를 강제하지 않는다. 기존 CLI 작업을 재개하는 요청은 먼저 원 session/작성권을 조정한다.
- 로컬 터미널은 사용자가 고른 Git root에서 실행할 수 있다. 일반 지피티 도구는 별도로 등록된 owner binding/lease 범위만 사용한다. 두 권한 범위를 혼동하지 않는다.
- 트레이 상태 창의 `CLI` 탭 안에서 OCX/Native 경로·Git 폴더·모델·effort를 고른 뒤 새 터미널에서 시작한다. 우클릭 `Codex CLI · 경로 선택` 및 도구 탭의 `Codex CLI · OCX/Native`도 같은 내부 탭으로 연결한다. 탭 이동과 경로 선택만으로 실행하지 않으며, 터미널 열기를 모델 접수로 보고하지 않는다.
- 트레이 source 후보와 현재 설치본은 별개다. 새 메뉴의 빌드·설치가 기록되지 않았다면 사용자가 이미 그 메뉴를 볼 수 있다고 안내하지 않는다.
- 사용자 설명은 `docs/user-guide.md`의 Native·OCX 선택 절을 먼저 연결한다. 기술 권한·복구 상세만 runbook을 추가한다.

대화형 승인 기본은 사용자 선택에 따라 on-request + auto_review다. 기존 OCX·모델·대화 ID는 유지하고 고정 -a never로 이 선택을 덮어쓰지 않는다. 승인 UI가 없는 비대화형 exec/continuity는 별도 계약을 유지한다. 승인 설정 변경만으로 실행 중인 대화에 반영됐다고 주장하거나 모델 경로를 재시작하지 않는다. 상세는 docs/agent-context-optimization.md의 대화형 Codex 승인 기본 정정 절을 따른다.


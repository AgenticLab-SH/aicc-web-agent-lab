# open-AICC 현재 사용 계약

## 구현과 실제 사용의 완료 기준

제품 변경은 소스 작성, 실제 대상 설치, 현재 실행본 확인, 관련 테스트와 핵심 사용자 흐름의 실제 결과를 구별해 인수한다. 미설치·미실행·권한/연결 HOLD는 해당 범위와 해제 담당을 기록하며 전체 완료로 표시하지 않는다. 설치 대상·버전/해시·결과 근거·복구 위치는 owner-private 운영 원장에 둔다. 기존 계정·자료·불명 전송은 보존하고 테스트가 외부 발신·결제·공개·실거래 권한을 만들지 않는다.

OCX 요청 수명·메모리 동시 작업·계정 전환·복구의 현재 계약은 `tools/platform/opencodex/README.md`와 runtime handbook02가 소유한다. 날짜별 과거 설치 기록을 현재 정책으로 적용하지 않는다.

이 문서는 재사용 가능한 open-AICC 제품의 **안정된 사용 계약**을 설명한다.
특정 Mac의 설치 버전, PID, 계정, Tunnel ID, 작업 수와 검증 결과는 여기에 고정하지
않는다. 그런 값은 설치된 `aicc` 명령과 owner-private 운영 원장에서 확인한다.

## 무엇을 관리하는가

open-AICC는 다음 표면을 한 제어면에서 관찰하고, 위험한 변경을
`preview → confirm → execute → verify` 순서로 제한한다.

- Codex Native, OCX, 선택형 Web GPT adapter의 모델 경로
- 외부 ChatGPT용 AICC Workspace MCP
- 계정 별칭과 인증 상태의 비밀 없는 inventory
- 브라우저 identity와 task-owned target lease
- durable job, 단일 writer lease와 산출물 provenance
- Codex·Claude로 배포하는 canonical guidance
- 선택형 OpenAI API 예산·모델 guard
- Project·skill·plugin·ChatGPT 자산 registry와 guarded Notion connector

private Web GPT adapter 없이도 설치, status, guidance, Workspace와 대시보드는
독립 동작해야 한다. 브라우저 profile, 인증, session, raw prompt/response와 개인 원장은
공개 패키지에 포함하지 않는다.

## 설치 후 시작점

~~~bash
aicc status --json
aicc open
aicc guidance check
aicc workspace status
aicc assets status --json
~~~

현재 설치에서 지원하는 전체 명령은 `aicc --help`와 각 하위 명령의 `--help`를
정본으로 삼는다. 문서 예시가 설치본과 다르면 추측해 실행하지 말고 help/schema를
우선한다.

## 독립 실행 경로

| 경로 | 목적 | 독립성 |
| --- | --- | --- |
| Native direct | 공식 Codex 복구·독립 사용 | 17841과 10100에 의존하지 않음 |
| OCX direct | 비-Web provider 라우팅 | Web GPT 브라우저와 분리 |
| Web GPT adapter | Codex task에서 ChatGPT Web 추론 | optional private adapter가 public contract 구현 |
| AICC Workspace | 외부 ChatGPT에서 등록 로컬 workspace 사용 | Codex task나 OCX 추론을 호출하지 않음 |

일반 `codex`는 공식 Native를 기본으로 사용한다. 필요한 failure domain만 아래 이름으로
명시하며 자동 fallback은 없다.

~~~bash
codex                 # official Native
codex-aicc            # Integrated Web GPT 17841
codex-web             # direct browser-only Web GPT 17842
codex-ocx             # OCX direct 10100
codex-native-rescue   # 설정과 무관한 official Native 복구 경로
aicc route-launchers status
~~~

`aicc route-launchers install`은 두 로컬 API가 현재 광고한 모델만 별도 catalog에 봉인하고
세 명시적 실행기를 원자 설치한다. 기본 Codex 설정은 installer가 바꾸지 않는다.

Codex Desktop/route 유지보수에는 다른 task나 예약 heartbeat 대신 owner-only
foreground Terminal guardian을 사용할 수 있다. 이 guardian은 고정 Native CLI로 같은
task만 재개하고, 외부 ChatGPT에는 `.aicc-recovery/`의 비밀 없는 handoff만 노출한다.
17841이 연속 exact-idle일 때의 Web GPT 호출은 조언 단계이며 로컬 변경 권한이 아니다.

한 경로의 실패를 다른 provider, 계정, 브라우저 또는 workspace로 조용히 바꾸어
성공처럼 기록하지 않는다. route 변경 전에는 현재 owner와 active counter를 라이브로
확인하고 rollback point를 남긴다.

## 대시보드와 안전 변경

~~~bash
aicc open
aicc status --json
aicc action list
~~~

대시보드는 loopback 제어면이다. 읽기 전용 상태는 즉시 확인할 수 있지만 route,
계정, 설치, updater와 cleanup은 미리보기와 일회용 확인을 거친다.

~~~bash
aicc action preview <action>
aicc action execute --confirmation '<one-time-token>'
~~~

명령 성공만으로 완료를 선언하지 않는다. 변경 후에는 대상 service health, owner,
route, active counter와 rollback 가능성을 다시 확인한다.

## Web GPT adapter 계약

`Web GPT`는 Codex의 `chatgpt-web/*` route를 뜻한다. Codex 인앱 Browser로 ChatGPT
UI를 조작하는 작업과는 별도다.

public core는 adapter contract와 안전 gate만 소유한다. 계정 로그인, 브라우저
partition, 서명된 앱, UI selector와 owner-only rollback은 private adapter가 소유한다.
public core는 private adapter가 없어도 동작하며, private adapter는 core를 fork하지
않는다.

Web GPT 진단이 설치된 환경에서는 다음처럼 현재 상태를 확인한다.

~~~bash
aicc web-gpt status --json
aicc web-gpt doctor --json
~~~

Web GPT가 local write를 사용할 수 없거나 모든 연결 경로가 불안정하면 사용자가 다음 한 줄을 어느 경로에서나
실행한다. 비밀 없는 현재 진단이 owner-only bundle과 이 workspace의 고정 mirror에 즉시 저장된다.

~~~bash
aicc recovery-handoff refresh
~~~

고정 mirror는 `.aicc-recovery/LATEST.md`, `.aicc-recovery/LATEST.json`,
`.aicc-recovery/LATEST.manifest.json`이다. 외부 Web GPT에는 `LATEST.md`만 먼저 읽게 하고, 구조화된 근거가
필요할 때 `LATEST.json`을 추가로 읽게 한다. 이 명령은 route/account/browser/Desktop/Tunnel/Workspace
runtime/publication/callback을 변경하지 않는다.

설치·업데이트·종료는 `accepting_turns`, `accepting_browser_turns`와 HTTP/browser
active counter의 exact-zero를 구분한다. `UNKNOWN`을 0으로 해석하거나 Desktop 전체
유휴와 browser-only drain을 혼동하지 않는다.

## AICC Workspace 계약

AICC Workspace는 외부 ChatGPT가 등록된 Git workspace 안에서 읽기·검색·검토하고,
기본 정책에서는 별도 승인과 단일 writer capability가 있을 때만 쓰기·명령을 수행하는 MCP다.

~~~bash
aicc workspace status
aicc workspace configure --surface business-full
aicc workspace configure --surface business-full --include-projects-root --owner-unrestricted-write
aicc workspace configure --surface business-full --include-projects-root --include-owner-content-roots --owner-unrestricted-write
aicc workspace configure --surface personal-read-fetch --include-projects-root --include-owner-content-roots
aicc workspace status --surface personal-read-fetch
aicc workspace app-sync status --json
aicc workspace app-sync plan --topology-file /absolute/topology.json --inventory-file /absolute/inventory.json --json
aicc workspace app-sync operations --plan-file /absolute/plan.json --json
aicc workspace app-sync verify --plan-file /absolute/plan.json --post-read-file /absolute/post-read.json --json
~~~

`app-sync status`는 owner-local topology의 세 계정 stable binding을 먼저 보여주고, fresh browser inventory가
없으면 installed/runtime/browser-visible을 `UNKNOWN`으로 유지한다. `app-sync`는 하나의 논리 plugin을
Business shared binding과 Personal replica로 분리해 계획한다. add/create,
update, enable, share, disable, exact-authorized delete를 표현하지만 plan/operations/verify는 모두 읽기 전용이다.
실제 변경은 private registered-CDP driver가 fresh inventory hash에 결속된 operation ID 한 개만 실행하고 바로
post-read한다. dispatch 이후 결과가 불명확하면 `UNCERTAIN`이며 같은 operation을 재실행하지 않는다. 삭제는
stable app ID, preimage hash, zero reference, canary, quarantine, rollback rehearsal, exact authorization이 모두
있을 때만 candidate가 된다.

- 임의 절대 경로 대신 등록 alias를 사용한다.
- workspace 탈출, symlink 탈출, 민감 파일과 Git 내부 metadata를 차단한다.
- 새 작업은 새 correlation과 만료 capability를 사용한다.
- 기본 write/exec는 고유 request ID, durable writer binding과 sandbox를 요구한다.
- 소유자 전용 확장 모드는 프로젝트 루트 전체를 하나의 alias로 추가하고 write를 기본값으로
  열어 approval/job 필드를 없앤다. 인증·한 workspace의 단일 writer·고유 request ID·sandbox는
  해제하지 않는다.
- `--include-owner-content-roots`는 소유자 홈 아래의 보이는 일반 콘텐츠 디렉터리를 각각 별도
  alias로 등록한다. 홈 자체, 숨김 디렉터리와 `Library`는 등록하지 않아 인증·세션·브라우저
  프로필 같은 application-owned state가 원격 셸의 루트가 되지 않게 한다.
- 광고된 도구 schema와 live server schema가 다르면 게시·쓰기를 HOLD한다.
- Business는 22 tools = read 17 + write 5다. Personal `--personal-read-fetch`는 별도 state/Tunnel에서
  18 tools = read 18 + write 0이며 open도 read-only lease로 고정한다.
- Personal에는 patch, exec, stdin과 process-stop을 등록하지 않고 Business publication record를 재사용하지 않는다.
- 사용자에게는 `AICC Workspace` 하나로 보이게 하되 Business publication과 Personal publication의 stable ID,
  Tunnel, 권한, rollback은 분리한다. 계정별 추가·수정·공유·활성화·비활성화·삭제는 최신 inventory hash와
  exact app ID에 결속된 one-shot으로만 수행한다.

Business 앱 metadata를 갱신할 때는 기존 연결을 추측해 삭제하지 않는다. 현재
developer-mode 연결의 refresh/version 절차를 사용하고, 새 대화의 read canary와
명시 승인된 scratch-write canary가 끝날 때까지 기존 연결을 rollback으로 보존한다.

## durable job과 orchestration

긴 작업은 prompt 본문이 아니라 비밀 없는 metadata, checkpoint, attempt, artifact와
검증 상태를 내구 원장에 남긴다.

~~~bash
aicc job status --json
aicc job list --json
aicc orchestration status --json
~~~

같은 workspace의 writer는 하나뿐이다. 다중 역할 작업은 current turn이 실제 광고한
도구와 status를 먼저 확인하고, 읽기 역할 병렬화 뒤 exclusive writer와 독립 verifier,
cleanup을 사용한다. 도구가 없거나 approval surface가 맞지 않으면 그 단계에서 HOLD하며
browser fallback이나 provider 전환으로 대체하지 않는다.

## guidance와 개인 상태

canonical guidance는 `guidance/`에서만 수정하고 생성된 Codex·Claude home 사본은
배포 명령으로 갱신한다.

~~~bash
aicc guidance check
aicc agents status
aicc agents plan
aicc agents deploy
~~~

open-AICC가 소유한 이동 가능한 선언 상태는 installer가 선택한 Private Home에 둔다.
Keychain, Codex/OCX auth DB, 브라우저 profile처럼 외부 앱이 소유한 상태는 공식
위치에 보존하며 무리하게 이동하거나 symlink하지 않는다.

## 문서 지도

- [문서 홈](README.md)
- [아키텍처](architecture.md)
- [실행 계약](execution-contract.md)
- [상태 경계](state-boundaries.md)
- [Private Home](private-home.md)
- [브라우저와 원격 작업 경계](browser-remote-boundaries.md)
- [내구 작업과 산출물](durable-jobs-artifacts.md)
- [Extensions와 Web GPT orchestration](extensions-and-web-gpt-orchestration.md)
- [통합과 마이그레이션](open-aicc-migration.md)

특정 owner 설치의 현재 판정은 재사용 계약 문서인 이 파일에 고정하지 않는다. 이 checkout에서는
`../context/PROJECT.md`가 live runtime·route·release·writer·recovery의 현재 진입점이고, 세부 비밀 없는
운영 근거는 owner-private 실행 원장을 따른다. `C:\demo\projects\ai-platform`은 목표 아키텍처·계약·
acceptance를 소유하며 이 live current를 복제하지 않는다.

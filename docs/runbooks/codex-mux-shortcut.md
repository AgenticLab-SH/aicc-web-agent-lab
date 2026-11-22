# OCX Codex를 짧은 명령으로 열기

Windows PowerShell의 acx는 기존 aicc codex ocx와 psmux를 묶는 선택형 바로가기다.
관리자 권한이나 새 HOME, 전역 계정·provider 변경, 서비스 재시작을 사용하지 않는다.

## 설치

저장소에서 다음 명령을 한 번 실행한다.

    & .\tools\platform\codex\Install-AiccCodexShortcut.ps1

기존 aicc가 있는 폴더에 acx.ps1 하나를 새로 쓴다. 기존 acx가 있으면 덮어쓰지 않고 중단한다.
PATH·PowerShell profile·로그인 자동 실행은 변경하지 않는다.

## Windows Terminal 탭 이름과 순서

PC의 Windows Terminal PowerShell에서 `aicc terminal-tabs` 또는 `mux tabs edit`를 실행한다. 목록에서 탭 하나의 이름을 바꾸거나 앞에 붙은 번호순으로 정렬하고, 미리보기에 동의하면 적용한다. 번호 없는 탭은 기존 상대 순서를 유지한 채 뒤에 놓는다. `aicc terminal-tabs list`는 읽기 전용 목록, `aicc terminal-tabs sort`는 정렬 미리보기다. 수정은 현재 창에서만 실행하며 포커스가 바뀌면 중단한다.

이 도구는 Windows Terminal 탭을 다룬다. Codex 저장 대화 제목은 Codex의 이름 변경 기능, mux의 대화 표시명은 `mux rename`으로 변경한다. 현재 탭·대화·프로세스를 종료하거나 다시 열지 않는다. AICC 공통 도구의 ‘대화 → Windows Terminal 탭 이름·순서’에서 PC 명령을 확인할 수 있다.

저장소 CLI는 `tools/platform/windows/Invoke-AiccTerminalTabs.ps1`을 호출한다. 이미 설치된 Windows 명령에 연결할 때는 기존 사용자 소유 mux가 이 도구의 동일한 복사본을 사용한다. 다른 런처나 모바일 런타임에 UI 조작 권한을 추가할 필요가 없다.

## 사용

| 명령 | 동작 |
| --- | --- |
| acx -List | 공유 namespace의 세션 이름 읽기 |
| acx g1-dev | 기존 g1-dev에 연결. 대화·프롬프트 재생 없음 |
| acx work | work가 있으면 연결, 없으면 그 안에서 새 OCX Codex 시작 |
| acx work -Workspace 'C:\work\project' | 새 세션의 작업 폴더 지정 |
| acx work -Detached | 전면 연결 없이 세션 준비 |
| acx work -Model gpt-6.1-sol -Effort high | 새 세션에만 모델·추론 수준 지정 |

기본 namespace는 aicc-phone, 모델은 gpt-6.1-sol, effort는 high다. 이 바로가기의 새 세션에만 적용한다.
기존 세션이 있으면 명령에 폴더나 모델을 넣어도 실행 중인 세션을 바꾸지 않는다.
acx만 입력하면 work를 사용한다. 다른 세션 이름은 독립된 새 대화를 만들 수 있으므로 목록을 먼저 읽는다.

Codex가 종료되면 PowerShell을 유지한다. 같은 세션에 다시 연결한다고 Codex를 자동 재실행하지 않는다.
psmux 목록 오류·불명 생성은 자동 재시도하지 않는다. 모델 성공이나 새 대화 ID는 세션 생성과 별개다.

## 대화 유지와 계정 자동전환

이미 mux 안에 있는 대화는 해당 세션에 연결하면 그대로 볼 수 있다. 밖에서 실행 중인 TUI를 옮기지는 않는다.
닫힌 대화는 기존 터미널 메뉴의 정확한 ID/작성권 조정을 사용한다. 이 바로가기는 임의 resume·자동 prompt 제출을 하지 않는다.
공식 Codex의 대화 재개와 OCX의 계정 전환은 별도 기능이다.
[공식 Codex CLI](https://developers.openai.com/codex/cli/reference)는 codex resume SESSION_ID를 제공하지만,
다른 계정에 기존 암호화 reasoning·response/file ID를 넘겨도 된다는 뜻은 아니다.

2026-10-30에는 rotation/lifecycle/scrub/97% 동결 OCX 후보의 실제 적용 작업이 `ACTIVATED`로 완료됐다.
이 바로가기는 mux 연결을 담당하며, 계정 전환은 설치된 OCX가 다음 미전송 요청에서 처리한다.
strict 계정 고정, 파일·상태 참조, 완료 근거가 없는 기존 대화나 불명 전송은 계속 보호한다.
기존 모든 대화의 이동 가능 여부와 실제 계정 전환은 검증하지 않았다.
자동전환 후보·97% 보호·HOME catalog 설치와 독립 복구 절차는 [기존 운영 문서](workspace-codex-cli.md)를 따른다.
원 UNKNOWN을 다시 보내거나 만료된 READY를 재사용하지 않는다.

## 상태와 복구

## 트레이·Termius 대화 선택기 · source

기존 WinForms 트레이의 대화 탭은 `터미널 대화`와 기존 `Desktop · 자동재개`를 함께 제공하는 source로 연결했다. 터미널 선택기는 제목 검색, 열린/최근 목록, 열기, 새로 고침, PowerShell을 제공한다. ↑↓·Enter·두 번 클릭·F5·F1을 지원하며 Esc는 기존 트레이 닫기 경로를 유지한다. 긴 제목과 UUID는 선택 정보에서 확인한다. 주표시는 실제 저장된 Codex 제목이며, 보조표시는 mux·종류·모델/effort·마지막 열기다. 미확인 모델은 추정하지 않는다. 열린 터미널과 모델 작업 중은 별개다.

공유 source는 `Select-PhoneTerminal.ps1`/`Resume-PhoneTerminal.ps1`, 트레이 호출은 `Invoke-AiccTerminalPicker.ps1`다. owner-local `terminal-history.json`과 네 대화 결속을 재사용한다. 목록 열기·수동 새로 고침·실행 시만 조회하며 검색은 캐시에서 처리한다. pane PID/하위 프로세스만 한정 조회하고 session index의 마지막1MB 및 결속된 rollout의 bounded header/tail만 읽는다. 전체 로그 스캔, 전체 프로세스 반복 열거, 추가 timer/daemon/model 요청을 만들지 않는다. 자원 사용량은 측정하지 않았다.

열린 exact mux는 attach만 한다. 닫힌 PowerShell은 기록 폴더만 복원한다. 닫힌 Codex는 기존 opencodex provider·모델/effort와 exact ID를 보존해 추가 프롬프트 없는 resume를 사용한다. 다른 provider는 해당 정비 owner에게 남기며 조용히 OCX/Native로 바꾸지 않는다. 기존 release 이후 바뀐 기록·중복 프로세스·불명 요청은 HOLD다.

닫힌 Codex에는 실제 controller가 생산한 `aicc-terminal-resume-release` 영수증을 `Register-PhoneResumeRelease -RecordId ID -ReceiptPath ABSOLUTE_PATH -ExpectedSha256 SHA256`로 결속해야 한다. 영수증은 schemaVersion1, exact recordId/threadId/provider/model/effort, normalExit/writerReleased=true, activeCount/unknownCount=0, stoppedPid, epoch-ms observedAt/expiresAt(60초 이내), rolloutLength/rolloutLastWriteUtc, writerRecord={path,sha256}를 가진다. writer 정본의 owner는 exact thread이고 writerReleased=true여야 한다. 이 함수는 정상종료/READY/UNKNOWN0을 합성하지 않는다. 실행 직전 원 SHA·프로세스·현재 writer를 다시 대조하고 동일 writer의 lock/CAS를 인수한다. intent·원본·불명 lock은 보존하며 기존 대화의 자동재생이나 새 대화 대체는 없다.

G1-08 연결(2026-10-31 source, 설치·실행·검증0): 재개 실행기는 이제 `aicc codex ocx ... --checkpoint-dir <PhoneRoot>\stops\<AttemptId> resume <thread>`로 띄운다. 실행기가 실제 exit/PID·이 대화 OCX fence 행만으로 `codex-checkpoint-stop`을 남기면, 재개 실행기는 자기가 잡은 작성권 bytes가 그대로일 때만(CAS) `writerReleased=true`로 돌려놓고 기록에 stopReceipt와 writerRecordPath를 저장한다. 다음 열기에서 `New-PhoneResumeReleaseFromStop`이 그 영수증과 지금 다시 읽은 rollout 길이·수정시각, 이 대화 fence 행 0, writer owner/해제를 확인해 55초짜리 `aicc-terminal-resume-release`를 만들고 기존 `Register-PhoneResumeRelease`/`Assert-PhoneResumeRelease`를 그대로 거친다. 영수증이 없거나 무엇이든 바뀌었으면 기존처럼 HOLD이며 작성권을 잡은 채 보존한다. 처음 한 번의 해제와 writer 경로는 여전히 원 소유자가 준다. provider 검사는 `opencodex`와 compat 실행기의 `aicc-ocx-compat`를 모두 받는다. 설치 순서 의존: `--checkpoint-dir`를 아는 r2 CLI가 먼저 설치돼야 한다. 옛 CLI에 이 옵션을 넘기면 Codex 인자로 전달돼 재개가 실패할 수 있다.

설치 source는 기존 `Install-AiccStatusTray.ps1 -ContinuityOnly`의 immutable manifest/compiler 입력에 연결했다. 이 명령은 이번에 실행하지 않았다. 등록된 트레이 source 설치 뒤 `Register-AiccTerminalPicker.ps1`가 원 Select/Resume SHA를 확인하고 작은 백업/PS5 File.Replace 비어있지 않은 backup 경로를 사용해 기존 휴대폰 진입 두 파일을 immutable source에 결속할 수 있다. history·profile·sshd·자동 시작·기존 watcher는 변경하지 않는다. PS7.5 DateKind String과 PS5.1 문자열 timestamp 호환을 유지한다.

60초 watcher 제거는 아직 하지 않는다. 시작/종료 이력 대체 경로의 실제 설치·인수가 완료되기 전에 삭제하거나 작업을 중지하지 않는다. 새 모델/effort 지원 목록을 합성하지 않고 기존 custom slug와 기록 effort를 그대로 resume에 전달한다. HOME v8/installed reader/CLI helper/Desktop의 최신 모델 picker 지원은 G1 잔여다. 검증·빌드·설치·실제 화면/재개 확인은 NOT_RUN이며 OCX 기존 ACTIVATED와 별개다.

소스 작성, acx.ps1 설치, mux 실제 사용, 모델 접수는 서로 다른 상태다. 이번 변경의 검증은 미실행이다。
새 명령을 사용하지 않으면 기존 aicc와 세션은 계속 유지된다.
되돌릴 때에는 설치 출력에 기록된 acx.ps1 하나만 대상으로 삼고 기존 aicc·psmux·대화 기록을 보존한다.

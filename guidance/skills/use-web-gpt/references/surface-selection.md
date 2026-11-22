# Web GPT surface·탭 예산 선택 계약

포트·브라우저·계정·기존 대화가 언급되면 prompt 입력이나 파일 첨부보다 먼저 이 계약을 적용한다.

## 선택 우선순위

| 사용자 표현 | 선택해야 하는 surface | 다른 경로로 대체 |
| --- | --- | --- |
| 등록된 포트 또는 `그 포트의 CDP` | 해당 loopback 포트의 registered CDP slot | 금지 |
| `Chrome 확장`, `내 Chrome`, `현재 Chrome` | 명시된 Chrome connector surface | registered CDP·인앱 Browser로 대체 금지 |
| `Codex 인앱 Browser`, `인앱` | 현재 작업에 제공된 in-app Browser | Chrome connector·registered CDP로 대체 금지 |
| `Codex Web GPT 앱`, `chatgpt-web/*`, `17841` | routed Web GPT 앱 | Browser UI로 조용히 대체 금지 |
| surface 지정 없음 | 현재 작업에 결속된 기존 연결 우선, 없으면 등록된 사용 가능 경로를 선택·기록 | 선택 후 조용한 변경 금지 |

URL이 같거나 같은 ChatGPT 로그인처럼 보여도 서로 다른 surface다. 사용자가 포트를 말했으면 URL 검색,
마지막 활성 탭, Dock에서 앞에 보이는 창, Chrome connector의 표시명으로 surface를 다시 선택하지 않는다.
registered CDP가 등록돼 있지만 listener만 꺼져 있으면 exact 등록 launcher를 한 번 기동하고 identity를
재검증한 뒤 계속한다. task-owned target이나 원하는 URL이 없으면 같은 slot에 새 target을 만들어 연다.
이 기동·target 생성은 다른 surface로의 대체가 아니다. 등록 launcher 부재, 기동 실패, identity mismatch일
때만 `HOLD_SURFACE_UNAVAILABLE` 또는 `HOLD_SURFACE_MISMATCH`로 끝낸다. 일반 Chrome 확장은 아래의
동일 surface 재발견을 먼저 수행한다. 다른 surface로 전환해 연결 성공을 대신하지 않는다.

계정 번호·메인/서브·용도는 사용자의 최신 명시와 private coordination으로 해석한다. `1번 Chrome`을
자동으로 첫 CDP slot이나 첫 계정으로 바꾸지 않는다. 일반 Chrome profile과 CDP profile은 별개다.
포트에 영구적인 계정·요금제·서비스 역할을 붙이지 않으며, 별도 작업용 slot을 일반/Pro fallback으로
선택하지 않는다. 개인 별칭, profile 경로, session 정보와 private coordination 원문은 prompt나 공개
산출물에 복사하지 않는다.

사용자 지정 역할·로그인 완료 보고와 실제 session/workspace/요금제 검증은 별도 증거다. session API의
빈 결과·경고 banner·읽기 실패만으로 로그인 미완료라고 단정하지 않는다. 같은 exact slot의 task-owned
화면과 허용된 읽기로 확인하고 실제 인증 도전이 있을 때만 로그인 개입을 요청한다. Pro 만료 예정일은
기준일·시간대·출처와 함께 비공개 정본에 둔다. 만료 이후 Pro 사용은 실제 권한 재검증 전에는 선택하지
않으며, 계정 자체를 삭제하거나 다른 계정으로 조용히 우회하지 않는다.

## 일반 Chrome 확장 연결 진단

Chrome 실행, 확장 설치·활성, native host 등록·프로세스, 현재 provider 연결, 탭 접근, ChatGPT 로그인은
각각 다른 상태다. `9222` 같은 CDP listener의 실패는 그 등록 slot에만 해당한다. 일반 Chrome 확장의
연결·계정 검사에 등록 CDP 조회를 선행 조건으로 붙이지 않는다.

1. 현재 도구 문서의 provider 인벤토리를 읽는다. CUA에서는 `cua.listBrowsers()` 또는 `cua.getState()`를
   사용하며 `family=chrome`, `type=extension`인 선택을 확인한다. `errors`가 있으면 빈 결과와 구분한다.
   연결된 browser handle은 유지하고 현재 반환된 ID와 `metadata.extensionInstanceId`를 결속한다.
   숫자 browser ID는 호출 세션·agent 사이에서 달라질 수 있다. 다른 agent가 넘긴 ID를 그대로 쓰지 말고
   같은 extension instance가 현재 인벤토리에서 어떤 ID인지 확인한다.
2. 처음 provider가 없거나 `Browser is not available`이면 이를 발견 실패로 기록하고 같은 인벤토리를
   한 번 재조회한다. 도구 문서의 대기 규칙이 있으면 따른다. 재발견되면 같은 확장에서 계속한다.
   고정 숫자 ID, 예전 탭 handle, 다른 Chrome·CDP·인앱 Browser를 번갈아 시도하지 않는다.
3. provider는 있는데 탭만 stale하면 선택된 browser에서 `cua.listTabs({browser: currentId})` 등 현재
   문서의 탭 목록으로 대상 하나를 다시 찾는다. 빈 탭 목록은 browser 종료의 증거가 아니다.
   탭 그룹 확인에는 실제 `tabGroup` 정보가 필요하며 제목·URL만으로 그룹을 추정하지 않는다.
4. 재발견도 실패하면 설치된 해당 browser plugin의 troubleshooting 문서를 읽고, 문서가 지원하는
   읽기 전용 진단만 실행한다. Chrome plugin은 `chrome-is-running.js --browser chrome --json`,
   `check-extension-installed.js --browser chrome --json`, `check-native-host-manifest.js --browser chrome --json`
   으로 실행·확장·등록 상태를 나눠 확인한다. 실제 plugin 경로를 먼저 찾고 계정·비밀은 출력하지 않는다.
5. 설정이 정상이어도 service worker의 현재 handshake와 Codex provider 등록까지 증명한 것은 아니다.
   지원되는 worker/bridge 상태가 없으면 해당 단계는 미확인으로 남긴다. 캐시·worker 원인을 단정하거나
   Chrome 재시작, 새 창·profile, 로그아웃, 확장 재설치·권한 확대, vendor cache 직접 편집으로 넘어가지 않는다.

| 관찰 | 보고할 상태 | 이 관찰만으로 단정하지 않을 것 |
| --- | --- | --- |
| exact CDP endpoint 오류 | 해당 CDP 연결 미확인/실패 | 일반 Chrome 종료, 확장 오류 |
| Chrome 실행, provider 없음 | 확장 provider 미발견 | Chrome 종료, 로그인 해제 |
| 확장·native host 검사 통과, provider 없음 | 등록 정상 / 실제 연결 미확인 | 계정 확인 완료, service worker 고장 확정 |
| provider 있음, 대상 탭 없음 | 대상 탭 미발견 | browser 종료, 다른 profile로 전환 필요 |
| 같은 확장 재발견과 기존 탭 목록 성공 | 현재 확장 연결 확인 | 이전 실패의 내부 원인 확정, 재발 방지 검증 완료 |

연결 진단 요청은 provider와 열린 탭의 메타데이터 조회를 허용한다. 이를 탭 claim·본문 읽기·focus·이동·
닫기 권한으로 확대하지 않는다. 보고에는 확인 시각, 선택 surface, 확인된 단계, 미확인 단계와 수행한
복구 동작만 남긴다. extension instance ID와 profile·대화 식별자는 필요한 비공개 작업 기록에만 둔다.
재발견 한 번 뒤에도 실패하면 `HOLD_EXTENSION_CONNECTION_UNCONFIRMED`로 원래 경로를 보존한다.

### 시간 초과 뒤 기존 작업 회수

도구 시간 초과나 REPL kernel reset은 호출이 실행되지 않았다는 증거가 아니다. 탭 생성·이동·제출을
묶은 호출이 실패했어도 일부 동작은 이미 끝났을 수 있으므로 결과를 미확인으로 두고 묶음 전체를 재실행하지 않는다.

- reset 뒤에는 현재 도구 문서를 다시 받고 같은 확장 인벤토리에서 extension instance와 현재 browser ID를
  결속한다. 기존 탭 목록에서 직전 exact tab ID·conversation URL·작업 소유권을 확인해 해당 탭을 다시 연동한다.
  생성 결과가 하나로 확정되지 않으면 새 탭을 만들거나 임의의 같은 URL 탭을 선택하지 않는다.
- 기존 대화에서 응답 불러오기 오류가 보여도 요청 미전송이나 처리 실패로 단정하지 않는다. 같은 exact
  conversation URL에서 이미 생성된 결과·도구 실행 흔적과 현재 상태를 먼저 회수한다. 불러오기 오류와
  작업 실패는 구분하며, 확정되지 않은 원요청을 재전송하거나 다른 대화에서 복제하지 않는다.
- 재연결·결과 회수도 실패하면 원래 요청과 탭 식별자를 비공개 작업 기록에 남기고 해당 결과만 미확인으로
  보고한다. Chrome 종료·로그아웃·원요청 미실행으로 바꾸어 보고하지 않는다.

### 특정 기존 탭의 debugger 연결 실패

같은 확장의 provider와 탭 목록은 살아 있는데 기존 탭 하나의 `getTab`/snapshot만 반복해서
`Debugger unattached` 또는 시간 초과로 실패할 수 있다. 이는 그 탭의 자동화 연결 실패이며 Chrome
전체 종료나 로그인 해제의 증거가 아니다.

- 현재 탭 목록에서 exact conversation URL을 먼저 회수하고 같은 extension instance의 현재 browser
  ID를 사용한다. 이미 소유한 작업용 탭이 있으면 그 탭에서 exact URL을 연다. 새 작업용 탭이 필요한
  경우에도 아래 창 소유권 계약과 사용자 탭 예산을 만족할 때만 하나 만든다.
- 원래 대화 URL의 렌더링된 본문을 읽어 처리 결과를 회수한다. 원래 탭은 닫거나 새로고침하지 않고,
  요청을 다시 보내거나 응답 재생성 버튼을 누르지 않는다. 새 탭은 같은 대화의 읽기 경로일 뿐 새 작업이 아니다.
- 소유 탭의 새 결과 회수도 실패하면 해당 대화 결과를 미확인으로 남긴다. 다른 계정·CDP·인앱 Browser로
  전환하거나 내부 JSON/debug endpoint를 연결 복구의 대체 경로로 사용하지 않는다.

## 사용자가 지정한 대체 경로

사용자가 `메인 Chrome @chrome 우선, 안 되면 1번 계정의 9222`처럼 대체 순서를
명시하면 그 지시가 자동 대체 금지의 예외다. 기존 확장 실패가 이미 확인됐으면
같은 진단·사용자 본문 복사 요청을 반복하지 않고 승인된 registered CDP로 진행한다.
requested/selected surface와 전환 근거를 기존 작업 원장에 기록한다. 포트·계정의
대응은 해당 사용자의 private coordination과 현재 로그인으로 검증하며 공용
스킬에 영구적인 `9222=메인/1번` 규칙을 만들지 않는다.

읽기는 exact saved URL의 임시 task-owned target에서 수행하고 종료 조건을 먼저
정한다. 기존 사용자 탭·로그인·미결 요청은 보존하고 읽기 실패를 원 모델 요청
재전송으로 바꾸지 않는다. 명시적 보안 거절·신원 불일치·로그인 도전에는 이 예외를
적용하지 않는다. 이 대체 경로 승인은 새 권한·다른 계정 선택의 근거가 아니다.

승인된 대체 경로에서 기존 저장 대화의 텍스트만 필요하면 개인
`chatgpt-conversation-import`의 exact-target 읽기를 선택한다. 첫 호출부터
명시 계정과 `ExactTargetTextSlot`을 함께 지정하고, 알려진 프로젝트 안의 제목
검색은 `ProjectId`로 좁힌다. 앞서 시간 초과한 browser-wide 연결이나 `auto`
계정 순회를 되풀이하지 않는다. 임대 발급은 기존 settled helper가 끝날 때까지
조정하며 시간 제한으로 helper를 강제 종료해 target을 잃지 않는다.
Host의 역사적 거절과 이 승인된 읽기의 성공은 별도 상태로 남긴다.

## 사용자 탭 예산

- 사용자가 `탭 N개`, `동시에 N개`, `병렬 N개`라고 지정하면 `N`은 root agent와 모든 하위 agent가
  공유하는 실행 예산이다. agent별로 `N`개씩 열지 않는다.
- 지정이 없으면 root agent가 독립 작업 수, 목표의 긴급성, 예상 소요시간, 현재 browser·account·시스템
  resource 상태를 보고 가장 작은 유효 병렬도를 선택한다. 실행 중 응답시간·오류·resource 변화를 관찰해
  예산을 늘리거나 줄일 수 있다. 예산 안의 탭은 동시에 작업하고, 초과 역할은 queue한다.
- 각 탭은 `ownerTaskId`, `ownerAgentId`, `parentAgentId`, `surface`, `target/tab ID`, `state`를 메모리의
  소유 목록에 둔다. prompt·응답·cookie·계정 비밀은 목록에 넣지 않는다.
- 결과 회수, 실패, 취소 뒤 해당 agent 또는 parent가 후속 업무를 판단한다. 역할 종료로 확정한 소유 탭만 닫고 slot을 반환하며 개발·검증·복구를 이어갈 대화는 유지한다. 사용자 탭과
  foreign task 탭을 임의 제어 후보로 삼지 않는다. 연결 진단의 메타데이터 조회는 위 계약을 따른다.

## 일반 Chrome 창 소유권

같은 Chrome profile의 창이 여러 개라는 사실, 창 위치·제목·포커스·마지막 활성 상태는 사용자 창과
agent 창을 구분하는 증거가 아니다. `tabs.new({active:false})`는 포커스만 억제하며 exact window 배치를
증명하지 않는다.

- 사용자가 사람용/agent용 창을 분리했다고 밝힌 경우, connector가 exact agent-window identity와 그
  window 안의 tab 생성·post-read를 지원하거나 사용자가 exact agent tab을 명시적으로 mention해야 한다.
- 이 증명이 없으면 일반 Chrome에서 새 탭을 만들거나 기존 탭을 claim·focus·move·close하지
  않고 `HOLD_WINDOW_OWNERSHIP_UNPROVEN`으로 멈춘다. `currentWindow`, 좌표, 화면 위치, 창 제목,
  Computer Use로 agent 창을 추측하지 않는다.
- registered CDP는 강한 process/profile/target 격리를 제공하지만 일반 Chrome 요청의 자동 fallback은
  아니다. 사용자가 CDP를 지정했거나 surface 미지정 작업에서 등록 CDP를 선택·기록한 경우에 해당 slot의 새 task-owned target을 사용한다.

## registered CDP 증명

예를 들어 `9224 CDP` 요청은 전송 전에 다음을 모두 만족해야 한다.

1. executor가 `registered_cdp`이고 endpoint가 정확히 `http://192.0.2.1:9224`다.
2. private coordination의 요청 role/account/workspace가 그 slot 등록값과 일치한다.
3. endpoint identity 검사가 Chrome process와 9224 전용 profile root를 증명한다.
4. broker가 만든 새 task-owned target ID 하나만 attach한다.
5. 그 target 안에서 ChatGPT account/workspace identity와 요청한 `Chat`/model을 다시 확인한다.

### 꺼진 slot과 없는 target 준비

ordinary Chat의 registered CDP 준비에는 공개 source의
`tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1`를 사용한다.

- `Acquire -SlotPorts <exact-port> -Url <desired-url> -AllowBrowserStart`는 endpoint가 unavailable인 경우에만 private
  coordination에 등록된 exact launcher를 기동하고, full identity 검증 뒤 새 task-owned background target을
  만든다.
- 원하는 saved conversation URL이 있으면 그 URL을 사용한다. 기존 URL이 없거나 새 검토라면
  `https://chatgpt.com/`을 사용해 새 saved Chat을 시작한다.
- Dock 창, 기존 사용자 탭, 마지막 활성 탭이 없어도 HOLD하지 않는다. broker가 만든 target ID만 사용한다.
- slot 기동이나 target 생성 전에 다른 Codex task 수와 17841 non-browser counter를 조회하지 않는다. 이 값은
  ordinary exact-CDP Chat의 capacity나 안전성 증거가 아니다.
- 작업 중 lease를 heartbeat하고 browser-action interval이 끝나면 `Release`로 해당 target만 닫는다. Chrome
  profile, 로그인, 사용자 탭과 launcher process는 lease release 대상으로 삼지 않는다.

Dock의 `9224` 배지와 사용자가 보고 있는 Pro 화면은 유용한 관찰이지만 자동화 연결의 증명은 아니다.
Chrome connector는 loopback endpoint·slot profile·broker target ID를 증명하지 못하므로 registered CDP 요청을
수행할 수 없다. 하나라도 어긋나면 prompt 입력·upload·cadence reserve 전 `HOLD_SURFACE_MISMATCH`다.

## 기존 탭과 기존 대화

탭 수나 마지막 응답 완료만으로 대화가 불필요하다고 판단하지 않는다. GPT/Codex가 현재 목표와 후속 업무를 보고 `continue`(같은 대화에서 개발·검증·복구 예정), `retired`(그 대화 역할 종료·결과 인수), `unknown`(소유/용도 미확인)을 기존 원장에 기록한다. `continue`와 `unknown`은 보존하며, 후속은 같은 계정·workspace의 exact saved URL로 이어간다. `retired` 소유 탭만 완료 영수증과 현재 DOM 대조 후 닫고 목록에서 소멸을 확인한다. CDP도 예외가 아니다.

registered CDP 포트를 지정해도 기존 사용자 탭을 조작할 권한이 생기지는 않는다. 기본 동작은 같은 exact
slot/profile에 새 task-owned target을 만들고 그 target만 조작·release하는 것이다.

- 새 검토: 새 task-owned target에서 새 saved `Chat`을 사용한다.
- 새 탭의 초안: 사용자가 맡긴 작업을 위해 새로 만든 task-owned 탭의 새 일반 Chat이고 기존 user/assistant turn이 0이면 복원된 초안을 지우거나 이번 prompt로 바꿀 수 있다. 복원 초안의 작성자 불명이나 원문 hash 부재만으로 재승인을 요구하지 않는다. 기존 사용자·다른 task 탭과 저장된 대화를 이어가는 탭은 제외한다. 같은 form의 미제출 복원 첨부도 실제 파일명과 제거 제어를 결속해 정리할 수 있다. 기존 메시지·저장된 대화 첨부·전송불명 요청을 삭제하거나 재전송하는 권한으로 확대하지 않는다. 전송 전 신원·Chat 모드·실제 모델·중복 제출 경계는 유지한다.
- 기존 대화 이어가기: 새 task-owned target을 exact saved-conversation URL로 열고 URL·conversation·identity를
  post-read한다. 화면에 이미 열린 사용자 탭은 건드리지 않는다.
- 사용자가 문자 그대로 기존 탭 자체를 요구하면 existing-target 전용 lease와 exact target proof가 지원될
  때만 사용한다. 현재 helper가 task-created target만 지원한다면 `HOLD_EXISTING_TARGET_UNSUPPORTED`로 끝내며
  Chrome connector나 인앱 Browser로 우회하지 않는다.

## 제출 직전 보고값

외부 전송 전에 최소한 다음 값을 내부 result에 고정한다. 비밀·profile 절대경로는 보고하지 않는다.

- `requestedSurface`, `selectedSurface`
- `requestedPort`, `selectedPort`
- opaque account/workspace identity proof
- `targetOwnership=task-created`, exact target ID hash
- `mode=Chat`, 요청 model과 실제 visible model

requested/selected 값이 다르면 send는 0회다. 실패 코드는 surface mismatch/unavailable, identity mismatch,
target ownership mismatch 가운데 실제 원인을 보존하고 다른 browser나 provider를 자동 선택하지 않는다.

### 기존 프로필 자동 기동의 실제 경로

사용자는 승인된 지피티 업무에 필요한 기존 등록 전용 브라우저의 자동 기동을 상시 승인했다. 브라우저가 꺼져 있으면 같은 등록 launcher·기존 프로필로 직접 준비하고 업무를 이어가며 기동 승인을 다시 묻지 않는다. 사용자 탭·계정·로그인과 다른 작업의 세션을 보존한다. 공개 helper는 AICC root에서 해석하고 private coordination은 기존 설정/환경변수로 읽는다. 과거 checkout 경로·고정 PowerShell 버전·개인 profile 경로를 공용 명령에 넣지 않는다.

1. 기존 `Manage-CdpChromeSlotLease.ps1`의 `Acquire`에 현재 등록값의 `OwnerId`, `AccountAlias`, `Workspace`, exact `SlotPorts`, 원하는 `Url`, `AllowBrowserStart`, `AsJson`을 전달한다. 꺼진 등록 slot만 기존 launcher로 한 번 준비한다. 살아 있는 브라우저를 중단해 시험하지 않는다.
2. 반환 endpoint/process/profile/port와 task-owned target을 결속하고 실제 ChatGPT account/workspace를 확인한다. 새 profile 생성·계정 변경·cookie 반입으로 mismatch나 인증 거절을 해결하지 않는다.
3. 개인 스킬 manager처럼 자체 기동하지 않는 호출자는 이 준비를 먼저 끝내고 기존 manager를 사용한다. 각 caller는 자신이 받은 lease만 반환하며 사용자 탭이나 다른 caller의 target을 닫지 않는다.
4. 지피티는 현재 일반 Chat에 실제 노출된 AICC Workspace 도구의 `list → open → exec`를 쓴다. 명령이 허용된 기존 workspace lease와 고유 request_id로 같은 helper를 실행하고 반환 결과를 회수한다. `commands=false` 또는 exec 미노출이면 그 기능만 미지원으로 남긴다. 코덱스가 실행한 결과를 붙여넣어 지피티 직접 실행 성공으로 보고하지 않는다.

2026-10-17 코덱스에서 기존 등록 launcher의 기동, 같은 프로필의 연결, 실제 account/workspace 일치와 개인 스킬 목록 읽기는 관측했다. 일반 Chat 요청 접수·완료와 지피티의 AICC 직접 호출은 별도 미확인이다. 전송 불명은 원요청을 보존하고 재전송하지 않는다. 이 관측은 모든 caller의 cold-start 분기나 무인 재개 보장이 아니다.

## 일반 Chat 모드와 추론 우선순위

codex-web-low-token-workflow의 일반 Chat 계약을 따른다. 현재 사용자는 xhigh 우선·실제 선택지에 없을 때 high만 대체를 지정했다. 모델 요청 오류·읽기 실패만으로 xhigh 부재를 추정하지 않는다. 같은 계정·모델의 실제 picker 의미를 읽고 선택한 값과 활성 표시를 결속한다. Work가 선택돼 있으면 자기 소유 화면의 Chat으로 전환한 뒤 실제 선택·빈 작성기·신원을 확인하고 진행한다. 기존 사용자 탭이나 다른 작업 탭의 초안은 바꾸지 않는다. 위 새 task-owned 탭·새 대화 예외에서는 복원 초안을 정리하고 Chat으로 전환할 수 있다. Work 전송은 금지한다.

현재 managed lease wrapper도 호출자가 명시한 `-AllowBrowserStart`를 등록 broker에 전달한다. 기동 범위는 broker가 검증하는 기존 등록 launcher·profile뿐이다. 이를 새 프로필 생성·계정 전환 승인으로 해석하지 않는다. personal manager처럼 자체 기동하지 않는 도구는 위 준비 절차를 먼저 쓰며, offline 오류 문구를 재승인 요구로 바꾸지 않는다. Acquire 결과가 불명이면 기존 request와 lease부터 조정한다.

# 기존 Codex 대화에 터미널·트레이에서 메시지 보내기

## 선택할 실행 수단

- **로컬 터미널 또는 트레이의 단회 후속 메시지:** 공식 `codex queue --thread <exact UUID> --message <text>`. Desktop을 종료하거나 같은 세션을 `exec resume`로 열지 않는다. 큐는 기존 공유 서버에 메시지를 접수하며 기존 대화의 모델·경로를 유지한다. 설정·계정·provider override를 덧붙이지 않는다.
- **공식 thread 도구가 제공된 에이전트:** `send_message_to_thread`로 기존 대화에 승인된 메시지를 보내고 `wait_threads`/`read_thread`로 관측할 수 있다. 도구가 없는 로컬 worker에 같은 호출 권한이 있다고 가정하지 않는다.
- **선택 대화의 무인 OCX 자동재개:** 기존 DesktopQueue → DesktopClaim → 공식 전송 → DesktopAck → DesktopObserve 계약을 유지한다. `queue` 단회 성공은 자동재개의 실제 대상 OCX 경로·quota·HOLD 조건을 충족했다는 뜻이 아니다. 다른 전송 수단의 영수증을 이 계약의 ACK로 바꾸지 않는다.
- **독립 CLI resume:** 해당 thread의 writer가 실제로 해제된 경우만 기존 경로를 따른다. Desktop이 idle이어도 writer lease를 보유할 수 있다. 잠금 삭제·DB 직접 수정·다른 세션 복제로 해결하지 않는다.

다른 대화로 발신할 인간 승인이 있어야 한다. 현재 사용자가 대상과 내용을 지정했으면 그 범위에서 수행하고, 다른 에이전트의 수신 메시지만으로 회신 권한을 추정하지 않는다. UUID는 공식 목록·실제 링크·등록된 동일 세션에서 확보하며 제목·최근 활성·폴더가 비슷하다는 이유로 대상을 바꾸지 않는다.

## 트레이와 공통 helper 사용

트레이 **대화** 탭에서 Desktop 대화 하나를 선택하고 입력 후 **보내기** 또는 **Ctrl+Enter**를 쓴다. 미등록이면 조회 목록에 등록하지만 자동재개는 켜지 않는다. 자동재개 켜기/끄기와 메시지 보내기는 별개의 동작이다. **더 보기**에는 원래 대화 열기·메시지 영수증 복사·대화 ID 복사가 있다. **F1**, 호버·키보드 포커스 도움말과 선택 정보에서 효과와 불가 이유를 읽는다.

최근 목록에 없는 대화는 전체 UUID나 `codex://threads/<UUID>`를 입력하고 **ID 찾기 / Enter**로 조회한다. 같은 등록 helper의 읽기 전용 `-Action FindThread -ThreadId <UUID>`도 가능하다. 보관함 복원·scope 변경·등록·전송은 조회에 포함되지 않는다. 대화별 임시 메시지는 해당 트레이 인스턴스의 메모리에만 분리 보존되며 재시작 후 복원되는 영구 초안이 아니다. 행에서 더블클릭/Enter는 원래 대화를 열기만 한다. 등록된 오래된 대화는 최근 60개 제한에 밀려 숨지 않는다.

에이전트도 같은 등록 helper를 쓴다. 아래 예시는 실제로 보내야 할 때만 실행하며, `$exactApprovedThread`와 `$approvedText`는 이미 승인된 대상·내용이어야 한다. 새 operation ID 생성은 새 요청이다. 실패·시간초과 때 아래 전체 블록을 다시 실행하지 않는다.

```powershell
$ownerState = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\control-plane\codex-continuity'
$cfg = Get-Content -LiteralPath (Join-Path $ownerState 'registrations.json') -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
# 실제 등록된 helper와 고정 SHA를 사용한다. 설치 release 파일을 수정하지 않는다.
if ((Get-FileHash -LiteralPath $cfg.helperPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $cfg.helperSha256) { throw 'helper_pin_mismatch' }
$status = & $cfg.helperPath -Action Status | ConvertFrom-Json -AsHashtable
if (-not $status.protocolMatch -or -not $status.queueMessageSupported) { throw 'installed_queue_helper_required' }
if (-not $cfg.threads.ContainsKey($exactApprovedThread)) { & $cfg.helperPath -Action Register -ThreadId $exactApprovedThread }
$operation = [guid]::NewGuid().ToString()
$requestRoot = Join-Path $ownerState 'requests'
New-Item -ItemType Directory -Path $requestRoot -Force | Out-Null
$messageFile = Join-Path $requestRoot ($operation + '.txt')
$stream = [IO.File]::Open($messageFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($approvedText)
    $stream.Write($bytes, 0, $bytes.Length)
} finally { $stream.Dispose() }
& $cfg.helperPath -Action QueueMessage -ThreadId $exactApprovedThread -OperationId $operation -MessageFile $messageFile
```

호스트는 등록된 PowerShell 7.5 이상에서 실행한다. 메시지 본문은 UTF-8 파일로 전달하고 CLI 인수는 `ProcessStartInfo.ArgumentList`로 만든다. `-Command` 문자열에 본문을 삽입하거나 shell escaping으로 조합하지 않는다. helper는 8,192자/32KiB 상한, 등록된 실제 Desktop 세션·활성 rollout·보호 대상·미결 전송·바이너리 신원을 확인한다. 기존 서명된 Desktop transport의 실행 파일을 우선하며, 없으면 등록된 hash 고정 Codex를 사용한다. 임의 PATH wrapper나 새 포트/daemon은 만들지 않는다.

helper는 실행 전에 `requests/<operation>.json`과 registry의 `queueAttempt`를 저장한다. 같은 operation ID·대상·본문으로 다시 호출하면 기존 영수증만 반환한다. 같은 ID의 대상이나 본문을 바꾸면 거절한다. 메시지 뒤의 `AICC_QUEUE_ATTEMPT:<operation>`은 실제 새 turn을 결속하는 운영 표식이다. 새로 고침·탭 재진입·앱 재시작으로 새 operation을 만들어 재전송하지 않는다.

## 관측과 불명 결과

| 상태 | 뜻과 다음 행동 |
|---|---|
| `QUEUE_ACCEPTED` | CLI exit0와 exact thread의 `Queued message <id>`를 받음. 저장 접수이며 실행·완료 보장이 아니다. |
| `QUEUE_TURN_ACTIVE` | 저장된 exact `UserMessage` 표식과 turn ID를 관측함. 해당 대화에서 응답을 확인한다. |
| `QUEUE_TURN_COMPLETED` | 같은 turn의 `task_complete` 관측. 전체 사용자 업무/goal 완료로 확대하지 않는다. |
| `QUEUE_TURN_INTERRUPTED` | 같은 turn의 중단 관측. 자동 재전송하지 않는다. |
| `QUEUE_DELIVERY_UNCERTAIN` | CLI 실패·시간초과·ACK 형식 불명 또는 실행 직전 claim만 남음. 영수증과 원래 대화를 먼저 조정한다. |

`Status`/`Overview`는 읽기 관측이며, 기존 worker는 자동재개가 꺼진 대화의 수동 메시지도 관측한다. Desktop의 typed `item_completed / UserMessage`와 exact turn ID를 사용한다. 시간상 가까운 다른 turn, `task_started`만 있거나 예상 답이 없다는 이유로 전달/완료를 추정하지 않는다. 관측 범위에서 표식이 사라지면 미확인 상태를 유지한다. 같은 스레드의 미결 전송은 재개·추적 완료·관리기 업그레이드에서도 보존한다.

설치에 이 기능이 없고 직접 CLI를 써야 하는 승인된 단발 작업은 먼저 실행 파일의 `queue --help` 지원과 정확한 기존 대상, 단일 발신자·본문 hash·시작 시각을 기록한다. 한 번만 실행하고 queued ID를 저장한다. 응답이 불명이면 새 명령으로 재시도하지 않는다. 실제 전송이 필요하지 않은 조사·설계에서는 시험 메시지를 보내지 않는다.

## 범위와 제약

- `queue`는 텍스트 후속 입력이다. 이 경로로 이미지 첨부·파일 업로드·큐 항목 취소·강제 steer가 지원된다고 추정하지 않는다. 실제 버전의 도움말에 없는 옵션을 만들지 않는다.
- 긴 활성 goal은 큐 처리를 늦출 수 있다. 접수만으로 즉시 시작한다고 약속하거나 goal을 강제 종료/재설정하지 않는다. 일회성 `exec` 프로세스의 종료 뒤까지 큐가 처리된다고 보장하지 않는다.
- 로컬 전달과 서버 독립/PC 종료 후 운영, 모바일 제어, 한도 회복 뒤 자동재개는 별도 능력이다. `--remote`/authenv는 이미 승인·설정된 원격 경로가 있을 때만 실제 도움말을 따라 사용한다. 인증자료를 복사해 해결하지 않는다.
- 생성·목록·읽기·대기·제목 변경·보관·열기는 해당 공식 `create_thread`, `list_threads`, `read_thread`, `wait_threads`, `set_thread_title`, `set_thread_archived`, `navigate_to_codex_page` 기능을 사용한다. 새 대화 생성과 다른 대화 발신은 각각 사용자 승인을 따른다. URI 열기는 탐색이며 메시지 전송이 아니다.
- 사용자 요청의 검증 범위와 현재 모델 정책을 따른다. source 작성·스킬 배포·helper 설치·트레이 빌드/설치·실제 접수/응답은 따로 기록한다.

공식 근거: [CLI queue 문서](https://learn.chatgpt.com/docs/cli/reference#codex-queue), [queue 명령 구현](https://github.com/openai/codex/blob/main/codex-rs/cli/src/queue_cmd.rs), [공유 대기열 처리](https://github.com/openai/codex/blob/main/codex-rs/tui/src/session_queue_commands.rs). 활성 goal의 지연과 exec 생명주기 제약은 [이슈 52705](https://github.com/openai/codex/issues/52705), [41060](https://github.com/openai/codex/issues/41060)을 참고한다. 로컬 지원 여부는 설치 버전 기준이다.

## 큐와 한도 회복 후 재개

- 사용자가 선택한 정확한 대상만 durable 큐에 기록한다. 대화 ID·작업 폴더·실행 경로·승인 범위·재개 지점·자동 재개 선택과 attempt ID를 결속한다. 새로고침이나 재부팅으로 작업을 잃거나 두 번 실행하지 않는다.
- 기존 worker와 잠금·claim·ACK를 재사용한다. 같은 대상의 동시 실행을 막고 실제 전달 성공과 새 실행 관측을 분리한다. 응답 불명인 attempt는 보존하고 지원 조회로 조정한다. blind retry나 새 대화 생성으로 이어가지 않는다.
- 한도 회복은 해당 실행 경로와 실제 계정의 신선한 quota 관측으로 판단한다. Native 한도를 OCX 계정 풀로 추정하거나 일률적인 5시간 타이머만으로 준비 완료라 하지 않는다. UI에는 관측 시각과 실제 재개 가능 여부를 표시한다.
- 사용자가 선택한 자동 재개는 한도 대기와 일시적 연결 문제처럼 허용된 사유에만 적용한다. 사용자 중지·보호 대상·승인 대기·보안 거부·결과 불명 HOLD를 자동 해제하지 않는다. 선택 해제와 큐 취소가 다음 전송 전에 반영되어야 한다.
- 지원되는 전송 수단이 없으면 큐와 재개 지점을 보존하고 보류 사유를 보여준다. 큐 등록만으로 대화가 재개됐다고 표시하지 않는다.
- 주기적 관측과 재시도 대기는 기존 호스트 스케줄러가 수행한다. 단순 상태 확인 때문에 모델에 반복 메시지를 보내지 않는다. 모델은 승인된 작업의 추론이 필요할 때만 사용한다.


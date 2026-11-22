# RDC 한도와 연결 연속성

RDC 사용량 경고, 계정 전환, 오프라인 기기와 전환 중 안내에 사용한다. PC 로그인은 CurrentUser DPAPI 저장이고 지피티 연결은 계정별 OAuth `link_id`다. 실제 도구 명세에 노출된 계정만 사용한다. 여러 연결을 유지하고 매 호출에 정확한 `link_id`를 지정한다. 이미 연결된 계정을 바꾸려고 기존 연결을 해제하거나 플러그인을 재설치하지 않는다.

## 실행과 감시

기존 독립 AICC 파일·프로세스 도구로 같은 Windows 사용자에서 실행한다. RDC 안의 명령으로 자신의 연결을 교체하지 않는다.

- `aicc-rdc`: 단일 자동 순환 담당을 시작한다. 기존 RDC 자동 시작에도 결속된다.
- `aicc-rdc -Action Quota`: 세 계정의 잔여 비율, 관측 시각·출처, 제외 사유, 공식 초기화 시각·다음 조회 시각(KST)을 읽는다. `-Profile account2`로 범위를 좁힌다. 조회가 오래되거나 실패했으면 마지막 관측과 미확인을 구분한다.
- `aicc-rdc -Action Quota -Refresh`: 공식 웹 사용량을 다시 조회하도록 단일 감시기에 접수한다. 조회 자체는 PC RDC 계정을 전환하지 않는다. 접수는 완료가 아니며 이후 Quota 또는 Status에서 각 계정의 관측 시각·checkPhase를 읽는다.
- `aicc-rdc -Action Next`: 다음 계정으로 전환을 요청한다. 기본 순서는 owner 설정의 1 → 2 → 3 → 1이다. 한도 소진·기준 이하·실제 한도 거절·미확인·오래된 관측 계정은 지정 요청에서도 제외한다. 소진 기록이 오래되었다는 이유만으로 복귀시키지 않는다.
- `aicc-rdc -Action Next -Profile account1`: 지정 계정 요청. 번호는 소유자 설정 별칭이며 신원 증거가 아니다.
- `aicc-rdc -Action Status`: 정확한 operation ID, phase, message, retryAfterMs, 대상 deviceId·connectorUserId·link_id를 읽는다. 병렬 지피티는 같은 operation을 조회하며 새 요청을 중복 실행하지 않는다.
- `aicc-rdc -Action Stop`: 현재 전환 뒤 감시만 중지한다. 기존 RDC 작업 프로세스는 유지한다.

작업 묶음 시작 또는 한도 알림 때 실제 RDC `who_am_i`를 명세의 해당 `link_id`로 호출한다. `remote_calls_left_pct`는 잔여 비율이다. 실제 사용자 ID·기기 ID를 owner 설정과 대조한다. 실제 월 한도 거절이 관측되면 Observe에 -UsageRejected를 함께 넣는다. 이 경우 VERIFYING 중에도 해당 계정을 완료 처리하지 않고 다음 계정으로 넘길 수 있다. 로컬 도구 사용 통계, 포트, 계정 순서로 대체하지 않는다. 신원이 일치하면 `Observe -Profile <별칭> -LinkId <실제 연결> -ConnectorUserId <who_am_i ID> -RemainingPercent <잔여> -ObservedAt <방금 UTC시각>`로 신호를 넘긴다. 기본 기준은 10%다. 공식 대시보드의 계정 표시와 동일 세션의 사용량 API(callsUsed/callsIncluded/resetsAt)를 별도 브라우저 작업으로 읽는다. 등록된 계정에 한해 기존 Google 로그인 선택으로 웹 표시 계정을 바꾸며 지피티 OAuth 연결과 PC 중계는 유지한다. 다른 사용자 로그인·초기 로그인·MFA·보안 거절이면 미확인으로 남기고 기존 소진 제외를 보존한다. 보안 거절의 자동 로그인 재시도는 중단한다.

자동 감시기는 사용 가능 계정을 5분마다, 소진·기준 이하 계정을 6시간마다 차례로 조회하고 공식 resetsAt가 먼저 도달하면 그 시각 직후에 다시 확인한다. 정확한 초기화 시각이 없으면 UNKNOWN으로 표시하며 월초·24시간 경과로 추정하지 않는다. 실제 신원에 맞는 잔여 비율이 기준을 초과해야 제외를 해제한다. 현재 계정은 그대로 유지하고 회복 계정은 다음 순환 후보로 복귀한다. 모든 후보가 제외되면 QUOTA_WAIT에서 기존 연결을 유지하며 회복 관측 후에만 자동 전환을 이어간다. 인증·결과 불명 HOLD와 사용자 Stop은 자동 해제하지 않는다. 모델 감시 예약은 만들지 않는다.

## 지피티의 전환 안내와 실제 호출

1. 전환 요청 전에 “RDC 계정을 전환 중입니다. 기존 작업 결과를 보존하고 연결 상태를 확인하겠습니다.”라고 짧게 안내한다. 독립 AICC는 계속 사용한다.
2. Next가 반환한 operation을 Status로 조회한다. PREPARING/SWITCHING의 message를 사용자에게 전달하고 유한하게 기다린다. 단일 담당 mutex·동일 request·기기 잠금이 겹치는 전환을 막는다.
3. VERIFYING이면 상태의 connectorEmail과 사용자 ID를 기준으로 현재 지피티 도구 명세에서 해당 계정의 link_id를 찾는다. 상태의 link_id는 다른 지피티의 연결일 수 있는 힌트다. 다른 지피티의 ID를 그대로 쓰지 않는다. 저장된 ID를 임의로 도구 인수에 넣지 않는다. 현재 명세의 새 link_id를 who_am_i로 확인했으면 Bind하여 추가한다. 여러 지피티의 연결 ID는 함께 보존한다. 같은 지피티에서 해당 link_id로 who_am_i → list_devices → 대상 기기의 승인된 최소 읽기를 호출한다. 모든 RDC 호출에 같은 link_id를 전달한다. 새 연결 등록 후 명세가 아직 갱신되지 않으면 NEEDS_LINK_REFRESH로 알리고 기존 operation을 유지한다.
4. 정확한 사용자·온라인 기기·읽기 성공을 관측한 뒤 `Confirm -OperationId <반환 ID> -Profile <대상> -LinkId <실제 연결> -ConnectorUserId <실제 ID> -DeviceId <실제 기기> -ObservedAt <방금 UTC> -ReadSucceeded`를 실행한다. 로컬 CONNECTED만으로 Confirm하지 않는다.
5. READY를 받으면 “RDC 계정 전환이 완료되어 작업을 이어갑니다.”라고 즉시 알리고 승인된 미발신 작업을 계속한다. 불명 쓰기는 다른 계정에서 반복하지 않는다.

중계만 hotRotate하여 동일 로컬 MCP child·터미널 세션을 유지하도록 구현되어 있다. 최초 유지보수 재시작과 평상시 전환을 구분한다. 실행 중 호출·원격 pending/executing·결과 불명·오래된 상태면 보류한다. 기존 call_id가 있으면 원 link_id의 get_tool_result로 조정하며 재전송하지 않는다. 전환 시간 초과도 같은 operation을 보존한다.

## 최초 연결과 실패

세 계정의 지피티 OAuth 연결을 미리 등록한다. `Connect -Profile <별칭>`는 소유한 브라우저 target lease에서 공식 Settings > Plugins > Connect another account와 Google 화면만 사용한다. 기존 연결은 유지한다. 초기 로그인·MFA·보안 거절은 명확하게 알리며 우회하지 않는다. 로그인 비밀번호를 코드·설정·로그에 저장하지 않는다.

연결이 추가되면 현재 실제 도구 명세의 link_id로 who_am_i를 읽어 신원을 확인하고 `Bind -Profile <별칭> -LinkId <명세 ID> -ConnectorUserId <실제 ID> -ObservedAt <방금 UTC>`로 결속한다. 공용 소스에 개인 계정/기기/링크를 넣지 않는다. owner 설정은 사용자 상태 디렉터리에 있다.

NEEDS_CONNECTOR_REAUTH는 해당 최초 연결 미완료다. HOLD는 실패 단계·원 operation·해제 조건을 알린다. 쓰기 결과 불명·인증 거절을 한도 소진으로 오인하지 않는다. 모든 계정이 소진되면 QUOTA_WAIT로 표시하고 공식 한도 회복을 감시한다. 끊긴 RDC 채널은 자기 안내를 보낼 수 없으므로 전환 중 텍스트는 현재 지피티 응답과 독립 AICC 상태 조회로 전달한다. 턴 밖의 채팅 메시지 자동 발신이나 표시가 보장되는 MCP progress를 가정하지 않는다.

## 수락 범위

사용자가 전환 시험을 요청한 경우 세 계정 신원·같은 지피티의 link_id별 읽기·전환 전후 동일 장기 세션·단일 전환 소유·불명 쓰기 재전송 없음·안내 텍스트·실패 시 독립 조회를 구분해 기록한다. PC 전환 통과를 이 전체 수락으로 확대하지 않는다. 로컬 스킬 배포와 Web 네이티브 설치도 별도다.

공식 근거: [여러 앱 계정 연결](https://help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts-in-chatgpt), [RDC 설정](https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md). 실제 현재 도구의 link_id 명세를 우선한다.

Reconcile -OperationId <정확한 ID>는 기존 중계 ACK와 현재 같은 기기·active=0·unknown=0을 대조해 지피티 읽기 미확인 상태를 UNVERIFIED로 남긴다. READY를 만들지 않는다. 이후 명시적인 Next로 복귀할 수 있다. unknown인 교체에는 쓰지 않는다.

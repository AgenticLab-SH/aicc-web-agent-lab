# Chrome 연결과 복구

선택 목록 방식은 supervisor capabilitiesVersion2의 등록 CDP 계약이며 일반 Chrome 확장 기반 레거시 그룹 방식과 구분한다. 등록 CDP가 응답하지 않아도 일반 Chrome이 꺼졌다고 판정하지 않는다. 기존 확장 탭만 Debugger 연결에 실패하면 현재 인벤토리·정확한 원래 URL·소유권을 회수한다. 같은 확장의 새 작업 소유 탭에서 원래 결과를 읽는 복구는 원요청 재전송이 아니며, 성공했다는 이유로 확장 vendor 결함이나 사용자 탭 종료의 인과관계를 단정하지 않는다.

## AICC 도구 호출 간격

AICC로 웹쫀쿠를 실행할 때 모든 AICC 도구 호출은 순차로 수행한다. 이전 호출의 응답이 끝난 뒤 최소 3초(3,000ms) 기다리고 다음 호출을 시작한다. 읽기, 상태 확인, 출력 폴링, 재시도와 서로 다른 탭에도 같은 간격을 적용한다. 병렬 호출이나 연속 호출로 우회하지 않는다. 서버가 더 긴 대기 시간을 요구하면 그 시간을 따른다. 이 규칙은 도구 호출 간격이며 GPT 탭 점검 주기 5분과 정체 기준 30분은 별도로 유지한다.

## Chrome 연결과 복구

- 유효한 Chrome 확장 browser binding은 유지하고 매 점검에서 그 browser의 최신 탭 메타데이터를 읽는다.
  초기 연결이 없으면 `cua.listBrowsers()` 또는 `cua.getState()`에서 `family=chrome`, `type=extension`과
  현재 browser ID·extension instance를 확인한다. 숫자 ID를 고정하거나 오래된 탭 ID로 조작하지 않는다.
  agent나 REPL 세션이 바뀌면 같은 extension instance의 숫자 ID도 달라질 수 있으므로 현재 인벤토리에 다시 결속한다.
- 탭 본문은 현재 browser ID와 최신 탭 ID를 `cua.getTab(id, { browser: currentBrowserId })`에 전달한 뒤
  `getAXState()`로 읽는다. 지원 API는 이번 도구 문서를 따르며 `getUrl()`·`getTitle()`을 추측해 호출하지 않는다.
- provider가 없거나 `Browser is not available`이면 같은 확장 인벤토리를 한 번 재조회한다. 발견되면 같은
  surface에서 계속한다. provider는 있고 탭만 실패하면 그 browser의 최신 탭 목록으로 한 번 다시 연결한다.
  빈 provider·탭 목록이나 별도 CDP 실패를 Chrome 종료·로그아웃으로 보고하지 않는다.
- 시간 초과·kernel reset 뒤에는 직전 동작 결과를 미확인으로 둔다. 현재 도구 문서와 같은 확장의 인벤토리로
  기존 exact tab ID·conversation URL·작업 소유권을 회수하고, 탭 생성·이동·제출 묶음을 그대로 재실행하지 않는다.
  응답 불러오기 오류도 원요청 실패의 증거가 아니다. 같은 URL의 처리 결과와 도구 실행 흔적을 먼저 읽으며
  미확인 원요청은 재전송하지 않는다. 세부 절차는 `use-web-gpt/references/surface-selection.md`를 따른다.
- 재발견도 실패하면 `use-web-gpt/references/surface-selection.md`의 읽기 전용 확장 진단으로 실행·설치·
  native host·연결 상태를 구분한다. 실제 worker/handshake를 확인하지 못하면 원인을 미확인으로 남긴다.
  Chrome·확장 재시작, 새 profile, 계정 전환이나 vendor cache 편집을 자동 복구로 수행하지 않는다.
- 사용자 Chrome을 다른 CDP 포트나 프로필로 우회 연결하지 않는다. 명시된 레거시7개 방식에서는 그룹명이 `GPT`가 아니거나 지정 탭의 `tabGroup`을 확인할 수 없으면 조작하지 않는다. 사용자 선택 방식은 exact 대화 URL·등록 account/workspace binding을 기준으로 하며 그룹7개를 추가 조건으로 요구하지 않는다.


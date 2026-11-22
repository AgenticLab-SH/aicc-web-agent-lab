# 계정·탭 소유권 상세

## 계정·탭 소유권

- 탭을 열기 전에 기존 작업 원장에 목적·owner·exact saved URL·수명(`temporary`/`persistent`)·종료 조건을 정한다. `temporary`는 결과 인수와 작성권 반환 후 닫으며 saved URL로 재개한다. `persistent`는 실제 진행 중 응답 관찰이나 바로 이어질 입력처럼 화면을 유지할 구체적 이유와 다음 해제 사건을 적는다. 대화에 후속 일이 있다는 이유만으로 탭을 계속 열어두지 않는다.
- 같은 계정·대화의 화면은 대표 탭 하나를 기본으로 한다. 지원되는 exact 소유 탭 재사용을 먼저 확인하고, lease 계약 때문에 새 target이 필요하면 새 target을 대표로 넘긴 뒤 이전 소유 target을 반환한다. 새 탭을 만든 동작의 성공·실패·중단 경로 모두에서 종료 또는 보존 영수증과 실제 남은 탭 수를 확인한다. 종료 정책을 정하지 못하면 불필요한 탭을 먼저 만들지 않는다.
- 일반 Chrome과 registered CDP 모두 대화의 남은 목적과 현재 화면의 필요성을 GPT 또는 Codex가 판단한다. 응답 완료·오래된 탭·비활성만으로 불필요 판정하지 않는다. 후속 개발·검증·복구·인계가 남은 저장 대화는 `continue`로 유지하고 같은 saved URL을 재사용한다. 화면 역할이 끝나고 결과와 작성권을 인수한 소유 탭은 닫을 수 있으며, 대화 자체의 역할까지 끝난 경우에만 `conversation-use retired`로 기록한다.
- 종료 판단에는 exact 대화 URL·owner·남은 일 또는 종료 이유를 기존 작업 원장에 남긴다. 등록 CDP의 `chatgpt:collect-and-close` / `chatgpt:close-completed`에는 역할이 끝난 경우만 `--conversation-use retired`를 전달한다. 기본은 보존이며 생성·초안·첨부·메시지 불일치 검사는 계속 적용한다. 탭 종료와 저장 대화 삭제는 별개다.
- 저장 대화를 이어갈 필요와 중복 탭을 유지할 필요를 구분한다. `saved-followup` 후에는 원 요청을 관찰할 대표 탭 하나를 기록하고, 결과·작성권을 인수한 이전 중복 탭은 [저장 대화 중복 탭 정리](execution-contract.md#저장-대화-중복-탭-정리)로 반환한다. 예전 종료 도구가 새 영수증을 지원하지 않으면 그대로 보존됐다고 기록하며 종료 완료라 하지 않는다.
- surface·계정·탭 예산·기존 탭을 언급하면
  [`references/surface-selection.md`](surface-selection.md)를 읽고 exact 경로와 소유권을 먼저 고정한다.
- agent는 자신과 하위 agent가 연 역할 종료 탭만 닫고 slot을 반환한다. 사용자·다른 task의 탭은
  조작하거나 닫지 않는다. 후속 작업·사용자 인계·불명 상태의 탭은 이유와 exact URL을 남겨 보존한다.
  root agent는 종료 전에 하위 agent의 소유 탭까지 같은 기준으로 판단한다.
- 새로 만든 task-owned 탭의 새 일반 Chat(기존 user/assistant turn 0)에서는 복원된 입력 초안과 미제출 첨부를 해당 form의 실제 제거 제어로 정리하고 이번 prompt·첨부로 준비할 수 있다. 초안의 작성자 불명만으로 재승인을 요구하지 않는다. 기존 사용자·다른 task 탭과 저장 대화를 이어가는 탭은 예외에서 제외한다. 자세한 경계는 references/surface-selection.md를 따른다.
- 명시된 CDP 포트는 account 별칭보다도 강한 실행 제약이며 다른 Chrome·인앱 Browser로 대체하지 않는다.
- ordinary registered-CDP Chat에 다른 Codex task 수나 17841 non-browser HTTP 수를 gate로 쓰지 않는다.


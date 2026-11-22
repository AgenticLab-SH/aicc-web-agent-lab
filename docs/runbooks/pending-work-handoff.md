# 지피티 → 코덱스 작업 인계함

기존 owner-local `pending-work`를 요청당 문서 하나로 사용한다. 개인 실제 경로는 소유자 상태의 `pending-work/README.md`에서 찾는다. 제품 task·goal·execution과 별도의 실행 원장을 만들지 않는다.

## 보내는 사람

확인된 지피티 표시 이름, 정확한 원 대화 URL, 이름을 확인한 근거, 우선순위 P0~P3, 대상 Git root·선택한 Codex thread, 목적·이미 완료된 근거·다음 행동을 기록한다. 이름을 직접 알 수 없으면 `미확인(사용자가 전달한 지피티)`로 표시하고 추측하지 않는다. 계정 번호나 CDP 포트는 이름·신원의 증거가 아니다. AICC Workspace에 등록된 경로와 실제 grant로만 접근한다.

기존 helper `node tools/platform/aicc/pending-work.mjs register --input <absolute-json>`를 사용한다. 기본 폴더는 기존 AICC 개인 상태의 `pending-work`다. JSON 필드는 `id`, `title`, `priority`, `origin:{displayName,conversationUrl,identityEvidence}`, `projectRoot`, 선택 `targetThreadId`, `objective`, `nextAction`이다. 원문 대화·비밀번호·토큰·프로필은 넣지 않는다. 동일 ID·동일 내용은 기존 문서를 반환하고 다른 내용은 충돌로 거절한다.

## 받는 사람

`list`로 우선순위·등록순 목록과 이전 형식 문서를 확인하고 `read --id ID`의 SHA를 사용한다. 다른 작성자의 실제 파일 범위와 진행 작업을 먼저 확인한다. 읽기와 보고에는 작성권 반환 절차를 추가하지 않는다.

`transition --id ID --input <absolute-json>`의 입력은 `expectedSha256`, `owner`, `action`이다. `claim`은 PENDING→CLAIMED, `merge`는 CLAIMED→MERGED이며 기존 제품 정본의 `canonicalPath`·`canonicalSha256`을 함께 받는다. 정본에 원 요구·현재 상태·owner·다음 행동을 실제 합친 뒤 merge한다. 이 상태는 개발 완료를 뜻하지 않는다.

인수 문서가 더 필요 없으면 `archive`로 기존 `receipts/pending-work`에 원문 그대로 옮긴다. archive 폴더는 소유자가 명시적으로 준비한다. 정본 SHA가 바뀌었으면 원 결과를 재검토하고 조정한다. 자동 영구삭제·원본 덮어쓰기·과거 요청 재송은 하지 않는다. 기존 형식 문서는 자동 변환하거나 지우지 않는다.

## 실행 큐와 구분

등록·인수는 전송이 아니다. 정확한 대화를 선택하고 승인된 정식 sender로 전달한 뒤 원 attempt의 접수·새 turn·실도구·결과를 각각 확인한다. 작업의 명시 완료와 단일 turn 종료를 구분한다. 사용자 수동 완료는 보류 작업의 정리/다음 배정 판단만 바꾸며 살아 있는 실행·불명 전달·사용자 stop·권한 거절을 지우지 않는다.

한도 대기 시 원 issuer의 fresh quota/admission 전에는 다음 입력을 dequeue하지 않는다. 이미 dispatch된 원요청을 다른 계정이나 새 ID로 재생하지 않는다. 기존 continuity/goal/큐의 정식 계약을 재사용한다. 파일 수정 시각·lease만으로 지피티와 코덱스를 구별하거나 실시간 작업이라고 주장하지 않는다. 등록된 exact URL/실행 ID의 현재 도구 이벤트와 관측 시각을 표시하고 자료가 없으면 미확인으로 둔다.

helper는 문서 관리만 수행하며 sender·scheduler·모델 호출·추가 grant를 만들지 않는다. Workspace에 helper 호출이 제공되지 않았다면 문서 작성은 가능하더라도 자동 전달 지원으로 보고하지 않는다.

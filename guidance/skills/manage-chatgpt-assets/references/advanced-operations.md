# ChatGPT 자산 관리: 예외·삭제·검증

## 변화 대응

- API response shape, semantic locator, confirmation text, permission 또는 signed-in identity가 변하면 추측해
  우회하지 않고 `HOLD_INTERFACE_DRIFT` 또는 구체적인 mismatch로 중단한다.
- port/account mapping을 코드에 박지 않고 exact task-owned target과 session hash를 확인한다.
- name 변경은 stable ID가 같을 때만 update 후보가 된다. 같은 이름의 새 자산을 자동 생성하지 않는다.
- endpoint/UI 동작이 불명확하면 read-only inspection과 fixture부터 갱신하고 mutation으로 탐색하지 않는다.
- create/save dispatch 뒤에는 exact post-read를 한 번 수행한다. post-read가 불명확하거나 mismatch이면 `POST_READ_UNCLEAR` 또는 구체적 `HOLD`로 끝내며 같은 create/save를 자동 재시도하지 않는다.
- Notion은 lifecycle/priority/운영 mirror다. connector가 없으면 브라우저로 우회하지 않고 로컬 journal과
  `HOLD_NOTION_CONNECTOR`를 남긴다.

수명주기는 [`references/notion-registry-contract.md`](references/notion-registry-contract.md)를 따른다.
승인 전에는 inventory·설계만 하며 remote·Notion 결과를 서로 대신하지 않는다.

## 삭제

후보 발견은 권한이 아니다. exact 목록을 보고하고 승인된 stable ID만 manifest에 넣는다. 대화와 Source의
손실 승인·복구 가능한 backup/증류를 고정한다. 직전 inventory hash, review ID, identity/workspace, ID, 이름,
권한, 대화·Source 수 중 하나라도 달라지면 삭제하지 않는다.

삭제는 1건씩 수행하고 매번 대상 부재와 비대상 자산 보존을 post-read한다. 응답이 불명확하면
`submission_uncertain`으로 중단하며 같은 항목을 자동 재시도하지 않는다. 자세한 형식과 recovery는
[`references/execution-contract.md`](references/execution-contract.md)를 따른다.

## 증거와 결과

- secret, 원문 이메일, session token, browser lease, profile을 Git/Notion/evidence에 넣지 않는다.
- owner-only evidence에는 identity binding hash, plan/review ID, stable ID, action, before/after 판단과
  `foreignTargetsTouched`만 기록한다.
- 결과는 `PASS`, `HOLD`, `UNKNOWN`을 분리한다. read-only inventory PASS를 Instructions/Source sync PASS로
  확대하지 않는다.
- logical Project 수와 계정별 physical replica 수를 구분한다.

범위: [`references/trigger-boundaries.md`](references/trigger-boundaries.md).

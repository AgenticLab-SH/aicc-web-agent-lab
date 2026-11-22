---
name: run-evidence-gated-ai-development
description: 긴 AICC 개발·복수 writer 작업을 체크포인트·작성권·근거·사람 개입 기준으로 운영한다.
---

# 검증 중심 AI 개발

오래 실행되거나 여러 writer가 참여하는 AICC 개발을 재개 가능하게 운영한다. 일반적인 단일
writer 구현, 작은 수정, 단순 설명에는 이 스킬을 끼워 넣지 않는다.

## 책임 분리

- 큰·교차·모호한 변경의 목표와 요구사항은 `develop-from-project-spec`의 현재 `intent.md`와
  `spec.md`가 소유한다. 이 스킬은 경쟁하는 의도·명세·상태 문서를 만들지 않는다.
- 현재 변경의 수락된 intent/spec이 있으면 그 문서와 직접 연결된 plan/tasks만 읽는다. 없고
  별도 intent가 필요한 작업이면 먼저 `develop-from-project-spec`로 넘긴다.
- 이 스킬은 실행 checkpoint, writer 소유권, 피드백, 사용자 개입과 완료 증거를 소유한다.
- 복구가 비싼 mutation은 `high-risk-change`의 짧은 대상·검증·복구 계약을 함께 적용하되 같은
  승인을 반복하지 않는다.

복잡한 분해나 병렬 실행 계약이 실제로 필요할 때만 [작업 계약](references/spec-and-task-contract.md)을,
custom harness나 여러 writer를 설계할 때만 [하네스와 오케스트레이션](references/harness-orchestration.md)을
읽는다.

## 실행

1. 현재 intent/spec의 범위, 제외, 성공 기준과 증거를 확인한다. 별도 문서가 필요 없는 작업은
   대화의 구체적인 결과와 경계를 그대로 사용한다.
2. 한 writer가 독립적으로 변경하고 검증할 수 있는 단위로만 나눈다. 병렬화는 상위 지침이
   허용하고 소유권·입출력·통합자가 분명할 때만 쓴다.
3. 관련 코드와 현재 runtime을 확인하고 `예상 -> 구현 -> 관련 검사 -> 실제 결과 -> diff 판단`
   을 반복한다. 입력이나 근거가 바뀌지 않은 같은 실패는 반복하지 않는다.
4. 현재 revision과 연결된 증거만 완료 판단에 쓴다. 에이전트의 성공 문장이나 오래된 로그는
   독립 증거가 아니다.
5. 재개에 필요한 결정, 완료/미착수, `HOLD` 원인과 다음 행동만 기존 정본에 갱신한다. 도구
   출력, 진행 일지와 Git 이력을 다른 문서로 복제하지 않는다.

## 사용자 개입

허용된 코드·CLI·API·MCP·브라우저 경로를 먼저 사용한다. 현재 화면 조작을 사용자가 명시적으로
허용했고 정확한 앱·행동 범위가 맞을 때만 Computer Use를 검토한다.

자동 경로가 모두 막히고 CAPTCHA, MFA/OTP, UAC, 생체·물리 확인, 비밀 입력, 법적 동의, 결제
확인 또는 소유자 판단만 남으면 `aicc intervene plan --json`으로 판정한다. 결과가
`continue_automatic` 또는 `use_computer`이면 그 경로를 계속하고, `notify_user`일 때만
`notify-user`의 긴급도와 중복 방지 절차를 사용한다. 사용자는 원래 Codex 작업에서 답하며,
기다리는 동안 독립적인 안전 작업은 계속한다.

통상 진행, 계획과 변화 없는 대기는 보고하지 않는다. 개입·요청·최종 결과만 짧게 알린다.

## 완료

스킬·에이전트·하네스의 행동을 개선할 때는 필요시 실제 성공·실패와 `near-miss` 비호출 사례를
같은 입력·revision 기준으로 비교한다. 스킬 호출 경계와 충돌 판단은
`aicc-guidance-review/references/trigger-evals.md`를 재사용하고 새 평가 원장·상시 서비스는 만들지 않는다.

위험에 맞는 요구사항 대조, 자동 검사, 실제 응답·UI·배포 post-read, 보안 또는 사람 검토를
조합한다. 보안·평가·상태 언어가 필요한 경우에만 [증거와 평가](references/evidence-security-and-evaluation.md)를
읽는다. `DONE`, `safe`, `deployed`, `submitted`는 현재 변경과 연결된 근거가 있을 때만 쓴다.

최종 답에는 결과, 실행한 검증과 중요한 잔여 위험만 남긴다. 코드 줄 수, 토큰 수와 에이전트
수는 성과 지표가 아니다.

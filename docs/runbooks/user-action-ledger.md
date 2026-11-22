# 사용자 할 일 원장

## 목적

사용자가 답변이나 작업 요청을 놓쳐도 필요한 일이 대화와 함께 사라지지 않게 한다. 활성 항목은
로컬 관제 화면에 남고, 완료 근거가 생기면 화면에서 빠지며 사건 이력에는 계속 남는다.

## 사용

작업을 시작할 때 전체 원장을 한 번 읽고 자기 파트만 사용한다.

```powershell
aicc user-action status --json
```

새 사용자 행동이 필요하거나 설명이 바뀌면 안정된 같은 `id`로 기록한다. 같은 내용은 중복되지 않는다.

```powershell
$request | ConvertTo-Json -Compress | aicc user-action add --json
```

필수 입력은 `id`, `part`, `partTitle`, `title`, `ask`, `why`, `steps` 1~3개와
`completionCriteria`다. 에이전트의 다음 행동은 `agentNext`, 출처는 `sourceRef`, 특정 날짜 뒤에만
가능한 일은 `availableAfter`에 둔다. 비밀, 대화 원문과 긴 로그는 넣지 않는다.

## 막힘 판단

기본 상태는 `OPEN`이다. 사용자 응답 없이도 가능한 조사·코드·검증이 하나라도 남으면 그대로 둔다.
다른 안전한 일을 도저히 진행할 수 없을 때만 같은 `id`를 `state: "BLOCKING"`으로 갱신한다.
이때 `safeWorkRemaining: false`와 쉬운 `blockingReason`이 없으면 기록이 거부된다. 화면은 이 항목을
맨 위에 두고 “이것부터 필요”라고 표시한다.

## 완료

사용자가 화면에서 “완료했어요”를 누르거나 에이전트가 실제 결과를 확인한 뒤 완료한다.

```powershell
@{ id='UA-02-EXAMPLE'; evidence='완료된 결과를 정본에서 확인했습니다.' } |
  ConvertTo-Json -Compress | aicc user-action complete --json
```

성공 기준은 `removed: true`, 활성 목록에서 해당 `id`가 사라짐, 사건 이력의 `COMPLETED` 기록이다.
잘못 완료했다면 사건 이력을 근거로 같은 `id`를 다시 기록한다. 원장 파일을 직접 고치지 않는다.

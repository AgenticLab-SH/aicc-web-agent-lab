# GPT 그룹 탭 7개 감시 기록

`scripts/monitor-state.mjs read`로 설정과 직전 기록을 확인한다. 대상은 Chrome 탭 그룹 `GPT` 안의 정확한 일곱 ChatGPT conversation ID다. 그룹 이름과 그룹 소속을 확인할 수 없거나 ID가 하나라도 빠지거나 중복되면 조치하지 않고 영수증도 쓰지 않는다.

실행 기록에는 확인 시각, 조치, 그룹 이름, 현재 기준 탭 ID, 일곱 탭의 상태·진행 시각·작업 지문만 저장한다. 대화 본문, URL, 입력란 내용은 저장하지 않는다. 작업 지문은 답변 변화와 중복 방지를 확인하는 로컬 값이다. 생성 중 상태는 화면의 진행 표시와 중지 버튼으로 확인한다.

```json
{
  "schemaVersion": 7,
  "targetSetId": "chatgpt-chrome-tab-group-gpt-7-v5",
  "groupName": "GPT",
  "anchorTabConversationId": "00000000-0000-4000-8000-000000000000",
  "lastCheckedAt": "2026-09-26T00:00:00.000Z",
  "lastAction": "none",
  "targets": [
    {
      "tabIndex": 1,
      "title": "해커톤 분석 정리",
      "conversationId": "00000000-0000-4000-8000-000000000000",
      "state": "idle",
      "lastObservedAt": "2026-09-26T00:00:00.000Z",
      "lastProgressAt": null,
      "workingSinceAt": null,
      "progressFingerprint": null,
      "handledSignalFingerprint": null
    }
  ]
}
```

실제 `targets`에는 일곱 탭 모두가 있어야 한다. 이전 schema의 영수증은 보존하되 GPT 그룹의 현재 상태 증거로 재사용하지 않는다.

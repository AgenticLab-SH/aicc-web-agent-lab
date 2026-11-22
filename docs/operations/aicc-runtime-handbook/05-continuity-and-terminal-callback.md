# 작업 연속성과 Terminal callback

장기 변경은 Desktop 프로세스나 화면이 계속 살아 있는지에 의존하면 안 된다. AICC의
foreground rescue guardian은 다음 순서를 고정한다.

```text
arm exact task/root/result/hash contract
  -> visible one-shot Terminal worker
  -> normal Desktop quit/restart when required
  -> owner-only durable result written atomically
  -> Native/shared-daemon exact callback turn_started
  -> same task continues from result
  -> exact Terminal closes
```

## 안전 계약

- task ID, canonical project root, future result path, operation ID, accepted terminal states와 TTL을
  시작 전에 고정한다.
- callback executable과 App Server manifest bytes를 SHA-256으로 pin한다.
- active/UNKNOWN task에는 callback을 보내지 않는다.
- `turn/start`의 수락 여부가 모호하면 재전송하지 않는다. 알려진 turn ID만 reconcile한다.
- callback은 결과 원문 대신 operation, status, path와 hash만 전달한다.
- Terminal worker는 LaunchAgent, cron, heartbeat 대체물이 아닌 유한 one-shot guardian이다.

## 비상 경로

1. Desktop이 살아 있고 shared daemon socket이 검증되면 같은 writer를 통한 callback을 쓴다.
2. Desktop이 종료됐다면 pinned Native rescue executable의 owned-stdio App Server를 쓴다.
3. 17841이 exact idle·ready일 때만 Web GPT advisor를 한 번 호출할 수 있다. 이 응답은 조언
   증거일 뿐 로컬 mutation 권한이 아니다.
4. guardian도 실패하면 owner-only result와 recovery mirror를 보존하고 HOLD로 끝낸다. 사용자는
   exact callback inspect 또는 문서화된 수동 복구 명령 한 번만 실행한다.

무한 대기 Terminal, PID 이름 기반 kill, 여러 watcher가 같은 task에 메시지를 보내는 구조는
사용하지 않는다. 진행 표시는 KST 시각, 현재 단계, 경과 시간, 다음 bounded timeout과 마지막
내구 checkpoint를 주기적으로 갱신하되 작업 성능을 방해하지 않는 낮은 빈도로 출력한다.

세부 명령과 rollback은 `docs/runbooks/codex-terminal-task-callback.md`를 따른다.

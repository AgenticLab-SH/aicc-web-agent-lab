# 내구 작업과 산출물 운영 경계

AICC의 긴 작업은 대시보드 프로세스나 모델 route의 수명과 분리된 상태로 기록한다.
정본 메타데이터는 `${AICC_STATE_ROOT:-~/.ai-control-center}/jobs` 아래 소유자 전용
snapshot과 append-only WAL에 저장된다. WAL을 `fsync`한 뒤 snapshot을 원자 교체하므로
snapshot 직전 프로세스가 종료되어도 다음 시작에서 마지막 정상 record를 replay한다.
저장 형식은 schema version, integrity 점검과 owner-only backup manifest를 가진다.

Job Manager에는 raw prompt/response, transcript, token, cookie, password, browser profile이나
전체 tab content를 저장하지 않는다. 요청·checkpoint·evidence·산출물은 비민감 ref와 SHA-256만
기록한다. provider의 인증·conversation state는 해당 adapter owner에 남는다.

## 상태와 lease

```text
queued -> leased -> running -> verifying -> completed
                    |   |          |
                    |   +-> paused +-> failed
                    +------> cancelled
```

- 같은 `workspaceId`에는 활성 write lease가 하나뿐이다.
- read-only rescue는 writer가 있어도 별도 job으로 실행할 수 있다.
- heartbeat가 만료된 attempt는 자동 재실행하지 않고 `paused`로 복구한다.
- resume은 새 attempt를 만들며, route failover는 이전 attempt를 `superseded`로 만든 뒤
  route, identity, reason과 승인 policy를 명시해야 한다.
- 외부 부작용은 job-scoped idempotency key로 먼저 reserve한다. restart 뒤 같은 key는
  기존 record를 반환하므로 publish/write를 다시 실행하지 않는다.
- 역할 DAG는 기본 fan-out 2–3, hard cap 5 이하이고 writer role은 최대 하나다.
  browser-only run은 로컬 writer role을 선언할 수 없다.

## 산출물 완료 조건

Artifact Registry는 input ref/hash, generator tool/version/route, output ref/hash/media type,
sensitivity, rollback ref와 검증 결과를 함께 저장한다. 파일 존재만으로 완료하지 않는다.
code test는 shell 없이 실행하고 stdout/stderr 본문은 저장하지 않는다. PDF는 `%PDF-` magic과
별도 render evidence를, browser 결과는 별도 visual evidence를 요구한다. 검증 뒤 output hash가
바뀌거나 파일이 사라지면 evidence는 stale이 되고 job completion은 거부된다.

## 읽기 전용 운영

```bash
aicc job status --json
aicc job list --json
aicc job show <job-id> --json
aicc task run jobs.status --json
npm run smoke:jobs
```

상태 조회는 저장소가 없을 때 디렉터리를 만들지 않는다. 저장소 손상은 `job-manager` 구성요소만
`attention`으로 격리하며 Web GPT, Native, OCX와 Workspace MCP를 재시작하지 않는다.

복구 시에는 먼저 `aicc job status --json`과 backup manifest의 state hash를 확인한다.
활성 writer가 없고 정확한 job ID가 확인된 뒤에만 pause/resume/cancel을 수행한다. Phase 07의
public CLI는 의도치 않은 mutation을 막기 위해 상태 조회만 제공하며, 실제 실행 coordinator는
동일 Job Manager API와 단일 writer lease를 사용해야 한다.

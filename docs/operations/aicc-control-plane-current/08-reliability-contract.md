# AICC 반복 문제 제거 계약

상태: **production design contract — 2026-09-26**

## 목적

기존 작업에서 반복된 문제를 개별 패치가 아니라 시스템 계약으로 제거한다.
대상: 긴 대화/세션 중단, 여러 AI 충돌, Computer Use focus theft, 느린 반복 probe, 파일 오삭제/덮어쓰기, CDP 충돌, 로그인/session 만료, 불확실한 mutation 재시도, daemon 중복 실행.

## 1. Continuity — 대화가 끊겨도 작업은 끊기지 않는다

모든 장기 작업은 AICC Work Ledger에 objective, constraints, decisions, completed, current, evidence, remaining, next gate, rollback, active leases를 지속 기록한다.
chat transcript는 source of truth가 아니다.
의미 있는 mutation/검증 뒤 ledger를 갱신하고 새 AI/session은 ledger -> live evidence 순으로 재개한다.

## 2. Multi-agent safety — 하나의 자원에는 하나의 writer

AICC Resource Lease를 workspace뿐 아니라 browser/UI/deploy/file mutation까지 확장한다.
같은 workspace writer 2개, 같은 browser profile controller 2개, 같은 foreground window mutator 2개, 같은 credential store writer 2개를 금지한다.
다른 workspace나 read-only reader는 policy가 허용하는 범위에서 병렬 처리한다.

## 3. Focus safety — background first

AICC Focus Guard 실행 순서:
1. direct API/plugin/MCP
2. filesystem/CLI
3. UI Automation/CDP
4. hidden/background browser
5. Computer Use foreground
6. coordinate click fallback

foreground 사용 전 exact app/window + focus lease + expected postcondition을 요구한다.
실행 후 원래 focus를 가능한 범위에서 복구한다.

## 4. Browser isolation — 자동 slot allocator

AICC Browser Pool은 slot, CDP port, profile root, browser PID/start token, target IDs, owner task, expiry를 registry에서 관리한다.
동시에 여러 AI가 웹을 다룰 때 서로 다른 slot을 자동 할당한다.
daily user Chrome과 automation profile을 분리하고 task-owned tab만 close/navigate한다.
stale slot은 PID만 보지 않고 process start identity와 registry generation으로 reconcile한다.

## 5. File safety — delete를 기본 작업으로 보지 않는다

AICC File Guard destructive ladder:
1. read/inspect
2. write new file
3. copy/backup
4. move to quarantine
5. replace with receipt
6. exact proof가 있을 때만 delete

필수: root containment, exact target, symlink/junction check, preimage, hash, post-read, recovery path.
`git reset --hard`, `git clean -fd`, broad recursive delete는 explicit task contract 없이 금지한다.

## 6. Idempotency / no replay

mutation은 request ID를 가진다.
success -> replay deny.
explicit fail before dispatch -> safe retry 가능.
uncertain dispatch -> 자동 retry 금지.
reconcile/post-read 후 다음 행동을 결정한다.
Web turn, command, file mutation, browser action에 동일 원칙을 적용한다.

## 7. Performance — fast path와 bounded probe

느린 작업을 줄이는 순서:
- cacheable health snapshot
- batched read/read_many
- bounded search
- exact state registry
- repeated full-tree scan 금지
- repeated auth/login probe 금지
- persistent remote connection

지표: tool p50/p95, connect/reconnect, queue wait, file read throughput, browser action latency, cold/warm startup.
slow threshold를 넘으면 기능 추가보다 병목 제거를 우선한다.

## 8. Session continuity / auto-login

AICC Auth Broker는 existing authorized session restore, 공식 refresh, browser profile binding, expiry detection, service restart reconnect를 담당한다.
자동화 금지: MFA/CAPTCHA 우회, account protection 우회, password extraction, quota 회피용 계정 전환.
human action이 필요한 경우 최소한의 정확한 단계만 요청한다.

## 9. Self-healing startup

AICC Relay / Endpoint / Web Bridge는 boot/logon start, duplicate-instance lock, health/readiness, bounded reconnect, stale PID/start-token detection, safe restart, rollback receipt를 가진다.
PID 존재만으로 healthy를 판단하지 않는다.

## 10. Provenance-first upstream adoption

upstream을 그대로 production에 넣지 않는다.
1. pinned revision
2. license/source receipt
3. isolated fork/vendor root
4. AICC naming adapter
5. unnecessary capability disable
6. AICC policy integration
7. focused tests
8. fault tests
9. immutable candidate
10. rollback

## Acceptance fault suite

- ChatGPT 세션 중단 후 resume
- Windows reboot
- A1 restart
- network disconnect/reconnect
- duplicate AI writer
- stale resource lease
- PID reuse
- browser port collision
- user focus active
- file target mismatch
- symlink/junction escape
- uncertain dispatch
- expired login/session
- secret/log scan
- partial deploy rollback
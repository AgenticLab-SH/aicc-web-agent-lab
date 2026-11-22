---
name: web-codex-handoff
description: 정확한 Web URL·Codex thread로 양방향 위임·재개를 연결한다. 기존 Observer·원장·검증된 일회 callback 사용. 숨은 worker 금지.
---

# Web GPT <-> Codex exact-task handoff

## Roles and constraints

- Web GPT: research, reasoning, synthesis, review and task coordination; use authorized AICC local tools directly when cheaper. Codex: repository changes, local coding, implementation and tests when necessary.
- Reuse `use-web-gpt`, `codex-web-low-token-workflow`, AICC Observer, `codex-task-callback`, and the existing job/attempt ledger. The historical `web_gpt_followup_enqueue` has **no current Chrome extension dispatcher** (retired 2026-10-11), so queueing alone cannot deliver a message. Never create another ledger, context compressor, permanent AI worker, route or account.
- Codex/ChatGPT perform their own context compression. Retain the existing `/v1/responses/compact` **protocol** endpoint where Codex still requires it. Do not implement a second communications-summary pipeline.

대화간 전달의 필요성·시점과 결과 선별은 [기존 전달 규칙](../control-project-work/references/dispatch-and-recovery.md#대화간-전달과-결과-선별)을 따른다. 다른 대화의 결과를 현재 작업에 자동 합치지 않는다.

## Bind the exact sessions

1. Observe the signed-in ChatGPT account/project and real conversation URL (normally `https://chatgpt.com/c/<uuid>` or its observed project-prefixed form). A URL is not proof of access, messaging or an event.
2. Read the real Codex thread UUID and project root from Codex App Server/session metadata. `codex://threads/<uuid>` is a navigation hint; verify this client can open it. It is **not** a dispatcher.
3. Record the immutable request ID, both links (or unbound), origin/destination owners, root/branch/HEAD, exact owned paths and exclusions, result contract, event/watch ID, SHA-256, callback ID, state and next action in the current task receipt or work ledger. Never copy private transcripts or forge a link.

## Web GPT -> Codex

1. Use authorized AICC/RDC direct local operations if sufficient; check the exact write lease and protect others' dirty files. Dispatch to Codex only when a Codex task is genuinely needed.
2. In a supported **outer Codex** turn, exchange its actual issued `turn_token` via `codex_bind_turn`; use the resulting `binding_id` with `codex_task_list_projects|create|send|wait|read`. These task tools are unusable from an external Web GPT chat lacking that turn-bound token. Do **not** guess, extract or reuse a token. Otherwise use a separately advertised authorized Codex App Server/CLI sender; `aicc_codex_session_info` is read-only.
3. Pass a bounded objective, actual origin ChatGPT URL, root, one writer's paths, constraints, tests and short-result format; keep independent research moving without touching Codex-owned files.
4. At terminal completion, write an atomic owner-local JSON receipt with `operation`, `codexTaskId` (actual thread UUID), `projectRoot`, `status` (`PASS|HOLD|FAIL`), and SHA-256. For an exact completed **CDP parent watch**, use the bounded `chatgpt-exact-cdp-followup-cli.mjs` transport from the verified codex-chatgpt-web private repository: first `--plan`, then one explicitly authorized call without `--plan` with exact role, watch, owner, conversation URL, terminal receipt SHA, task UUID, operation, request ID and private one-shot journal. The transport rechecks the policy-bound logged-in account, unchanged last user/assistant turn, owned tab and saved response; only `VERIFIED_DELIVERED` proves dispatch. The old `send-codex-result-to-webgpt.mjs` only enqueues to a retired extension and must **not** be used for live delivery. Missing watch/account/terminal proof means `AWAITING_DELIVERY` and no guessed link or retry.

## Codex -> Web GPT

이 단계는 [상세 절차](references/aicc-contract.md)의 같은 절을 읽고 수행한다.

## Safety and acceptance

- States: `PLANNED`, `DISPATCHED`, `RUNNING`, `TERMINAL`, `DELIVERED`, `VERIFIED`, `HOLD`, `FAILED`, `CANCELLED`, `DELIVERY_UNCERTAIN`. Only exact event and result hashes advance state.
- One task/request ID, one writer per file, one completion follow-up; no duplicate send if UI or `turn/start` is uncertain. Never interfere with active Codex sessions, user-owned Chrome tabs, OCX, routes 17841/10100, or independent 9336.
- Scope, login, callback, tool, independent rescue or identity missing: HOLD with observed blocker, resume condition and owner; no tool/account/route substitution. Follow `codex-rescue-preflight` before self-disruptive maintenance.
- See [AICC integration](references/aicc-contract.md) and [acceptance matrix](references/acceptance.md). Report separate proofs for installation, actual dispatch, callback, verified follow-up, code tests and runtime deployment. Never equate skill existence with bidirectional E2E.

## 변경과 결과의 선택적 반영

이 단계는 [상세 절차](references/aicc-contract.md)의 같은 절을 읽고 수행한다.


## 지피티 이름과 우선순위를 보존한 문서 인계

기존 owner-local pending-work의 한 요청·한 문서와 AICC docs/runbooks/pending-work-handoff.md를 따른다. 확인된 지피티 표시 이름·exact 원URL·관측 근거·우선순위·대상Codex thread를 기록한다. 이름은 추측하지 않고 미확인을 표시한다. claim 후 제품 정본에 원요구·현재상태·다음owner를 합치고 SHA근거로 merge·보관한다. 인수는 개발완료나 발신이 아니다. 기존 helper와 원sender/queue/goal을 재사용하고 새 중앙원장·상시모델polling을 만들지 않는다. 수동완료는 살아있는 실행·UNKNOWN·사용자stop을 해제하지 않는다.

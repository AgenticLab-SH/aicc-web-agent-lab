# AICC collaboration contract

Source-inspected AICC entrypoints; do not assume availability in every browser or host session.

- Codex -> Web GPT: `use-web-gpt` + the exact registered Web GPT observer watch. The installed `src/web-gpt-watch-callback.mjs` implements terminal-watch wait and `CodexTaskCallbackService` completion. Invoke through `aicc web-gpt-callback wait --watch WATCH_ID --callback CALLBACK_ID` only when supported and pre-armed.
- Codex target: `src/codex-task-callback.mjs` exposes `aicc codex-callback arm|inspect|complete|cancel`; callback code validates project root, task UUID, manifest, executable identity, idle writer, operation and result SHA-256. A pinned terminal result alone does not prove a thread was resumed.
- Web follow-up: **Do not use** historical Observer `POST /api/followups` for delivery. It only queues a Chrome-extension record; the extension was retired 2026-10-11. `src/codex-to-web-gpt-followup.mjs`/old CLI return `QUEUED_NOT_DELIVERED` and must never be reported as sent. Use a real completed CDP parent watch and the new private `scripts/chatgpt-exact-cdp-followup-cli.mjs`: secure Codex terminal JSON `{operation,codexTaskId,projectRoot,status}`, exact SHA-256, role-approved account/workspace identity, original conversation URL, original user/assistant IDs, private once-only receipt and same-conversation CDP user-turn/assistant persistence verification. First run `--plan`; sending requires an exact owned CDP parent watch, task ID and terminal proof, with a deliberate second call that omits `--plan`. `VERIFIED_DELIVERED` is required before declaring return delivered. No unregistered browser or pending 9225 fallback.
- Work ledger: `aicc work-ledger status --json` and existing job/attempt receipt. Do not invent another authoritative ledger.
- Codex session metadata: `aicc_codex_session_search|info|read_excerpt` read-only tools; never claim they are dispatch/send methods.
- Bound Codex task dispatch: `codex_bind_turn` accepts only the actual outer Codex turn's issued `turn_token`. With the returned `binding_id`, use `codex_task_list_projects|list|create|send|wait|read` for exact authorized tasks. Those tools are advertised in AICC Workspace but are **not callable from an ordinary external Web GPT turn without a valid Codex turn binding**. Never guess, borrow or look up another session's secret token.
- Other Codex task dispatch: Use only an actually available Codex App Server/CLI/session sender. Avoid dispatch to active unknown writer; distinct task-created Codex session can be used if supported.
- Web GPT direct local tools: `aicc_workspace_list` -> `aicc_workspace_open` -> exact authorised read/write lease. Root, lease, write guard and current schema must be verified.
- Full WebGPT route 17841 and local AICC Workspace MCP are separate channels; a healthy 17841 does not imply persistent Workspace readiness. Browser CDP 9222-9225 and independent 9336 must not be repurposed.
- Codex and ChatGPT each manage their own context compaction. The bridge remote `/v1/responses/compact` may be necessary for Codex protocol compatibility; don't delete it merely to eliminate redundant skill logic.

## Exact-link security

- The ChatGPT URL is an exact observed signed-in conversation URL (may contain project prefix). No share links, access tokens, cookies or invented conversation IDs.
- `codex://threads/<UUID>` is a navigation hint tied to actual observed Codex App Server thread UUID; it is not a task dispatcher.
- If local Codex or external ChatGPT cannot access the other's link by its available tools, include only user-approved minimal task description, no raw transcript.

## Workspace version identity

`source_identity` is the actual live source content hash; `installed_identity` includes actual lockfile/module resolution paths, not just same-content hashes. Resolving mismatch means safe staged release, actual idle/owner gate, one supported restart or deployment switch, and both identity checks plus live MCP read/write canary. Never edit runtime proof or disable equality checks. For self-disruptive maintenance, require `codex-rescue-preflight` independent READY.

## Installation is not Desktop resumption

A source entrypoint is not a callable Web action until the current caller actually has its supported runtime tool and binding. Installing this skill does not implement Desktop/TUI quota recovery or same-thread automatic continuation. Keep that acceptance HOLD until the owning runtime, tray and exact supported transport provide evidence. Do not create a new watcher/recovery worker or choose another account, provider, model or port to substitute for a missing dispatch path.

## Codex -> Web GPT

1. Use `use-web-gpt` for the exact logged-in surface and account, and `codex-web-low-token-workflow` for a narrow prompt. Provide the actual origin Codex link and request ID, never secrets or a whole local JSONL.
2. If collecting a response through a supported Observer, register/claim the exact watch before submitting. Where supported, arm `aicc codex-callback arm`, then `aicc web-gpt-callback wait --watch ID --callback ID`; tie both to the origin thread UUID, root, pinned app server and terminal result file.
3. The existing watcher verifies the user/assistant turn and artifact hash, waits for a terminal result, and calls the original idle Codex `thread/resume` + `turn/start` **once**. Busy/ambiguous/expired/foreign ownership means HOLD or exact reconciliation, never blind replay.
4. Codex reads the verified artifact, checks source/runtime evidence and completes only the uncompleted scoped work.
5. If the user will return with the result, use the existing sender's `--handoff-after-submit` mode in `use-web-gpt/references/execution-contract.md`. Record the verified submitted turn and real conversation URL, keep that target for the user and release its lease. Do not require a callback, start a monitor, resend, or report the unfinished answer as complete.

## 변경과 결과의 선택적 반영

지피티 관리 스킬을 수정하면 manage-chatgpt-skills의 변경 동기화 계약으로 Web 영향도를 판단한다. 결과 회수는 목표·현재 단계·근거의 관련성으로 선별하며 다른 대화의 전체 결과를 메인에 자동 삽입하지 않는다. 추가 업무인지 방향 전환인지 실제 목적에 맞춰 설명하고 고정 문구를 의무화하지 않는다. 프로젝트 표시명은 지피티 `w-`, 코덱스 `l-`이며 기존 ID와 경로는 유지한다.


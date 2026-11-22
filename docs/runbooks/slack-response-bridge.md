# Slack response bridge

## Decision and current readiness (2026-09-06)

Keep AICC Alerts as the sender. Use **Socket Mode + structured buttons** for
responses. The ordinary response inbox remains a transport library, while the
CAPTCHA increment adds a request-bound image, single-line modal, and exact-parent
thread reply fallback. Neither is
live-enabled until protected tokens, the worker, and an end-to-end canary pass.
An unthreaded or unrelated plain Slack reply never resumes Codex.

| Option | Decision |
| --- | --- |
| Socket Mode buttons | Selected: outbound authenticated connection and no public endpoint. |
| Events API HTTP webhook | Not selected for a Windows personal PC: requires reachable HTTPS, request signature checks and hosting. |
| Exact CAPTCHA thread reply | Selected fallback: `message.im` with `im:history`, but only a new owner event matching the bound DM channel and exact parent message timestamp is accepted. No history API or arbitrary DM parsing. |
| Model polling / UI typing / transcript writes | Rejected as delivery mechanisms: extra tokens, wrong-task risk or unsupported state mutation. |
| Codex lifecycle hooks alone | Not an idle wake mechanism. CAPTCHA uses the existing exact-task App Server terminal callback after the Slack modal is durably stored. |

Official sources: [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Slack Node SDK](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/),
[message.im scope](https://docs.slack.dev/reference/events/message.im/),
[Codex app server](https://learn.chatgpt.com/docs/app-server),
[background hooks](https://learn.chatgpt.com/docs/hooks#how-background-hooks-run).

## User experience and meaning

The proposed card shows one public-safe operation, project, frozen revision and
expiry. Buttons are `확인`, `처리 완료`, `이 작업 승인` (approval requests only),
`거절`, `보류`. Approval also has a Slack confirmation dialog. First valid answer
wins; changing an answer or scope requires cancelling and creating a fresh card.
Use a new follow-up card after acknowledgement if more action is needed.

- 확인: the owner read it; not approval.
- 처리 완료: the owner reports completion; the agent independently checks it.
- 이 작업 승인: consent to this one unexpired frozen operation, not native tool
  permission, administrator consent, payment details or all future operations.
- 거절 / 보류: do not execute the proposed operation.
- Slack protocol ACK: the transport handled the event, not user consent.
- `queued_transport_unavailable`: response saved, no automatic task delivery.
- `agent_seen`: exact task read and acknowledged the response; execution is still
  unverified. Never complete a user-action entry on this fact alone.

Approval expires at the original card deadline (maximum 15 minutes), even after
receipt. Ordinary response cards expire within 24 hours. The agent must compare
the actual operation and frozen revision with the response before acting; a
changed target, diff, recipient, amount or scope requires fresh consent. Never
use this text summary as authorization for an unspecified operation.

## Local implementation and integration contract

`src/notifications/slack-response-inbox.mjs` implements immutable requests,
exact workspace/app/owner/bot/DM/message checks, bounded freshness, replay
protection, task-filtered reads and durable metadata. State belongs in an
owner-only `notifications/slack-responses` directory under AICC state root.
The directory must already exist with verified permissions; Windows checks the
actual ACL (current owner, SYSTEM and Administrators only), not chmod bits.
Construction and status do not create directories or modify existing settings.

Producer sequence, after all release gates below:

1. Create a request with exact projectKey/taskId, public-safe operation (240
   characters maximum), revision, approval boolean and ISO expiresAt. Keep any
   sensitive operation details in the original project, not Slack.
2. The owning notification dispatcher calls the existing bot transport with
   `responseRequest` in addition to eventId/message. It must preserve the ordinary
   notification urgency, outbox, sensitivity and identity gates. This increment
   does NOT wire button requests into `aicc notify arm` yet.
3. Persist the returned verified delivery with `inbox.bind(requestId, delivery)`.
   Only then is the card answerable. An early click before binding is not ACKed
   and remains retryable; if recovery exceeds Slack retries the owner must click
   again after binding. Never reuse one message for two cards
   or edit the original request card. Use separate messages for future status.
4. `startSlackResponseSocket` takes an OS-protected app-token provider and the
   inbox. The official SDK handles authenticated connections/reconnects. The
   adapter persists metadata before ACK, ignores unsupported input and never logs
   the raw event, token, connection URL or response_url. Storage faults leave the
   event unacknowledged for Slack retry; failed persistence is not receipt.
5. Exact-task `pending` returns structured response **data**. After reading,
   `acknowledge` requires the same task/project/request/response/operation hash.
   There is no execute, approve-native-permission or automatic user-action-complete
   command. A scoped cancelled request is never actionable.

The ordinary response SDK listener is a library, not an installed background
service. The CAPTCHA increment adds a Windows-protected app-token provider and
a reviewed, single-owner current-user Scheduled Task manager for the Socket
worker. It is not installed by default. Desktop delivery, Slack receipt updates
and automatic stale-lock recovery remain explicit integration gates.

## CAPTCHA image and modal increment

`src/notifications/slack-captcha-state.mjs` stores one expiring request in the
owner-only `notifications/slack-captcha` directory. The binding covers the exact
workspace, app, owner, bot, DM message, task, request, challenge revision and
expiry. `slack-captcha-delivery.mjs` accepts only a bounded PNG crop, uploads it
with `filesUploadV2`, removes the local crop, and posts one message containing
the Slack-hosted image plus `문자 입력`. The modal uses one non-multiline
`plain_text_input`. If it fails to open, the owner can reply in that exact
message thread. Only a new `message.im` event matching the exact owner,
workspace, app, DM channel, and parent timestamp is eligible; unthreaded,
edited, bot, cross-message, and prose replies are rejected. Only the first
non-empty ASCII alphanumeric value is kept. AICC never calls a Slack history API.
The card states that sending the characters authorizes one entry and confirmation
on that exact current challenge. A valid modal submission or exact-thread reply is
the fresh action-time confirmation; the resumed task must not ask again.

Before delivery, `deliver-captcha.mjs` must arm an exact-task terminal callback
with the pinned Codex executable, generated App Server manifest and canonical
task root supplied in `callback`. It binds the callback to the request before
posting Slack. A valid modal submission or exact-thread reply then writes
metadata-only terminal proof, including only the bounded authorization scope,
and signals that callback once; proven active/busy states retry only until the
CAPTCHA expiry. `liveAutoWake: true` is required before the originating turn may
be left idle. No CAPTCHA value enters the callback result or prompt.

The worker also binds an OS-selected ephemeral port on `127.0.0.1` only. The
current CUA invocation posts the exact request/project/task/challenge/bindingHash
capability to `/v1/captcha/consume`. Consumption deletes protected state before
the HTTP response is created, so a crash or replay cannot reuse the value. The
response value exists only in that CUA JavaScript invocation and is passed
directly to the exact challenge field. After consumption or cancellation the
bridge attempts `files.delete`. Raw image bytes and answers never enter Git,
logs, the notification outbox, message text, clipboard, command arguments,
environment variables, files, model context, tool output, or status output.

The reviewed tools are:

```powershell
pwsh -NoProfile -File tools/platform/slack/Initialize-WindowsSlackCaptchaState.ps1
Get-Clipboard | node tools/platform/slack/store-captcha-app-token.mjs --service aicc-slack-captcha --account <exact-team-id>
Set-Clipboard -Value $null
node tools/platform/slack/run-captcha-socket-worker.mjs
node tools/platform/slack/manage-windows-captcha-worker-task.mjs status
node tools/platform/slack/manage-windows-captcha-worker-task.mjs install --dry-run
node tools/platform/slack/captcha-bridge.mjs status
```

After the Slack app, protected app token and canary gates pass, install the
hidden login worker with `install` (without `--dry-run`). Manage only the exact
`AgenticLab-AICC-Slack-Captcha-Worker` task. `status`, `stop`, and `rollback`
refuse foreign same-name tasks. The task command contains only `wscript.exe` and
the protected launcher; the launcher contains only the exact Node and worker
paths. The app token is read by the worker from Windows Credential Manager and
never enters task XML, arguments, environment variables, receipts or logs.

`deliver-captcha.mjs` accepts only safe request metadata and one exact bounded
PNG path under the current user's temporary directory over stdin, then deletes
the crop. The unshared upload itself creates no conversation message; one
`chat.postMessage` call creates the smartphone DM with the Slack-hosted image
inline and its modal button. If image upload fails, the bridge sends no text-only
fallback and never asks the owner to inspect a local PC or browser. It prints
binding metadata, never the image or answer.

`captcha-bridge.mjs status` reports only `consumeEndpoint` and `consumePort`,
never a response or binding capability. The endpoint accepts only POST,
`application/json`, the exact Host, a bounded body and a loopback peer. It has
no public listener, CORS permission, history read, logging or value-inspection
command. CAPTCHA binding mismatch, expiry and replay fail closed.

The consume request now also requires the exact active AICC browser lease:
`browserLeaseId`, task-created `browserTargetId`, and origin-only
`browserOrigin`. The durable lease must belong to the CAPTCHA task, remain in
`interact` mode, include `type`, allow that origin, and (when present) retain
its matching live `browser-slot` write resource lease. Validation happens
before `state.consume`, so a wrong/stale/observe-only browser cannot read the
answer. The authenticated page path/query is never added to the request.

After selecting the exact challenge field, the background browser tool must
perform fetch and input in one tool invocation: fetch the endpoint with the
five CAPTCHA binding fields plus the three browser-lease fields, keep
`(await response.json()).value` only in a JavaScript variable, immediately call
the selected task-owned tab field's `setValue`/`paste`, then clear the variable.
Do not call `nodeRepl.write`, `text`, console output, clipboard, shell, filesystem,
prompt or chat APIs with the response. Do not use an old PowerShell
`SetForegroundWindow`/`SendInput` helper for this path. Native foreground CUA is
not a fallback for CAPTCHA consumption; it stays behind `GuardedCuaDriver` and
its separate explicit foreground gate. `consumeSlackCaptchaIntoCurrentTask`
remains the internal exact-task callback boundary; no CLI returns the answer.

Read-only commands from the resolved source root:

```powershell
node tools/platform/slack/response-inbox.mjs --help
node tools/platform/slack/response-inbox.mjs status
'{"projectKey":"exact-project","taskId":"exact-task"}' | node tools/platform/slack/response-inbox.mjs pending
```

The CLI never prints credentials. Do not paste actual Slack tokens into argv,
chat, config, environment files, reports or shell history. App tokens remain in
the owner OS credential store, separately referenced from the existing bot token.

## Existing-task delivery gate

The Windows Desktop inspected on 2026-09-04 used stdio-owned app servers and no
shared TCP listener. `codex app-server daemon version` reports Unix-only lifecycle.
The AICC default app-server adapter spawns a separate process; it cannot be
assumed to own an already-running Desktop turn. Do not use it for this bridge.

A future verified connection must read the exact task and active turn from the
same owning server. Active turns require `turn/steer` with expectedTurnId; idle
tasks need supported `turn/start`. Do not expose an unauthenticated listener or
restart Desktop to manufacture a connection. Unsupported/unknown ownership is HOLD.
Do not replay an uncertain send; first reconcile the exact response marker.

`tools/platform/codex/slack-response-hook.mjs` is an optional, uninstalled
UserPromptSubmit hook. It uses the existing exact session binding and emits only
a fixed pending-data hint. No Slack content enters developer context. It does
not start an idle turn, read transcripts, consume the response or replace the
existing notification ACK hook. Expired/missing bindings produce no hint.

## Enablement / live acceptance gates

Keep disabled until all relevant gates have evidence:

1. Establish supported existing-Desktop delivery, or explicitly choose a
   next-normal-turn-only pilot and label that limitation to the owner.
2. Review the exact existing Slack app. Enable Socket Mode and Interactivity;
   create one app-level `connections:write` token. The bot needs `chat:write` and,
   only for CAPTCHA images, `files:write`; exact CAPTCHA thread replies also need
   `im:history` and the sole `message.im` bot event. Do not add a user token,
   public channel, incoming webhook, or org deployment, and never call a history API.
   Additional install/grant dialogs still need required action-time consent.
3. Inspect the protected Windows token lookup and single-owner Scheduled Task
   manager. Run its dry-run, then install it only after approval and verify
   status/stop/hash-guarded rollback. Preserve the existing installed Windows
   runtime. Resolve the actual deployment manifest source root first; an archived
   macOS checkout must not overwrite that runtime.
4. Wire durable notification request creation/binding, verified task delivery,
   transport receipts and visible Slack `수신 / 전달 / 확인` status separately.
5. Run one harmless card canary: owner clicks 확인; capture redacted request ID,
   receive timestamp, exact task receipt and state. Test duplicate, expired and
   wrong-task response without real changes. Then test one harmless approval.

Mock tests do not satisfy steps 1–5. Never broaden grants just to reach a green
status. No model heartbeat is installed to disguise a missing event-driven path.

## Recovery / retention

No live installation was performed for this increment, so current recovery needs
no Desktop, Slack or credential change. For an installed worker, run the exact
manager's `stop`, then `rollback`; rollback restores only its receipt-backed
previous task and launcher. Keep the
old outbound bot and pending inbox; disabling inbound must not revoke outbound.
Never delete queues to clear a status. A leftover inbox.lock after a crash is
HOLD: validate exact file, recorded PID, absence of all writers, then quarantine
only that lock for recovery. No automatic stale-lock stealing.

State is limited to 1 MiB / 1,000 requests. At capacity the inbox stops accepting
new requests rather than silently discarding responses. Retention/pruning needs
a separate reviewed metadata-only policy before long-running deployment. If
Socket Mode was enabled for a pilot, reverse only that pilot setting after the
worker stops; preserve other app settings and the bot token.

## Verification

`npm run test:slack-responses` and `npm run test:slack-captcha` check binding,
replay, freshness, expiry, distinct meanings, cross-task receipt, modal input,
minimal-image deletion, one-use purge, no secret output, and Socket lifecycle
with fake services. Run existing notification tests too;
the correct Windows source and Windows OS gate must be used on Windows.
The 2026-09-04 focused run passed 87 notification/response and documentation
tests, including 28 response tests and native Windows ACL checks. Live readiness
remains separate. The earlier agentic-website-maker source/home drift was
reconciled in 26b8d31 while preserving the newer resources. The reporting guidance
was deployed, validated and hash-matched; this does not enable inbound reception
or existing-task delivery.

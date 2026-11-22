# User notification and intervention channels

## Decision

The portable default remains Telegram-primary, but the exact owner-local policy
selects the attention channel. A verified distinct Slack bot may be the required
primary route for direct user action, judgment, approvals, critical failures,
and expected completion notices. Routine progress is never sent.

Slack never carries one-time codes. The default live route remains outbound-only
until the opt-in [Slack response bridge](runbooks/slack-response-bridge.md) passes
its release gates. The bridge uses exact-request buttons and, for CAPTCHA only,
a minimal image plus single-line modal; it never parses arbitrary Slack text.
Current Windows automatic Desktop delivery is HOLD.
Telegram retains its correlation-bound and ephemeral OTP flow when enabled.

## Current inventory

| Surface | Owner | Credential/state boundary | Final role |
| --- | --- | --- | --- |
| `notify-user` | AICC guidance and `aicc notify` | owner-local routing policy | canonical event classifier and agent entrypoint |
| `telegram-notify` | AICC guidance | `~/.ai-control-center/telegram/agent-bridge.env` | explicit Telegram transport and correlated/OTP replies |
| `telegram_verification.py` | `telegram-notify` | owner-only temporary request state | readiness and ephemeral SMS code only |
| BotFather manager | AICC platform tools | `bots.toml`, registered Telegram-admin browser | guarded inventory/create/delete/rotation |
| Account Manager Telegram bot | Account Manager legacy adapter | legacy service-local env, platform-specific | preserve until migrated to broker adapter |
| Slack connector | Codex Slack app | connector-owned OAuth/session | secondary summary/audit transport; self-authored DM is not mobile-attention proof |
| AICC Slack bot transport | AICC owner-local adapter | bot token in macOS Keychain or Windows Credential Manager; exact non-secret identity binding | distinct-author DM/mobile-attention route; outbound only |
| Telegram Web | Browser Session Broker | dedicated registered CDP Chrome profile | administrative BotFather and bot smoke only |

The Slack connector can resolve the current user and write summaries, but its
messages are authored by that same user. A connector self-DM proves the write
path and audit record only; it does not prove an inbound unread event or mobile
push. Mobile attention requires a distinct installed app/bot identity or another
independent sender.

Historical live validation on 2026-08-09 passed for one Telegram intervention alert,
one Slack self-DM mirror, the registered 9225 profile identity, read-only
BotFather inventory, owned-tab cleanup, and lease release. This proves the
interactive agent transports. The current unattended Slack sender uses its own
bot identity and native OS secret-store token and does not borrow connector OAuth state.

That historical assignment marked 9225 as Naver-only on 2026-08-12. On
2026-09-24 the owner reassigned it to multi-site browser automation. The slot
now opens a blank page; its existing profile is preserved. Account/workspace
identity remains pending, so the lease broker still excludes 9225. Telegram
BotFather administration remains disabled and must not borrow this profile; a
separately verified admin identity and explicit slot assignment are required.

## Event contract

All producers emit a notification event instead of calling Telegram, Slack, or
a webhook directly.

```text
eventId
type
severity
sensitivity
source
projectKey
owner
taskId
correlationId
title
summary
nextGate
expiresAt
artifactRefs
```

The public policy implementation is `src/notification-policy.mjs`. The durable
outbox in `src/notifications/outbox-service.mjs` applies the wait, lease, retry,
ACK, expiry, and payload-purge lifecycle. Credentials remain transport-owned.
The rendered mobile message shows only the project source; exact task, event,
and correlation IDs remain private metadata for routing, acknowledgement, and
deduplication.

Urgency is also the delivery clock: `1` is record-only, `2` waits 120 seconds,
`3` waits 60 seconds, and `4` or `5` is dispatched immediately. The owner-local
scheduler ticks every 30 seconds on macOS and every minute on Windows, so
delayed events are never sent early and are normally delivered within one tick
after becoming due.

| Event | Portable default | Slack-primary owner policy | Response authority |
| --- | --- | --- | --- |
| `user_response_required` | Telegram required | Slack required | original task |
| `approval_required` | Telegram required | Slack required | original task |
| `critical_error` | Telegram required | Slack required | original task |
| `task_completed` | Telegram optional | Slack optional expected notice | none |
| `deployment_complete` | Telegram optional | Slack optional expected notice | none |
| `report_ready` | Telegram optional | Slack optional expected notice | none |
| `otp_required` | Telegram required ephemeral | Slack prohibited | Telegram force-reply only |
| `routine_progress` | prohibited | prohibited | none |

## Delivery rules

1. Create one event ID and correlation ID before arming.
2. Load the owner-local routing profile and fail closed when its required channel is unavailable.
3. Use a distinct verified Slack bot for mobile attention; connector self-DM remains audit-only.
4. Record delivery state, not message bodies or credentials, in the task evidence.
5. Follow Slack `Retry-After` and use the bounded durable retry counter. After
   the configured attempt limit, move only that event to HOLD.
6. Never switch Telegram bot, Slack workspace, destination, browser profile, or
   user identity silently.
7. Never send passwords, tokens, cookies, native-auth values, email/SMS codes,
   private prompt bodies, or secret-bearing URLs.

## Browser boundary

Ports 9222 and 9223 are existing authenticated shared Chrome slots. Port 9224
is a third persistent slot; until its login identity is confirmed its usage is
`manual_login_pending` and the lease broker excludes it. Telegram Web
administration may use a separately registered persistent identity, but no
admin identity is currently enabled. Owner-local coordination assigns 9225 to
general multi-site automation, but its account/workspace identity is pending
and the broker excludes it until verified. Port 9226 is isolated stateless QA
and must remain login-free. Telegram tools must not reuse 9222, 9223, 9224,
9225, 9226, user tabs, or a dormant browser.

The 9224 and 9225 profiles are intended to contain only the permission-minimal
AICC port badge extension unless the user later authorizes another extension
for an exact role. Chrome requires one user-confirmed **Load unpacked** folder
selection per profile; CDP session loading is not accepted as persistent
installation. The badge has `storage` permission only and no host permissions
or content scripts.

The browser is an administrative surface, not the notification transport. Bot
API delivery remains available if Telegram Web or its launcher is down.

## Bot management

- `bots.toml` stores non-secret bot ownership and credential references.
- Tokens stay in owner-only service files. A token may be written directly from
  verified BotFather UI to the target file but must never appear in stdout.
- Inventory is read-only. Creation, deletion, transfer, and rotation require
  exact current authorization and post-operation verification.
- A missing local reference is not deletion evidence.
- The owning service must pass a Bot API or Telegram Web smoke before a bot is
  marked active.

## Slack setup and response boundary

The connector remains sufficient for Codex-originated audit summaries, but a
background sender must not borrow its OAuth state. When the user explicitly
requires mobile attention, use the reviewed `AICC Alerts` manifest with bot
`chat:write` plus CAPTCHA-only `files:write`, keep the `xoxb-` token in macOS
Keychain or Windows Credential Manager, and bind the
owner-local configuration to the exact team, app, bot user, bot, and recipient
IDs. The transport verifies those identities before and after `chat.postMessage`,
records no message body, and deduplicates by event ID.

Level-2/3 events also create an owner-only, expiring Codex session binding. The
official `UserPromptSubmit` hook passes only the exact project/task binding to
`aicc notify ack`; it ignores prompt and transcript content. This is a local
acknowledgement path, not a Slack reply bridge and not a blue-icon/read-receipt
guess.

Installation, native secret capture, identity verification, one bot DM canary,
and rollback are documented in [Slack alert bot](runbooks/slack-alert-bot.md).
The optional response role is specified in [Slack response bridge](runbooks/slack-response-bridge.md).
It permits reviewed Socket Mode/interactivity for structured owner responses;
history, user-token, public-channel and free-form input remain out of scope.
This supersedes the earlier permanent outbound-only design, not the current
deployment state or native permission boundaries. Do not advertise working Slack
approval until exact owner receipt and existing-task delivery are verified.

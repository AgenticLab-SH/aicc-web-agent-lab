# Slack alert bot

Use this runbook only when the owner explicitly requires Slack mobile attention.
A connector self-DM remains useful for audit, but it is authored by the owner and
does not prove an inbound notification.

## Fixed boundary

- Reuse the single workspace-local AICC app `AICC 한도 운영` from
  `guidance/config/slack-alerts-app-manifest.yaml`; do not create a second app
  because an old display name or DM remains visible. AgenticFabWorks canonical
  app is `A0BQDJ5L52S`, bot `U0BTRV8UJG4`, owner DM `D0BTLB8SW5C`
  (default username `aicc-ops`). The separate SKCT app `A0BQHFF1K25` /
  bot `U0BQDJHQ87Q` is named `SKCT 서비스 알림` (`skct-alerts`) and retains
  its existing service alerts and history. Neither app needs a new installation,
  token or permission change for this naming separation. Bind by IDs, not names.
- In the existing AICC owner DM, send `도움말` (`메뉴`, `명령어`, `help`, `?`
  also work) for the supported command menu and bot roles. Send `한도` or
  `ocx 한도` for all account quotas. These are plain DM commands, not slash
  commands. Help does not query quota or invoke a model. The A1 watcher keeps
  its existing exact owner/channel allowlist, receipt dedupe and bounded batches.
  Free-form development requests are handled in the original Codex conversation,
  not silently executed from Slack. No new app, scope or command installation.
- Grant only the bot scopes `chat:write`, `files:write`, and `im:history`. The
  image scope is used only for a minimal CAPTCHA crop. The local response worker uses the history-named scope only for new
  `message.im` events. The explicitly authorized A1 quota reader uses history
  only for the exact owner DM bound above; it accepts only its quota command
  allowlist and never stores DM text or reads other conversations.
- The reviewed manifest enables Socket Mode, Interactivity, and only the
  `message.im` bot event for exact buttons, CAPTCHA modals, and an exact-message
  thread-reply fallback. It does not enable user scopes, channel history,
  public-channel posting, incoming webhooks, or org deployment. A protected app token, worker install and live canary remain
  separate [response bridge](slack-response-bridge.md) gates.
- Store the `xoxb-` token only in the native owner secret store: macOS Keychain
  or Windows Credential Manager. Never paste it into a source, config, shell
  argument, log, Slack message, or evidence file.
- Bind the non-secret config to the exact `teamId`, `recipientUserId`, `appId`,
  `botUserId`, and `botId` returned by the current install.

## Install and secret capture

Create the app from the manifest in Slack App Settings, choose the exact
workspace, review the three requested bot scopes, and install it. Copy the Bot User
OAuth Token with Slack's Copy control, then pass the clipboard directly to the
native secret-store helper without rendering it.

macOS:

```sh
pbpaste | node tools/platform/slack/store-bot-token.mjs \
  --service aicc-slack-alerts --account <exact-team-id>
pbcopy </dev/null
```

Windows PowerShell 7:

```powershell
Get-Clipboard | node tools/platform/slack/store-bot-token.mjs `
  --service aicc-slack-alerts --account <exact-team-id>
Set-Clipboard -Value $null
```

The helper passes the token over stdin to macOS Security.framework or Windows
Credential Manager; it does not put the token in process arguments or return
it. Verify the token's workspace and discover only
the non-secret bot identities:

```sh
node tools/platform/slack/inspect-bot-identity.mjs \
  --service aicc-slack-alerts --account <exact-team-id> --team <exact-team-id>
```

Create owner-local `~/.ai-control-center/notifications/slack-alerts.json` with
mode `0600`:

```json
{
  "schemaVersion": 1,
  "transport": "aicc_slack_bot",
  "teamId": "<exact-team-id>",
  "recipientUserId": "<exact-user-id>",
  "appId": "<exact-app-id>",
  "botUserId": "<verified-bot-user-id>",
  "botId": "<verified-bot-id>",
  "keychainService": "aicc-slack-alerts",
  "keychainAccount": "<exact-team-id>"
}
```

Create the separate owner-local routing policy at
`~/.ai-control-center/notifications/policy.json`, also with mode `0600`. A
Slack-primary owner may use:

```json
{
  "schemaVersion": 1,
  "routingProfile": "slack_primary",
  "slackEnabled": true,
  "telegramEnabled": false
}
```

This policy makes the verified bot required for direct user action, judgment,
approval, and critical errors. It leaves OTP on the Telegram-only contract; if
Telegram is disabled, OTP notification fails closed and must remain in the
original authenticated workflow.

## Message format

Every bot alert starts with a numeric five-level urgency and uses short Korean
text without colors, emoji, English event tags, or internal event IDs:

```text
4 중요 | 배포 승인 필요
검증이 끝났습니다.
할 일: 승인 또는 보류 선택
출처: ai-platform
응답: 원래 Codex 작업
```

The levels are `1 참고`, `2 일반`, `3 확인`, `4 중요`, and `5 긴급`.
Level 1 is recorded but not delivered, level 2 waits 120 seconds, level 3 waits
60 seconds, and levels 4 or 5 are dispatched immediately. Completion notices
default to 2, user review to 3, blocking approval to 4, and critical failures to 5. The
sender preserves old `severity` inputs for compatibility, but new callers use
the numeric `urgency` field. It keeps the exact owner and event ID in delivery
metadata instead of repeating them in the message body.

Every delivered event must provide an exact project key and Codex task ID.
The exact task ID remains in private delivery metadata for acknowledgement,
deduplication, and audit, but the mobile message never prints its raw UUID.
Actionable events must also provide one Korean next action; visible titles and
summaries must contain Korean and cannot use color emoji. Restricted events
replace caller title, summary, and action with fixed safe Korean. OTP events do
the same on Telegram so a bare numeric code cannot enter the notification body.

## Canary and evidence

Run `aicc notify status --verify --json`, then pipe one non-secret notification
event to `aicc notify arm --json`. `notify send` and `send-alert.mjs` remain
compatibility aliases over the same durable arm path. Use a fresh event ID;
the sender records the exact team/app/bot/user/channel/timestamp but not the
message body. Confirm separately that Slack shows the bot as author and that the
mobile device received the banner. A successful API response is not mobile-push
proof.

Slack does not expose an API option that forces a mobile push. If messages arrive
without a phone banner while desktop Slack is active, set Slack's mobile timing to
notify immediately even while active; otherwise Slack can defer mobile delivery.

On Windows, manage the one-minute durable `process-due` task with the exact
owner target below. Status and dry-run never register, run, stop, or delete a
task. Install writes an owner-only receipt, and rollback uses only that receipt
and the exact prior task XML.

```powershell
node C:\demo\open-AICC\tools\platform\slack\manage-windows-process-due-task.mjs status
node C:\demo\open-AICC\tools\platform\slack\manage-windows-process-due-task.mjs install --task AgenticLab-AICC-Notification-Process-Due --dry-run
node C:\demo\open-AICC\tools\platform\slack\manage-windows-process-due-task.mjs stop --task AgenticLab-AICC-Notification-Process-Due --dry-run
node C:\demo\open-AICC\tools\platform\slack\manage-windows-process-due-task.mjs rollback --task AgenticLab-AICC-Notification-Process-Due --dry-run
```

The task runs only `aicc notify process-due --json` through an owner-controlled hidden
`wscript.exe` launcher, ignores overlapping ticks,
uses the current interactive user at least privilege, and does not expand Slack
permissions or read messages.

Do not retry an unchanged 429 immediately. The durable worker follows
`Retry-After` and stops at its bounded attempt limit. A team, app, bot, user, response-identity, or native secret-store
mismatch is fail-closed and must not fall back to a connector self-DM.

The app has the exact-owner DM subscription described above, not general channel
history access. Its separately reviewed Socket
Mode button/modal bridge accepts only exact interactive payloads; see its runbook
for app-token storage, identity checks and the current Windows Desktop delivery
HOLD. Do not confuse source-level implementation with a live enabled route.

## Rollback

Stop callers first. Remove only the exact native secret-store item and owner-local config,
then uninstall or revoke only the `AICC Alerts` app from the exact workspace.
Preserve redacted delivery-state records unless the owner explicitly requests
their removal. Do not change the Codex Slack connector, other apps, channels, or
notification preferences as part of this rollback.

---
name: manage-telegram-bots
description: 보호된 AICC BotFather 도구로 Telegram 봇 수명주기를 관리한다. 일반 알림 제외.
---

# Manage Telegram Bots

Use the non-secret registry at `~/.ai-control-center/telegram/bots.toml` and the
runbook at `docs/runbooks/telegram-bots.md`. Never print, copy, or hardcode a
bot token, chat ID, pairing code, cookie, or BotFather message body.

## Browser boundary

Use only the registered `telegram-admin` CDP Chrome identity from private AICC
coordination. The guarded wrapper acquires and releases its task-owned lease.
Do not infer the Telegram role from a port number or reuse a business, Pro, blog-workflow, or QA slot,
a dormant browser, a user tab, or an
unregistered endpoint. If Telegram login is missing, keep this browser identity
and invoke `complete-site-login`; do not switch profiles.

## Inventory

Run:

```powershell
pwsh -NoProfile -File tools/platform/telegram/Invoke-TelegramBotManager.ps1 -Action List
```

Compare verified owned usernames with the registry and local references. Add an
unknown bot as `audit_pending`; do not infer its role or delete it because no
local string was found.

## Mutation

Creation, deletion, transfer, username changes, and token rotation require
current authorization for the exact bot/role and target credential file.

For creation, register the intended role and service owner first, then call the
guarded manager with multiple username candidates. It writes the token directly
to the owner-only credential file and returns only a fingerprint.

For deletion, require replacement proof when applicable, current inventory,
reference audit, exact username authorization, and post-delete inventory. Keep
the deleted registry entry with its timestamp.

## Verification

- Restart or reload only the owning service.
- Run `Invoke-TelegramBotSmoke.ps1` with the non-secret bot ID and safe commands.
- Require verified browser identity, owned tab cleanup, response success, and
  no unrelated browser/process/config changes.
- Mark a bot active only after both registry and service smoke agree.

Never use Telegram Web as the notification transport. `telegram-notify` owns
Bot API notifications and correlation-bound user replies independently of the
administrative browser.

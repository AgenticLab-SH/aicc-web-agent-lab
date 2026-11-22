# Telegram management

These guarded tools inventory or mutate bots through verified BotFather or run
a bounded smoke test. The non-secret registry is
`~/.ai-control-center/telegram/bots.toml`; credentials remain under the same
private state directory. The public repository stores no bot names or secrets.

Browser administration uses only the registered `telegram-admin` CDP Chrome
identity from private coordination. The wrappers acquire and release a
task-owned lease and reject shared 9222/9223, general persistent 9224, isolated
QA 9226, dormant browsers, and
unregistered endpoints. Telegram Web is not the notification transport; Bot API
delivery through `telegram-notify` remains independent.

Install the pinned owner-local runtime once before using the guarded web tools.
It installs only the Playwright client library and does not download a browser
engine:

```powershell
pwsh -NoProfile -File tools/platform/telegram/Install-TelegramAdminRuntime.ps1
```

Creation, deletion, transfer, or token rotation requires explicit current user
authorization. A missing local reference is not proof that a remote bot can be
deleted.

# Codex multi-account

`cm` is the canonical local manager for isolated Codex accounts. It keeps
authentication and account databases separate while sharing only declared
Codex configuration, directives, plugins, rules, and Hub-managed skills.

## Commands

```powershell
cm status
cm switch <account>
cm reset-credits [--available-only]
cm cli <account>
cm native <account> [Codex args]
cm app <account> [--restart]
cm app-dry-run <account>
cm threads status
cm threads sync <account|all>
cm remote <account>|status|stop
cm import-app [name] [--dry-run]
cm refresh <account> [--once|--browser]
cm add [--once|--browser]
cm doctor
cm cleanup-temp [--yes]
cm auth-sync
cm remove
cm update
```

Run `cm help` for the installed command registry. Selectors accept the table
number, part of an email, or a recorded phone number.

## State boundaries

- `~/.codex`: current Desktop App home and configuration source.
- `~/.codex-multi/accounts`: stored account auth.
- `~/.codex-multi/homes`: account-local CLI home, auth, database, and rendered
  `config.toml`.
- `~/.codex-multi/app-profiles`: account-local Desktop App user data.

Never print auth, account IDs, credit IDs, raw usage responses, or database
contents. A failed lookup must not silently switch accounts, providers, homes,
or usage endpoints.

`cm switch` changes the current App auth only after an explicit selector.
`cm cli` and `cm app` launch isolated account state using the rendered App route. `cm native`
uses a separate owner-only Native home and the official Codex endpoint, without changing the
Desktop account or OCX selection. `cm threads sync`
uses local app-server/SQLite metadata and makes no model call.

## Provider and remote boundaries

Provider/model routing remains owned by OCX or native Codex configuration.
`cm remote` connects the current App to the selected account's native Codex
app-server over one SSH transport; it does not install or run the retired Kiro
gateway. Inspect `cm remote status` before changing a live route.

## 사용자 알림

계정 전환 완료는 이메일·호스트·PID를 보내지 않고 로컬 `aicc notify arm`에
긴급도 1의 기록 전용 이벤트로 남긴다. Slack 토큰은 Account Manager로 복제하지
않는다. `AICC_NOTIFY_BIN`을 지정할 때는 절대 경로의 일반 파일만 허용한다.

기존 Codex Telegram helpers와 stdlib client는 `telegram/`에 cold fallback 및
원격 제어 호환용으로 보존한다. 평상시 알림에는 사용하지 않으며
`CODEX_MULTI_NOTIFY_TELEGRAM_FALLBACK=1`을 명시한 경우에만 fallback한다.
Credentials stay outside Git in `~/.codex/telegram.env`. On Windows, manage the
optional legacy polling task from this directory:

```powershell
pwsh -NoProfile -File telegram/codex_telegram_bot_task.ps1 setup
pwsh -NoProfile -File telegram/codex_telegram_bot_task.ps1 status
```

Notification failure never changes the account operation. Set
`CODEX_MULTI_NOTIFY=0` for a temporary notification-only disable.

## Optional asynchronous login portal

`../auth-portal/broker.py` can run behind an authenticated tunnel. An authorized
operator can complete an official OpenAI device login while the destination
machine is offline. The broker retains one latest credential; the Mac applies a
new job only when its local checkpoint differs. The full account ID must match
the configured cm account. With `CM_AUTH_SYNC_OPENCODEX=1`, the same event also
creates or safely replaces one explicit OCX pool slot through a temporary import
gate, verifies it, and returns OCX to its normal gate-free service.

The portal never changes the active App account. Runtime service tokens,
Cloudflare tunnel credentials, retained OAuth envelopes, checkpoints, and OCX
backups stay outside Git. Full details and recovery steps are in
`../../docs/auth-portal-ocx-sync.md`.

## Verification

```bash
python3 -m unittest discover -s ops/local/tests -p 'test_*.py'
pwsh -NoProfile -File ops/local/cm.ps1 help
pwsh -NoProfile -File ops/local/cm.ps1 doctor
```

The tests use fixtures and must not read or mutate live auth.

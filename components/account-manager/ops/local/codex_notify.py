"""Notification helpers for Codex multi-account switches.

The primary path emits a privacy-safe event to the local AICC notification
gateway. Telegram remains an explicitly enabled cold fallback. Notification
failures are non-fatal so account switching still works.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener, urlopen

_TELEGRAM_ROOT = Path(__file__).resolve().parent / "telegram"
sys.path.insert(0, str(_TELEGRAM_ROOT))
from codex_telegram_common import send_configured_message


KST = timezone(timedelta(hours=9))
USAGE_API = "https://chatgpt.com/backend-api/wham/usage"
USAGE_USER_AGENT = "Codex Multi-Account Manager/1.0"
AICC_NOTIFY_TIMEOUT_SECONDS = 15


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def token_email(auth_data: dict | None) -> str | None:
    """Resolve the email for the actual auth token, matching cm TUI usage lookup."""
    if not auth_data:
        return None

    token = auth_data.get("tokens", {}).get("access_token")
    if not token:
        return None

    req = Request(USAGE_API)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USAGE_USER_AGENT)
    try:
        proxy = os.environ.get("CM_USAGE_PROXY", "").strip()
        if proxy.lower() in ("direct", "none", "off", "no"):
            opener = build_opener(ProxyHandler({}))
            response_ctx = opener.open(req, timeout=10)
        elif proxy and proxy.lower() not in ("system", "default", "auto"):
            opener = build_opener(ProxyHandler({"http": proxy, "https": proxy}))
            response_ctx = opener.open(req, timeout=10)
        else:
            response_ctx = urlopen(req, timeout=10)
        with response_ctx as resp:
            data = json.loads(resp.read().decode())
    except (HTTPError, URLError, OSError, json.JSONDecodeError):
        return None

    email = data.get("email")
    return email if isinstance(email, str) and "@" in email else None


def account_email(account: str | None, auth_data: dict | None = None) -> str:
    """Return the token email first, then local metadata/account label fallback."""
    if auth_data:
        email = token_email(auth_data)
        if email:
            return email
        for key in ("email", "account_email", "user_email"):
            value = auth_data.get(key)
            if isinstance(value, str) and "@" in value:
                return value
        user = auth_data.get("user")
        if isinstance(user, dict):
            value = user.get("email")
            if isinstance(value, str) and "@" in value:
                return value
    if account and "@" in account:
        return account
    return account or "unknown"


def build_account_message(
    surface: str,
    account: str,
    auth_data: dict | None = None,
    pid: int | None = None,
) -> str:
    email = account_email(account, auth_data)
    normalized = surface.lower()
    if normalized == "app":
        title = "[Codex App] 계정 전환 완료"
        account_line = f"현재 App 계정은 {email} 입니다."
    elif normalized == "cli":
        title = "[Codex CLI] 계정 활성화"
        account_line = f"현재 CLI 계정은 {email} 입니다."
    else:
        title = "[Codex] 계정 상태 변경"
        account_line = f"현재 계정은 {email} 입니다."

    lines = [
        title,
        account_line,
        f"시간: {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S KST')}",
        f"호스트: {socket.gethostname()}",
    ]
    if pid is not None:
        lines.append(f"PID: {pid}")
    return "\n".join(lines)


def send_codex_telegram(text: str, timeout: int = 15) -> tuple[bool, str]:
    """Send through the explicitly enabled Telegram cold fallback."""
    if os.environ.get("CODEX_MULTI_NOTIFY", "1") == "0":
        return True, "disabled"
    if os.environ.get("CODEX_MULTI_NOTIFY_DRY_RUN") == "1":
        return True, "dry-run"
    try:
        return send_configured_message(text, timeout=timeout)
    except Exception as exc:
        return False, exc.__class__.__name__


def build_aicc_event(surface: str, *, now_ms: int | None = None) -> dict:
    """Build a record-only event without account, host, PID, or auth data."""
    normalized = surface.lower()
    surface_label = "앱" if normalized == "app" else "명령줄" if normalized == "cli" else "계정"
    timestamp = int(time.time() * 1000 if now_ms is None else now_ms)
    return {
        "eventId": f"account-manager:change:{normalized}:{timestamp}",
        "type": "routine_progress",
        "urgency": 1,
        "sensitivity": "internal",
        "source": "account-manager",
        "projectKey": "account-manager",
        "owner": "account-manager",
        "taskId": "account-manager:account-change",
        "title": "계정 상태 기록",
        "summary": f"Codex {surface_label} 계정 상태가 변경됐습니다.",
    }


def resolve_aicc_notify_command(env: dict[str, str] | None = None) -> str | None:
    values = env if env is not None else os.environ
    configured = str(values.get("AICC_NOTIFY_BIN") or "").strip()
    if configured:
        candidate = Path(configured)
        if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_file():
            return None
        return str(candidate)
    return shutil.which("aicc")


def send_codex_aicc_event(event: dict, timeout: int = AICC_NOTIFY_TIMEOUT_SECONDS) -> tuple[bool, str]:
    """Arm one local AICC event with fixed argv and bounded stdin."""
    if os.environ.get("CODEX_MULTI_NOTIFY", "1") == "0":
        return True, "disabled"
    if os.environ.get("CODEX_MULTI_NOTIFY_DRY_RUN") == "1":
        return True, "dry-run"
    command = resolve_aicc_notify_command()
    if not command:
        return False, "aicc-unavailable"
    try:
        completed = subprocess.run(
            [command, "notify", "arm", "--json"],
            input=json.dumps(event, ensure_ascii=False, separators=(",", ":")),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, exc.__class__.__name__
    return (True, "armed") if completed.returncode == 0 else (False, "aicc-rejected")


def notify_account_change(
    surface: str,
    account: str,
    auth_data: dict | None = None,
    pid: int | None = None,
) -> bool:
    del account, auth_data, pid
    ok, reason = send_codex_aicc_event(build_aicc_event(surface))
    if not ok and os.environ.get("CODEX_MULTI_NOTIFY_TELEGRAM_FALLBACK") == "1":
        text = build_account_message(surface, "unknown")
        ok, reason = send_codex_telegram(text)
    if not ok:
        print(f"  [notify] 사용자 알림 기록 실패: {reason}", file=sys.stderr)
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Codex account AICC notifier")
    parser.add_argument("--surface", choices=("app", "cli", "codex"), default="codex")
    parser.add_argument("--account", default="test@example.com")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    event = build_aicc_event(args.surface)
    if args.dry_run:
        print(json.dumps({"ok": True, "mode": "dry-run", "event": event}, ensure_ascii=False))
        return 0
    ok, reason = send_codex_aicc_event(event)
    print(json.dumps({"ok": ok, "reason": reason}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

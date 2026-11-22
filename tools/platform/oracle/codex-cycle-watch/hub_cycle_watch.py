#!/usr/bin/env python3
"""A1 OCX-hub reset-cycle watcher.

This production watcher owns no OpenAI credentials. It reads fresh per-account
quota through the local OCX hub, detects a newly dormant governing long window
with two observations, then sends exactly one tiny account-pinned Responses
request to start that account's new window. Slack notification delivery
is independent and retryable; an inference attempt is never retried after an
ambiguous outcome.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
try:
    import fcntl
except ImportError:  # Windows repository tests; production is Linux-only.
    fcntl = None
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import unicodedata

from cycle_policy import MONTH, POLL_SECONDS, WEEK, WatchError, advance, begin_attempt, dormant, fail

ROOT_NAME = "aicc-ocx-cycle-watch"
DEFAULT_OCX = "/demo/owner/.local/bin/ocx-hub"
DEFAULT_HUB_CONFIG = "/demo/owner/.opencodex-hub/config.json"
DATA_URL = "http://127.0.0.1:10100/v1/responses"
SLACK_API = "https://slack.com/api"
MAX_JSON = 1024 * 1024
TOLERANCE = 12
STATUSES = {
    "watching", "confirming_dormant", "dormant_confirmed", "cycle_started",
    "awaiting_window", "send_outcome_unknown", "read_only", "daily_send_cap",
    "hub_error", "invalid_quota", "identity_changed", "clock_unsynchronized",
}
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$")
SLACK_ID = {
    "teamId": re.compile(r"^T[A-Z0-9]{8,}$"),
    "recipientUserId": re.compile(r"^U[A-Z0-9]{8,}$"),
    "botUserId": re.compile(r"^U[A-Z0-9]{8,}$"),
    "botId": re.compile(r"^B[A-Z0-9]{8,}$"),
}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_root(root: Path) -> Path:
    root = Path(root)
    if not root.is_absolute() or root.name != ROOT_NAME or ".." in root.parts:
        raise WatchError("invalid_root")
    if any(p.is_symlink() for p in [root, *root.parents]):
        raise WatchError("symlink_refused")
    return root


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "posix":
        return
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise WatchError("private_storage_required")


def read_json(path: Path, limit=MAX_JSON):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > limit:
        raise WatchError("unsafe_json")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, sort_keys=True, separators=(",", ":"))
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
        if hasattr(os, "O_DIRECTORY"):
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp)


def append_event(root: Path, event: dict) -> None:
    raw = json.dumps(event, sort_keys=True, separators=(",", ":"))
    if len(raw.encode()) > 4096:
        raise WatchError("event_too_large")
    path = root / "events.jsonl"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as out:
        out.write(raw + "\n")
        out.flush()
        os.fsync(out.fileno())


def initial_state():
    return {"version": 1, "accounts": {}, "notifications": {}}


def load_state(root: Path):
    path = root / "state.json"
    if not path.exists():
        return initial_state()
    value = read_json(path)
    if not isinstance(value, dict) or value.get("version") != 1:
        raise WatchError("invalid_state")
    if not isinstance(value.get("accounts"), dict) or not isinstance(value.get("notifications"), dict):
        raise WatchError("invalid_state")
    return value


@contextlib.contextmanager
def locked(root: Path):
    if fcntl is None:
        raise WatchError("linux_lock_required")
    fd = os.open(root / "watch.lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        raise WatchError("already_running") from None
    finally:
        os.close(fd)


def ntp_synchronized():
    try:
        result = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return result.returncode == 0 and result.stdout.strip().lower() == "yes"
    except (OSError, subprocess.TimeoutExpired):
        return False


def run_json(command, timeout=35):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise WatchError("hub_error") from None
    if result.returncode != 0 or len(result.stdout.encode()) > MAX_JSON:
        raise WatchError("hub_error")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise WatchError("hub_error") from None
    if not isinstance(value, dict):
        raise WatchError("hub_error")
    return value


def selector_map(config_path: Path):
    config = read_json(config_path)
    raw = config.get("codexAccountNamespaces")
    if not isinstance(raw, dict):
        raise WatchError("hub_error")
    result = {}
    for selector, account_id in raw.items():
        if selector == "main" or account_id == "@main":
            continue
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", str(selector)):
            raise WatchError("hub_error")
        if not isinstance(account_id, str) or not account_id:
            raise WatchError("hub_error")
        if account_id in result:
            raise WatchError("hub_error")
        result[account_id] = selector
    return result


def account_identity(account_id: str) -> str:
    return hashlib.sha256(account_id.encode()).hexdigest()


class HubClient:
    def __init__(self, ocx=DEFAULT_OCX, config_path=DEFAULT_HUB_CONFIG, opener=None, now=None):
        self.ocx = ocx
        self.config_path = Path(config_path)
        self.opener = opener or urllib.request.urlopen
        self.now = now or time.time

    def identity_status(self):
        payload = run_json([self.ocx, "account", "list", "openai", "--json"])
        rows = payload.get("accounts")
        if not isinstance(rows, list):
            raise WatchError("hub_error")
        selectors = selector_map(self.config_path)
        result = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            account_id = row.get("id")
            if not isinstance(account_id, str) or account_id not in selectors:
                continue
            block_reason = None
            if bool(row.get("needsReauth")):
                block_reason = "needs_reauth"
            elif bool(row.get("paused")):
                block_reason = "paused"
            result.append({
                "selector": selectors[account_id],
                "identityHash": account_identity(account_id),
                "active": row.get("active") is True,
                "plan": str(row.get("plan") or "unknown"),
                "blockReason": block_reason,
                "selectionExcludedReason": row.get("selectionExcludedReason"),
            })
        return sorted(result, key=lambda item: item["selector"])

    def refresh_accounts(self):
        payload = run_json([self.ocx, "account", "refresh", "openai", "--json"])
        rows = payload.get("accounts")
        if not isinstance(rows, list):
            raise WatchError("hub_error")
        selectors = selector_map(self.config_path)
        current_at = self.now()
        result = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            account_id = row.get("id")
            if not isinstance(account_id, str) or account_id not in selectors:
                continue
            quota = row.get("quota") if isinstance(row.get("quota"), dict) else {}
            plan = str(row.get("plan") or "unknown")
            plan_key = plan.strip().lower()
            used = quota.get("weeklyPercent")
            deadline = quota.get("weeklyResetAt")
            window = "weekly"
            window_seconds = WEEK
            if not number(used) or not number(deadline):
                if plan_key not in {"free", "go"}:
                    continue
                used = quota.get("monthlyPercent")
                deadline = quota.get("monthlyResetAt")
                window = "monthly"
                window_seconds = MONTH
            if not number(used) or not number(deadline):
                continue
            remaining = float(deadline) - current_at
            if not (0 <= float(used) <= 100) or not (-TOLERANCE <= remaining <= window_seconds + TOLERANCE):
                raise WatchError("invalid_quota")
            block_reason = None
            if bool(row.get("needsReauth")):
                block_reason = "needs_reauth"
            elif bool(row.get("paused")):
                block_reason = "paused"
            # Pause/plan exclusion affect ordinary selection, not cycle starts.
            # Authentication failure still blocks initialization. Paused starts
            # use the internal one-shot helper without changing the saved pause.
            initialization_block = "needs_reauth" if row.get("needsReauth") else None
            short_used = quota.get("shortPercent")
            if initialization_block is None and row.get("paused") and (not number(short_used) or not 0 <= short_used < 97):
                initialization_block = "short_quota_unavailable"
            allowed = initialization_block is None
            result.append({
                "id": account_id,
                "identity": account_identity(account_id),
                "selector": selectors[account_id],
                "active": row.get("active") is True,
                "plan": plan,
                "window": window,
                "paused": bool(row.get("paused")),
                "initializationBlockReason": initialization_block,
                "shortUsedPercent": quota.get("shortPercent"),
                "blockReason": block_reason,
                "selectionExcludedReason": row.get("selectionExcludedReason"),
                "sample": {
                    "at": current_at,
                    "used": float(used),
                    "deadline": float(deadline),
                    "remaining": max(0.0, remaining),
                    "allowed": allowed,
                    "windowSeconds": window_seconds,
                },
            })
        return result

    def start_cycle(self, account):
        if account.get("paused"):
            short_used = account.get("shortUsedPercent")
            if not number(short_used) or not 0 <= short_used < 97:
                raise WatchError("paused_initializer_short_quota_unavailable")
            helper = Path(__file__).with_name("start_paused_cycle.py")
            env = dict(os.environ, OPENCODEX_HOME=str(self.config_path.parent),
                       CODEX_HOME=str(self.config_path.parent / "codex-runtime"))
            try:
                completed = subprocess.run([
                    sys.executable, "-B", str(helper), account["selector"], account["identity"], account["attemptId"]
                ], env=env, capture_output=True, text=True, timeout=35, check=False)
                result = json.loads(completed.stdout) if completed.returncode == 0 and len(completed.stdout) < 4096 else {}
            except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
                raise WatchError("send_outcome_unknown") from None
            if result.get("completed") is not True:
                raise WatchError("send_outcome_unknown")
            return True
        selector = account["selector"]
        model = f"{selector}/gpt-5.6-luna"
        body = {
            "model": model,
            "instructions": "Return 1.",
            "input": [{"type": "message", "role": "user",
                       "content": [{"type": "input_text", "text": "1"}]}],
            "reasoning": {"effort": "none"},
            "max_output_tokens": 16,
            "stream": False,
            "store": False,
        }
        raw = json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(
            DATA_URL, data=raw, method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener(request, timeout=30) as response:
                if response.status != 200:
                    raise WatchError("hub_error")
                payload = response.read(512 * 1024)
        except (urllib.error.URLError, TimeoutError, OSError):
            raise WatchError("send_outcome_unknown") from None
        try:
            value = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise WatchError("send_outcome_unknown") from None
        if value.get("status") not in (None, "completed"):
            raise WatchError("send_outcome_unknown")
        return True

    def quota_text(self, account_index=None, credits_only=False):
        payload = run_json([self.ocx, "account", "refresh", "openai", "--json"], timeout=20)
        observed_at = self.now()
        selectors = selector_map(self.config_path)
        rows = payload.get("accounts")
        if not isinstance(rows, list):
            raise WatchError("hub_error")
        # The CLI intentionally masks names. Resolve display labels from the
        # same registered metadata as the identity command, never export email.
        registered = {row["id"]: row for row in read_json(self.config_path).get("codexAccounts", [])
                      if isinstance(row, dict) and isinstance(row.get("id"), str)}
        rows = sorted((dict(row) for row in rows if isinstance(row, dict)
                       and row.get('id') in selectors), key=lambda row: selectors[row['id']])
        if account_index is not None:
            if type(account_index) is not int or not 1 <= account_index <= 16:
                raise WatchError('invalid_account_index')
            rows = rows[account_index - 1:account_index]
        for row in rows:
            if not isinstance(row, dict) or row.get("id") not in selectors:
                continue
            email = registered.get(row["id"], {}).get("email")
            if isinstance(email, str) and "@" in email and "*" not in email:
                name = email.split("@", 1)[0]
                if re.fullmatch(r"[A-Za-z0-9._+-]{1,40}", name):
                    row["accountName"] = name
        inventories = {}
        seen_ids = set()
        for row in rows:
            if not isinstance(row, dict) or row.get("id") not in selectors:
                continue
            account_id = row["id"]
            if account_id in seen_ids:
                continue
            if len(seen_ids) >= 16:
                break
            seen_ids.add(account_id)
            # Read only: never supply --consume/--yes or spend a reset credit.
            try:
                inventory = run_json([self.ocx, "account", "reset-credits", account_id, "--json"], timeout=8)
                count = inventory.get("available_count")
                credits = inventory.get("credits")
                if type(count) is not int or not 0 <= count <= 1000 or not isinstance(credits, list) or len(credits) > 48:
                    raise WatchError("credit_inventory_invalid")
                expiries = []
                for credit in credits:
                    expiry = credit.get("expires_at") if isinstance(credit, dict) else None
                    if not isinstance(expiry, str) or len(expiry) > 64:
                        raise WatchError("credit_inventory_invalid")
                    expiries.append(expiry)
                inventories[account_id] = {"available": count, "expiresAt": expiries}
            except (WatchError, OSError, ValueError, TypeError):
                inventories[account_id] = {"unavailable": True}
        return format_quota_report(rows, selectors, observed_at, inventories, credits_only=credits_only, account_number=account_index)


def credit_expiry_epoch(value):
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or not 2020 <= parsed.year <= 2100:
            return None
        timestamp = parsed.timestamp()
        return timestamp if math.isfinite(timestamp) else None
    except (ValueError, OverflowError, OSError):
        return None


def time_until(deadline, observed_at, credit=False):
    if not number(deadline) or not math.isfinite(deadline):
        return "미확인"
    if deadline <= observed_at:
        return "기한 경과 · 재조회 필요"
    minutes = max(1, math.ceil((deadline - observed_at) / 60))
    days, extra = divmod(minutes, 1440)
    if credit and days:
        return f"{days}일 {extra // 60}시간"
    hours, mins = divmod(minutes, 60)
    return f"{hours}시간 {mins}분" if hours else f"{mins}분"



def format_quota_report(rows, selectors, observed_at=None, credit_inventories=None, credits_only=False, account_number=None):
    """Mobile-readable Slack text, also usable as the notification fallback.

    Only registered hub identities are shown. Selection is a hub setting,
    not proof that Windows is running an eligible request on that account.
    """
    kst = datetime.timezone(datetime.timedelta(hours=9))
    observed = datetime.datetime.fromtimestamp(observed_at, kst) if observed_at is not None else datetime.datetime.now(kst)
    observed_at = observed.timestamp()
    lines = ["*OCX 계정 한도* · " + observed.strftime("%m/%d %H:%M KST"),
             "사용·잔여는 % / 초기화는 KST · 남은 시간은 조회시각 기준"]
    def cell(value, width):
        value = str(value)
        size = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in value)
        return value + " " * max(0, width - size)

    def percent(value):
        if number(value) and 0 <= value <= 100:
            return f"{float(value):g}%", f"{100-float(value):g}%"
        return "미확인", "미확인"

    count = 0
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("id") not in selectors or row["id"] in seen:
            continue
        seen.add(row["id"])
        count += 1
        quota = row.get("quota") if isinstance(row.get("quota"), dict) else {}
        name = str(row.get("accountName") or row.get("alias") or selectors[row["id"]])[:40]
        if "@" in name:
            name = selectors[row["id"]]
        name = re.sub(r"[\x00-\x1f\x7f*`_~]", " ", name)
        name = name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        state_label = "재로그인 필요" if row.get("needsReauth") else "일시 중지" if row.get("paused") else "인증 정상"
        selected = " · 허브 선택" if row.get("active") else ""
        lines.append(f"\n{account_number or count}. *{name}* · {state_label}{selected}")
        if not credits_only:
            lines.append("```")
            lines.append(cell("구간", 6) + cell("사용", 7) + cell("잔여", 7) + "초기화(KST) · 남은 시간")
            windows = [("5시간", "shortPercent", "shortResetAt")]
            if quota.get("weeklyPercent") is not None:
                windows.append(("주간", "weeklyPercent", "weeklyResetAt"))
            if quota.get("monthlyPercent") is not None or quota.get("weeklyPercent") is None:
                windows.append(("월간", "monthlyPercent", "monthlyResetAt"))
            for label, used_key, reset_key in windows:
                used, left = percent(quota.get(used_key))
                reset = quota.get(reset_key)
                try:
                    deadline = datetime.datetime.fromtimestamp(reset, kst).strftime("%m/%d %H:%M") if number(reset) and math.isfinite(reset) and reset > 0 else "미확인"
                except (ValueError, OverflowError, OSError):
                    deadline = "미확인"
                remaining = time_until(reset, observed_at) if deadline != "미확인" else "미확인"
                lines.append(cell(label, 6) + cell(used, 7) + cell(left, 7) + deadline + " · " + remaining)
            lines.append("```")
        credits = quota.get("resetCredits")
        inventory = credit_inventories.get(row["id"]) if isinstance(credit_inventories, dict) else None
        if isinstance(inventory, dict) and not inventory.get("unavailable"):
            available = inventory.get("available")
            expiries = inventory.get("expiresAt")
            if type(available) is int and available >= 0 and isinstance(expiries, list):
                lines.append(f"초기화권 {available}장 · 개별 만료(KST)")
                for index, expiry in enumerate(expiries, 1):
                    expiry_at = credit_expiry_epoch(expiry)
                    try:
                        expires = datetime.datetime.fromtimestamp(expiry_at, kst).strftime("%m/%d %H:%M") if expiry_at is not None else "미확인"
                    except (ValueError, OverflowError, OSError):
                        expires = "미확인"
                    remaining = time_until(expiry_at, observed_at, credit=True) if expires != "미확인" else "미확인"
                    lines.append(f"  {index}번 · 만료 {expires} · 남은 {remaining}")
                if len(expiries) != available:
                    lines.append("표시된 초기화권과 사용 가능 수량이 다릅니다 · 사용 전 재조회 필요")
            else:
                lines.append("초기화권 수량 및 개별 만료 정보 미확인")
        elif isinstance(credits, int) and not isinstance(credits, bool) and credits >= 0:
            lines.append(f"초기화권 {credits}장 · 개별 만료 미확인")
        else:
            lines.append("초기화권 개별 만료 정보 미확인")
    if not count:
        lines.append("등록된 OCX 계정을 확인하지 못했습니다.")
    lines.append("\n허브 선택 ≠ 현재 실행 계정 · 새 요청 시 한도 재확인\n초기화권 조회는 소비가 아닙니다 · 다시 조회: 한도")
    return "\n".join(lines)


def attempt_id(identity: str, at: float) -> str:
    return "cycle:" + hashlib.sha256(f"{identity}:{int(at)}".encode()).hexdigest()[:32]


def queue_notification(state, event_id: str, message: str, now: float):
    if event_id not in state["notifications"]:
        state["notifications"][event_id] = {
            "message": message, "createdAt": now, "attempts": 0,
            "nextAttemptAt": now, "sentAt": None,
        }


def deterministic_client_message_id(event_id: str) -> str:
    digest = bytearray(hashlib.sha256(("aicc-slack:" + event_id).encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def load_slack_config(path: Path):
    value = read_json(path)
    if value.get("schemaVersion") != 1 or value.get("transport") != "aicc_slack_bot":
        raise WatchError("slack_config_invalid")
    for key, pattern in SLACK_ID.items():
        if not pattern.fullmatch(str(value.get(key, ""))):
            raise WatchError("slack_config_invalid")
    return value


def credential_token():
    directory = os.environ.get("CREDENTIALS_DIRECTORY", "")
    if not directory:
        raise WatchError("slack_token_unavailable")
    path = Path(directory) / "slack_token"
    token = path.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"xoxb-[A-Za-z0-9-]{20,}", token):
        raise WatchError("slack_token_unavailable")
    return token


def slack_api(method: str, payload: dict, token: str, opener=None):
    opener = opener or urllib.request.urlopen
    request = urllib.request.Request(
        f"{SLACK_API}/{method}",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with opener(request, timeout=12) as response:
            raw = response.read(256 * 1024)
            if response.status != 200:
                raise WatchError("slack_delivery_failed")
    except (urllib.error.URLError, TimeoutError, OSError):
        raise WatchError("slack_delivery_failed") from None
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise WatchError("slack_delivery_failed") from None
    if value.get("ok") is not True:
        code = str(value.get("error", ""))
        raise WatchError("slack_api_" + code if re.fullmatch(r"[a-z_]{1,64}", code) else "slack_delivery_failed")
    return value


def verify_slack(config, token, opener=None):
    value = slack_api("auth.test", {}, token, opener)
    if value.get("team_id") != config["teamId"] or value.get("user_id") != config["botUserId"]:
        raise WatchError("slack_identity_mismatch")
    return True


def send_slack(config, token, event_id: str, message: str, opener=None):
    return slack_api("chat.postMessage", {
        "channel": config["recipientUserId"],
        "text": message,
        "client_msg_id": deterministic_client_message_id(event_id),
        "unfurl_links": False,
    }, token, opener)


def deliver_notifications(root, state, slack_config, token, now, opener=None):
    changed = False
    for event_id, row in list(state["notifications"].items()):
        if row.get("sentAt") or now < float(row.get("nextAttemptAt", 0)):
            continue
        try:
            send_slack(slack_config, token, event_id, row["message"], opener)
            row["sentAt"] = now
        except WatchError:
            attempts = min(int(row.get("attempts", 0)) + 1, 8)
            row["attempts"] = attempts
            row["nextAttemptAt"] = now + min(3600, 30 * (2 ** (attempts - 1)))
        changed = True
        atomic_json(root / "state.json", state)
    # Bound durable history.
    sent = sorted(
        ((eid, row) for eid, row in state["notifications"].items() if row.get("sentAt")),
        key=lambda item: item[1]["sentAt"], reverse=True,
    )
    for eid, _ in sent[100:]:
        del state["notifications"][eid]
        changed = True
    return changed


def slack_timestamp(value):
    """Slack silently ignores history cursors with more than six decimals."""
    text = str(value)
    if not re.fullmatch(r"[0-9]{10,}(?:\.[0-9]{1,9})?", text):
        raise WatchError("slack_query_invalid_cursor")
    whole, _, fraction = text.partition(".")
    return whole + "." + fraction[:6].ljust(6, "0")


QUOTA_COMMANDS = frozenset({"한도", "ocx", "ocx 한도", "quota", "ocx quota"})
HELP_COMMANDS = frozenset({"도움말", "도움", "명령어", "메뉴", "help", "?", "봇 역할"})
CHOICE_COMMANDS = {
    "선택 1": "quota", "선택 2": "credits", "선택 3": "accounts",
    "선택 4": "watch", "선택 5": "controls",
}
DIRECT_COMMANDS = {
    "초기화권": "credits", "계정": "accounts", "감시": "watch",
    "상태": "watch", "제어": "controls",
}


def parse_slack_choice(command):
    """Exact owner DM commands only; never persist a free-form message."""
    if not isinstance(command, str) or len(command) > 1024:
        return None
    command = command.strip()
    # A linked app may add a locale-dependent attribution footer.
    # Accept only the FIRST exact read-only choice, for this bound owner DM.
    # Never turn a multiline free-form instruction into a mutation.
    if "\n" in command or "\r" in command:
        command = command.splitlines()[0].strip()
    if len(command) > 80:
        return None
    command = " ".join(command.split()).lower()
    # Slack integrations can append a same-line attribution after the
    # first choice. Match only an exact menu prefix followed by whitespace.
    allowed = set(HELP_COMMANDS) | set(QUOTA_COMMANDS) | set(CHOICE_COMMANDS) | set(DIRECT_COMMANDS)
    allowed.update(f"{label} {index}" for label in ("계정", "초기화권") for index in range(1, 17))
    for candidate in sorted(allowed, key=len, reverse=True):
        if command == candidate:
            break
        if command.startswith(candidate) and command[len(candidate):].startswith(" "):
            footer = command[len(candidate):].lstrip()
            if footer and footer[0] in "*<[( ":
                command = candidate
                break
    if command in HELP_COMMANDS:
        return "help", None
    if command in QUOTA_COMMANDS:
        return "quota", None
    if command in CHOICE_COMMANDS:
        return CHOICE_COMMANDS[command], None
    if command in DIRECT_COMMANDS:
        return DIRECT_COMMANDS[command], None
    match = re.fullmatch(r"(계정|초기화권) (1[0-6]|[1-9])", command)
    if match:
        return ("account" if match.group(1) == "계정" else "credit"), int(match.group(2))
    return None


def slack_account_list(client):
    rows = client.identity_status()
    lines = ["*OCX 계정 목록* · 읽기 전용", "번호를 골라 계정 1 또는 초기화권 1처럼 보내세요."]
    for index, row in enumerate(sorted(rows, key=lambda value: value["selector"])[:16], 1):
        selector = str(row.get("selector", ""))
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", selector):
            continue
        state = "재로그인 필요" if row.get("blockReason") == "needs_reauth" else "일시 중지" if row.get("blockReason") == "paused" else "등록됨"
        selected = " · 허브 선택" if row.get("active") else ""
        lines.append(f"{index}. {selector} · {state}{selected}")
    if len(lines) == 2:
        lines.append("확인 가능한 등록 계정이 없습니다.")
    lines.append("계정 선택·사용 중지·초기화권 사용은 기존 인증된 AICC 제어 화면에서 확인 후 실행합니다.")
    return "\n".join(lines)


def slack_watch_text(state, now):
    """Summarize current watcher observations without refreshing or waking a model."""
    rows = status_summary({"accounts": state.get("accounts", {}), "notifications": state.get("notifications", {})})
    accounts = rows.get("accounts", [])
    lines = ["*A1 OCX 감시 상태*", f"등록 {len(accounts)}개 · 전송 대기 알림 {rows.get('pendingSlack', 0)}건"]
    for index, row in enumerate(accounts[:16], 1):
        last = row.get("lastObservationAt")
        age = now - last if number(last) and math.isfinite(last) else None
        freshness = "관측 미확인" if age is None or age < 0 else (
            f"{math.ceil(age / 60)}분 전" if age <= 240 else f"오래됨 · {math.ceil(age / 60)}분 전")
        paused = " · 일시 중지" if row.get("paused") else ""
        selected = " · 허브 선택" if row.get("active") else ""
        name = str(row.get("selector", ""))
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name):
            name = f"{index}번 계정"
        status = str(row.get("status", "unknown"))
        if status not in STATUSES:
            status = "unknown"
        lines.append(f"{index}. {name} · {status}{paused}{selected} · {freshness}")
    lines.append("감시 기록은 현재 대화의 모델 실행 준비나 한도 해제를 증명하지 않습니다.")
    return "\n".join(lines)


def slack_controls_text():
    return (
        "*AICC 트레이 제어 기능*\n"
        "계정: 사용/중지/재개/자동 선택/우선순위/순서\n"
        "한도: 차단 정책/경고/초기화권 1장 사용\n"
        "기타: RDC 계정·대화 큐·진단·PC 실행 도구\n\n"
        "이 DM에서는 한도, 초기화권, 계정, 감시와 번호별 상세 조회를 사용할 수 있습니다.\n"
        "*변경 작업은 기존 인증된 AICC PC·휴대폰 제어 화면에서 수행합니다.* "
        "그 화면의 미리보기·단회 확인·결과 조회를 거쳐야 하며, "
        "Slack 명령만으로 계정 변경이나 초기화권 소비를 실행하지 않습니다.\n"
        "이전 화면 주소가 열리지 않으면 연결 상태를 확인하세요. 새 공개 주소나 권한을 만들지 않습니다."
    )



def slack_help_text():
    return (
        "*AICC 기능 선택*\n"
        "이 Slack 개인 DM에 원하는 번호를 보내세요. 예: 선택 1\n\n"
        "1. 선택 1 · 전체 OCX 한도·초기화 남은 시간\n"
        "2. 선택 2 · 모든 초기화권의 만료 기간\n"
        "3. 선택 3 · 등록된 계정 목록\n"
        "4. 선택 4 · A1 감시기 운영 상태\n"
        "5. 선택 5 · AICC 트레이 제어 기능·사용 경로\n\n"
        "번호별 상세: 계정 1 / 초기화권 1 (1~16)\n"
        "바로 입력: 한도 / 초기화권 / 계정 / 감시 / 제어 / 메뉴\n"
        "별칭: 도움말·명령어·help·? / ocx·ocx 한도·quota\n\n"
        "*봇 역할*\n"
        "AICC 한도 운영: 조회·알림·기능 선택. SKCT 서비스 알림은 별도 봇입니다.\n"
        "*권한 경계*\n"
        "이 DM 명령은 읽기 전용이며 모델 실행·계정 변경·초기화권 소비를 하지 않습니다. "
        "변경 작업은 인증된 AICC PC·폰 화면의 미리보기와 확인을 사용합니다.\n"
        "응답은 보통 10초 주기이며 장애나 계정별 조회가 느리면 지연될 수 있습니다."
    )


def slack_command_result(kind, account_index, client, state, now):
    if kind == "help":
        return slack_help_text()
    if kind == "controls":
        return slack_controls_text()
    if kind == "watch":
        return slack_watch_text(state, now)
    if kind == "accounts":
        return slack_account_list(client)
    if kind == "quota":
        return client.quota_text()
    if kind == "credits":
        return client.quota_text(credits_only=True)
    if kind == "account":
        return client.quota_text(account_index=account_index)
    if kind == "credit":
        return client.quota_text(account_index=account_index, credits_only=True)
    return "*기능 확인 필요*\n메뉴를 보내 다시 선택하세요."


def poll_quota_queries(root, state, client, config, token, now, opener=None):
    """Read only the owner's existing bot DM. Persist timestamps, never DM text."""
    channel = config.get("dmChannelId")
    if not isinstance(channel, str) or not re.fullmatch(r"D[A-Z0-9]{8,}", channel):
        return
    query = state.setdefault("quotaQuery", {"cursor": f"{now:.6f}", "pending": {}})
    # Normalize existing cursors too, so already posted owner commands are found.
    query["cursor"] = slack_timestamp(query["cursor"])
    request = {"channel": channel, "oldest": query["cursor"], "limit": 20}
    if query.get("pageCursor"):
        request["cursor"] = query["pageCursor"]
    payload = slack_api("conversations.history", request, token, opener)
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        raise WatchError("slack_query_invalid")
    for message in sorted(messages, key=lambda row: float(row.get("ts", 0))):
        ts = message.get("ts", "")
        if not re.fullmatch(r"[0-9]{10,}\.[0-9]{1,9}", ts):
            continue
        command = str(message.get("text", ""))
        if message.get("user") == config["recipientUserId"]:
            subtype = message.get("subtype")
            attributed = re.fullmatch(
                r"[^\r\n]{1,80}\r?\n\*다음을 사용하여 보냄\* <@U[A-Z0-9]{8,}\|ChatGPT>",
                command.strip()
            ) is not None
            choice = parse_slack_choice(command)
            # An attributable owner-authored ChatGPT app message may be marked
            # bot_message by Slack. Never accept other subtypes or owners.
            permitted = not subtype or (subtype == "bot_message" and attributed)
            query["lastOwnerObservation"] = {
                "ts": ts, "subtype": str(subtype or "none")[:32],
                "attributed": attributed, "recognized": choice is not None,
                "firstLineMenu": bool(command.splitlines()) and command.splitlines()[0].strip() == "메뉴",
                "hasAppName": "ChatGPT" in command, "lineCount": min(len(command.splitlines()), 32),
                "startsMenu": command.strip().startswith("메뉴"), "containsMenu": "메뉴" in command,
                "textLength": min(len(command), 1024),
                "accepted": bool(permitted and choice is not None),
            }
            if permitted and choice is not None:
                kind, index = choice
                entry = {"attempts": 0, "kind": kind}
                if index is not None:
                    entry["accountIndex"] = index
                query["pending"].setdefault(ts, entry)
        query["highWater"] = max(slack_timestamp(query.get("highWater", query["cursor"])), slack_timestamp(ts))
    next_page = (payload.get("response_metadata") or {}).get("next_cursor")
    if isinstance(next_page, str) and next_page.strip() and len(next_page) <= 1024:
        query["pageCursor"] = next_page
    else:
        query["cursor"] = query.pop("highWater", query["cursor"])
        query.pop("pageCursor", None)
    # Drain bounded pages before advancing the timestamp; never copy DM text.
    atomic_json(root / "state.json", state)
    # Filter completed/backoff entries BEFORE the bound. Retained receipts must
    # never occupy all dispatch slots and starve later owner requests.
    due = sorted(((ts, row) for ts, row in query["pending"].items()
                  if not row.get("sentAt") and now >= row.get("retryAt", 0)), key=lambda item: float(item[0]))[:3]
    if due:
        parts = []
        seen_choices = set()
        for _, pending in due:
            kind = pending.get("kind", "quota")
            index = pending.get("accountIndex")
            if kind not in {"help", "quota", "credits", "accounts", "watch", "controls", "account", "credit"}:
                kind, index = "help", None
            if kind in {"account", "credit"} and (type(index) is not int or not 1 <= index <= 16):
                kind, index = "help", None
            key = (kind, index)
            if key in seen_choices:
                continue
            seen_choices.add(key)
            try:
                parts.append(slack_command_result(kind, index, client, state, now))
            except WatchError:
                parts.append("*조회 실패*\n요청한 기능의 현재 정보를 가져오지 못했습니다. 계정·초기화권은 변경하지 않았습니다. 메뉴에서 다시 선택하세요.")
        message = "\n\n".join(parts) if parts else slack_help_text()
        if len(message) > 24000:
            message = message[:24000] + "\n\n일부 항목은 길이 제한으로 생략했습니다. 계정 1 또는 초기화권 1처럼 개별 조회하세요."
        # One fresh read and one answer satisfy a bounded batch of repeat queries.
        # Keep original timestamp receipts so a later history page cannot replay it.
        if len(due) > 1:
            message += f"\n미응답 명령 {len(due)}건을 함께 처리했습니다."
        request_id = "quota-query:" + ":".join(ts for ts, _ in due)
        try:
            response = slack_api("chat.postMessage", {"channel": channel,
                       "text": message, "unfurl_links": False,
                       "client_msg_id": deterministic_client_message_id(request_id)}, token, opener)
            for ts, pending in due:
                pending["sentAt"] = now
                pending["replyTs"] = response.get("ts")
        except WatchError as error:
            for ts, pending in due:
                pending["attempts"] = min(pending.get("attempts", 0) + 1, 8)
                pending["retryAt"] = now + min(3600, 10 * 2 ** pending["attempts"])
                pending["lastError"] = str(error)
        atomic_json(root / "state.json", state)
    complete = sorted((ts for ts, row in query["pending"].items() if row.get("sentAt")), key=float, reverse=True)
    for ts in complete[20:]:
        del query["pending"][ts]
    atomic_json(root / "state.json", state)


def find_account(rows, identity):
    return next((row for row in rows if row["identity"] == identity), None)


def run_pass(root: Path, state: dict, client: HubClient, now: float, send_enabled: bool, notify_enabled: bool,
             slack_config=None, slack_token=None, slack_opener=None):
    if not ntp_synchronized():
        raise WatchError("clock_unsynchronized")
    # The 10s Slack tick must not increase the 120s automatic quota/cycle polling rate.
    # Historical/removed accounts remain in the audit state. Their stale
    # per-account deadlines must not force an automatic hub refresh each tick.
    if now < float(state.get("nextCyclePollAt", 0)):
        if notify_enabled and slack_config is not None and slack_token is not None:
            if deliver_notifications(root, state, slack_config, slack_token, now, slack_opener):
                atomic_json(root / "state.json", state)
        return state
    rows = client.refresh_accounts()
    state["nextCyclePollAt"] = now + POLL_SECONDS
    for account in rows:
        selector = account["selector"]
        previous = state["accounts"].get(selector, {})
        if previous.get("identity") not in (None, account["identity"]):
            raise WatchError("identity_changed")
        if previous.get("window") not in (None, account["window"]):
            previous = {}
        current = dict(
            previous,
            identity=account["identity"],
            active=account.get("active") is True,
            plan=account["plan"],
            window=account["window"],
            blockReason=account.get("blockReason"),
            paused=account.get("paused") is True,
            initializationBlockReason=account.get("initializationBlockReason"),
            selectionExcludedReason=account.get("selectionExcludedReason"),
        )
        if now < float(previous.get("nextPollAt", 0)):
            continue
        sample = account["sample"]
        current, decision = advance(current, sample)
        if decision == "send":
            append_event(root, {
                "version": 1, "type": "reset_initialization", "at": now,
                "selector": selector, "identityPrefix": account["identity"][:12],
                "plan": account["plan"], "outcome": "detected",
            })
        if decision == "send" and send_enabled:
            fresh_rows = client.refresh_accounts()
            fresh_account = find_account(fresh_rows, account["identity"])
            if fresh_account is None or fresh_account["selector"] != selector:
                current = fail(current, now, "hub_error")
            elif not dormant(fresh_account["sample"]) or fresh_account["sample"]["at"] - sample["at"] > 30:
                current, _ = advance(current, fresh_account["sample"])
                suppressed_event_id = attempt_id(account["identity"], fresh_account["sample"]["at"]) + ":suppressed"
                message = (
                    f"OCX reset detected: {account['plan']} / {selector}. "
                    f"Another use already started the new {account['window']} window before the bounded initializer ran, "
                    f"so A1 suppressed its canary and spent no model tokens for initialization."
                )
                queue_notification(state, suppressed_event_id, message, now)
                append_event(root, {
                    "version": 1, "type": "reset_initialization", "at": now,
                    "selector": selector, "identityPrefix": account["identity"][:12],
                    "plan": account["plan"], "outcome": "suppressed", "reason": "fresh_usage_changed",
                })
            else:
                current = begin_attempt(current, fresh_account["sample"]["at"])
                event_id = attempt_id(account["identity"], fresh_account["sample"]["at"])
                current["attemptId"] = event_id
                state["accounts"][selector] = current
                atomic_json(root / "state.json", state)
                append_event(root, {
                    "version": 1, "type": "reset_initialization", "at": now,
                    "selector": selector, "identityPrefix": account["identity"][:12],
                    "plan": account["plan"], "outcome": "attempted",
                })
                try:
                    fresh_account["attemptId"] = event_id
                    client.start_cycle(fresh_account)
                    current["attempt"]["result"] = "completed"
                    current["status"] = "awaiting_window"
                    message = (
                        f"OCX reset initialization succeeded: {account['plan']} / {selector}. "
                        f"A1 detected a new dormant {account['window']} window and sent the bounded start request "
                        f"(input 1, Luna, reasoning off, one attempt; pause setting preserved)."
                    )
                    queue_notification(state, event_id + ":success", message, now)
                    append_event(root, {
                        "version": 1, "type": "reset_initialization", "at": now,
                        "selector": selector, "identityPrefix": account["identity"][:12],
                        "plan": account["plan"], "outcome": "succeeded",
                    })
                except WatchError as error:
                    current["status"] = "send_outcome_unknown"
                    message = (
                        f"OCX reset initialization needs attention: {account['plan']} / {selector}. "
                        f"Reset was detected but the bounded start request outcome is unknown; "
                        f"the watcher will not retry the inference automatically."
                    )
                    queue_notification(state, event_id + ":unknown", message, now)
                    append_event(root, {
                        "version": 1, "type": "reset_initialization", "at": now,
                        "selector": selector, "identityPrefix": account["identity"][:12],
                        "plan": account["plan"], "outcome": "failed", "reason": str(error),
                    })
        elif decision == "send":
            current["status"] = "read_only"
        state["accounts"][selector] = current
        atomic_json(root / "state.json", state)

    if notify_enabled and slack_config is not None and slack_token is not None:
        deliver_notifications(root, state, slack_config, slack_token, now, slack_opener)
    atomic_json(root / "state.json", state)
    return state


def status_summary(state):
    return {
        "accounts": [
            {
                "selector": selector,
                "identityHash": row.get("identity"),
                "active": row.get("active") is True,
                "plan": row.get("plan"),
                "window": row.get("window", "weekly"),
                "status": row.get("status", "unknown"),
                "lastObservationAt": (row.get("sample") or {}).get("at"),
                "resetAt": (row.get("sample") or {}).get("deadline"),
                "attemptPending": "attempt" in row,
                "blockReason": row.get("blockReason"),
                "paused": row.get("paused") is True,
                "initializationBlockReason": row.get("initializationBlockReason"),
                "selectionExcludedReason": row.get("selectionExcludedReason"),
            }
            for selector, row in sorted(state["accounts"].items())
        ],
        "pendingSlack": sum(1 for row in state["notifications"].values() if not row.get("sentAt")),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "status", "identity-status", "slack-verify", "slack-test"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--ocx", default=DEFAULT_OCX)
    parser.add_argument("--hub-config", default=DEFAULT_HUB_CONFIG, type=Path)
    parser.add_argument("--slack-config", type=Path)
    parser.add_argument("--send", action="store_true")
    parser.add_argument("--notify", action="store_true")
    args = parser.parse_args()
    try:
        root = validate_root(args.root)
        ensure_private_dir(root)
        if args.action == "status":
            print(json.dumps(status_summary(load_state(root)), sort_keys=True))
            return 0
        if args.action == "identity-status":
            client = HubClient(args.ocx, args.hub_config)
            print(json.dumps({
                "schemaVersion": 1,
                "source": "a1-ocx-hub",
                "observedAt": time.time(),
                "accounts": client.identity_status(),
            }, sort_keys=True))
            return 0
        slack_config = load_slack_config(args.slack_config) if args.slack_config else None
        token = credential_token() if args.notify or args.action.startswith("slack-") else None
        if args.action == "slack-verify":
            verify_slack(slack_config, token)
            print(json.dumps({"ok": True, "slackVerified": True}))
            return 0
        if args.action == "slack-test":
            verify_slack(slack_config, token)
            event_id = "cycle-watch-canary:" + str(int(time.time()))
            send_slack(slack_config, token, event_id,
                       "A1 OCX reset-cycle watcher: server-side Slack delivery canary OK.")
            print(json.dumps({"ok": True, "slackCanarySent": True}))
            return 0
        with locked(root):
            state = load_state(root)
            client = HubClient(args.ocx, args.hub_config)
            now = time.time()
            if args.notify and slack_config is not None and token is not None:
                try:
                    poll_quota_queries(root, state, client, slack_config, token, now)
                except WatchError as error:
                    # Slack failure must not delay the independent cycle initializer.
                    append_event(root, {"version": 1, "type": "quota_query", "at": now,
                                       "outcome": "read_failed", "reason": str(error)})
            run_pass(root, state, client, now, args.send, args.notify, slack_config, token)
            print(json.dumps(status_summary(state), sort_keys=True))
        return 0
    except WatchError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

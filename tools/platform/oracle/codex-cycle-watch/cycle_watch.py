#!/usr/bin/env python3
"""Opt-in Linux cycle watcher with explicitly enrolled server-only token renewal."""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
from email.utils import parsedate_to_datetime

from cycle_policy import WatchError, advance, begin_attempt, dormant, fail, number, observation

ROOT_NAME = "aicc-codex-cycle-watch"
USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
RESPONSE_URL = "https://chatgpt.com/backend-api/codex/responses"
TOKEN_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
MAX_FILE = 262144
MAX_RESPONSE = 524288
MAX_EVENT = 4096
STATUSES = {"watching", "confirming_dormant", "dormant_confirmed", "cycle_started",
            "awaiting_window", "send_outcome_unknown", "credential_expired", "unauthorized",
            "http_error", "network_error", "response_too_large", "invalid_usage",
            "weekly_window_unknown", "inconsistent_server_clock", "invalid_response", "read_only", "daily_send_cap",
            "renewal_failed"}


def validate_root(root):
    candidate = Path(root)
    if not candidate.is_absolute() or candidate.name != ROOT_NAME or ".." in candidate.parts:
        raise WatchError("invalid_root")
    # Do not accept symlinked ancestors, not just a final symlink.
    if any(p.is_symlink() for p in [candidate, *candidate.parents]):
        raise WatchError("symlink_refused")
    return candidate


def private_path(path, directory=False):
    if os.name != "posix":
        raise WatchError("linux_storage_required")
    info = path.lstat()
    valid_kind = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid_kind or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise WatchError("private_storage_required")
    if not directory and info.st_nlink != 1:
        raise WatchError("hardlink_refused")


def read_json(path):
    private_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        raw = stream.read(MAX_FILE + 1)
    if len(raw) > MAX_FILE:
        raise WatchError("file_too_large")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise WatchError("invalid_json") from None


def atomic_json(path, value):
    private_path(path.parent, directory=True)
    if path.exists() or path.is_symlink():
        private_path(path)
    content = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()
    if len(content) > MAX_FILE:
        raise WatchError("file_too_large")
    descriptor, temporary = tempfile.mkstemp(prefix=".cycle-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def append_event(path, value):
    """Durably append one private, bounded JSON event without following links."""
    private_path(path.parent, directory=True)
    if path.exists() or path.is_symlink():
        private_path(path)
    content = (json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
    if len(content) > MAX_EVENT:
        raise WatchError("file_too_large")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077 or info.st_nlink != 1):
            raise WatchError("private_storage_required")
        os.write(fd, content)
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def locked(root):
    import fcntl
    path = root / "watch.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        private_path(path)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise WatchError("already_running") from None
        yield
    finally:
        os.close(fd)


def decode_claims(token):
    try:
        middle = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(middle + "=" * (-len(middle) % 4)))
    except (ValueError, IndexError, TypeError):
        raise WatchError("invalid_credential") from None


def credentials(document):
    if not isinstance(document, dict) or set(document) != {"version", "accounts"} or document["version"] != 1:
        raise WatchError("invalid_credentials")
    rows = document["accounts"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 16:
        raise WatchError("invalid_credentials")
    seen_aliases, seen_identities, result = set(), set(), []
    for row in rows:
        required = {"alias", "accessToken", "chatgptAccountId"}
        if not isinstance(row, dict) or not required <= set(row) or set(row) - required - {"refreshToken"}:
            raise WatchError("invalid_credentials")
        if "refreshToken" in row and (not isinstance(row["refreshToken"], str)
                                     or not 10 < len(row["refreshToken"]) < 16000):
            raise WatchError("invalid_credential")
        alias, token, workspace = (row[k] for k in ("alias", "accessToken", "chatgptAccountId"))
        if not isinstance(alias, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", alias):
            raise WatchError("invalid_alias")
        if not isinstance(token, str) or not 10 < len(token) < 16000 or not isinstance(workspace, str) or not workspace:
            raise WatchError("invalid_credential")
        claims = decode_claims(token)
        if not isinstance(claims, dict):
            raise WatchError("invalid_credential")
        subject, expires = claims.get("sub"), claims.get("exp")
        if not isinstance(subject, str) or not subject or not number(expires) or expires <= 0:
            raise WatchError("invalid_credential")
        identity = hashlib.sha256((subject + "\0" + workspace).encode()).hexdigest()
        if alias in seen_aliases or identity in seen_identities:
            raise WatchError("duplicate_account")
        seen_aliases.add(alias)
        seen_identities.add(identity)
        result.append(dict(row, identity=identity, expires=expires))
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise WatchError("http_error")


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, account, url, body=None):
        if url not in (USAGE_URL, RESPONSE_URL, TOKEN_URL):
            raise WatchError("http_error")
        headers = {"Authorization": "Bearer " + account["accessToken"],
                   "ChatGPT-Account-Id": account["chatgptAccountId"],
                   "Content-Type": "application/json", "Cache-Control": "no-cache"}
        if url == TOKEN_URL:
            headers = {"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"}
        request = urllib.request.Request(url, data=body, headers=headers)
        try:
            with self.opener.open(request, timeout=25) as response:
                started = time.monotonic()
                chunks, size = [], 0
                while True:
                    chunk = response.read1(8192)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_RESPONSE:
                        raise WatchError("response_too_large")
                    if time.monotonic() - started > 35:
                        raise WatchError("network_error")
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get("Date")
        except urllib.error.HTTPError as error:
            error.close()
            raise WatchError("unauthorized" if error.code in (401, 403) else "http_error") from None
        except (OSError, urllib.error.URLError, TimeoutError):
            raise WatchError("network_error") from None

    def refresh(self, account, now):
        body = urllib.parse.urlencode({"grant_type": "refresh_token", "client_id": CLIENT_ID,
                                       "refresh_token": account["refreshToken"]}).encode()
        raw, _ = self.request(account, TOKEN_URL, body)
        try:
            data = json.loads(raw)
            row = {k: account[k] for k in ("alias", "accessToken", "chatgptAccountId", "refreshToken")}
            row["accessToken"] = data["access_token"]
            row["refreshToken"] = data.get("refresh_token", account["refreshToken"])
            replacement = credentials({"version": 1, "accounts": [row]})[0]
            if replacement["identity"] != account["identity"] or replacement["expires"] <= now + 300:
                raise WatchError("renewal_failed")
            claims = decode_claims(replacement["accessToken"])
            token_workspace = claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
            if token_workspace is not None and token_workspace != account["chatgptAccountId"]:
                raise WatchError("renewal_failed")
            return replacement
        except (ValueError, TypeError, KeyError, AttributeError, WatchError):
            raise WatchError("renewal_failed") from None

    def usage(self, account):
        raw, server_date = self.request(account, USAGE_URL)
        try:
            stamp = parsedate_to_datetime(server_date).timestamp()
            if abs(stamp - time.time()) > 60:
                raise WatchError("inconsistent_server_clock")
            return observation(json.loads(raw), stamp)
        except (ValueError, TypeError, UnicodeError):
            raise WatchError("invalid_usage") from None

    def hello(self, account):
        # This is a new, stateless Codex turn whose only job is to start the
        # account's rolling usage window. Keep both visible and hidden work
        # bounded: Luna is the lowest-cost enabled Codex model, reasoning is
        # disabled, no tools/history are attached, and output cannot grow.
        body = {"model": "gpt-5.6-luna", "instructions": "Return 1.",
                "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "1"}]}],
                "reasoning": {"effort": "none"}, "max_output_tokens": 16,
                "stream": True, "store": False}
        raw, _ = self.request(account, RESPONSE_URL, json.dumps(body).encode())
        completed, failed = False, False
        try:
            for line in raw.decode().splitlines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                event = json.loads(line[6:])
                if event.get("type") == "response.completed":
                    completed = event.get("response", {}).get("status") == "completed"
                if event.get("type") in ("error", "response.failed", "response.incomplete"):
                    failed = True
        except (UnicodeError, ValueError, AttributeError):
            raise WatchError("invalid_response") from None
        if not completed or failed:
            raise WatchError("invalid_response")


def run_accounts(accounts, state, client, persist, now, send_enabled, renew=None, event_log=None):
    """One bounded pass. Injected interfaces make crash ordering testable."""
    event_log = event_log or (lambda _event: None)
    for account in accounts:
        alias = account["alias"]
        previous = state["accounts"].get(alias, {})
        if previous.get("identity") not in (None, account["identity"]):
            raise WatchError("identity_changed")
        current = dict(previous, identity=account["identity"])
        if now < previous.get("nextPollAt", 0):
            continue
        if account["expires"] <= now + 300 and "refreshToken" in account and renew is not None:
            try:
                renew(account, now)
            except WatchError:
                state["accounts"][alias] = fail(current, now, "renewal_failed")
                persist(state)
                continue
        if account["expires"] <= now + 60:
            state["accounts"][alias] = fail(current, now, "credential_expired")
            persist(state)
            continue
        reset_detected = False
        terminal_event = False
        try:
            sample = client.usage(account)
            current, decision = advance(current, sample)
            if decision == "send":
                reset_detected = True
                event_log({"version": 1, "type": "reset_initialization", "at": now,
                           "alias": alias, "identityPrefix": account["identity"][:12],
                           "outcome": "detected", "resetAt": sample.get("deadline")})
            if decision == "send" and send_enabled:
                # An actual user may have used/reset the account since the poll.
                fresh = client.usage(account)
                if not dormant(fresh) or fresh["at"] - sample["at"] > 30:
                    current, _ = advance(current, fresh)
                    event_log({"version": 1, "type": "reset_initialization", "at": now,
                               "alias": alias, "identityPrefix": account["identity"][:12],
                               "outcome": "suppressed", "reason": "fresh_usage_changed"})
                    terminal_event = True
                else:
                    current = begin_attempt(current, fresh["at"])
                    state["accounts"][alias] = current
                    persist(state)  # must be durable BEFORE any potentially accepted POST
                    event_log({"version": 1, "type": "reset_initialization", "at": now,
                               "alias": alias, "identityPrefix": account["identity"][:12],
                               "outcome": "attempted"})
                    client.hello(account)
                    current["attempt"]["result"] = "completed"
                    current["status"] = "awaiting_window"
                    event_log({"version": 1, "type": "reset_initialization", "at": now,
                               "alias": alias, "identityPrefix": account["identity"][:12],
                               "outcome": "succeeded"})
                    terminal_event = True
            elif decision == "send":
                current["status"] = "read_only"
                event_log({"version": 1, "type": "reset_initialization", "at": now,
                           "alias": alias, "identityPrefix": account["identity"][:12],
                           "outcome": "skipped", "reason": "send_disabled"})
                terminal_event = True
        except WatchError as error:
            code = str(error) if str(error) in STATUSES else "http_error"
            current = fail(current, now, code)
            if reset_detected and not terminal_event:
                event_log({"version": 1, "type": "reset_initialization", "at": now,
                           "alias": alias, "identityPrefix": account["identity"][:12],
                           "outcome": "failed", "reason": code})
        state["accounts"][alias] = current
        persist(state)
    return state


def renewer(document, client, save):
    """Called only while the runtime lock is held. Never touches source auth stores."""
    def renew(account, now):
        replacement = client.refresh(account, now)
        updated = {"version": document["version"], "accounts": [dict(row) for row in document["accounts"]]}
        row = next(row for row in updated["accounts"] if row["alias"] == account["alias"])
        for key in ("accessToken", "refreshToken"):
            row[key] = replacement[key]
        credentials(updated)
        save(updated)  # persistence failure aborts before usage/inference
        document.update(updated)
        account.update(replacement)
    return renew


def load_state(root):
    path = root / "state.json"
    if not path.exists() and not path.is_symlink():
        return {"version": 1, "accounts": {}}
    state = read_json(path)
    if not isinstance(state, dict) or set(state) != {"version", "accounts"} or state["version"] != 1 or not isinstance(state["accounts"], dict):
        raise WatchError("invalid_state")
    if len(state["accounts"]) > 16:
        raise WatchError("invalid_state")
    for alias, row in state["accounts"].items():
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", alias) or not isinstance(row, dict):
            raise WatchError("invalid_state")
        if set(row) - {"identity", "sample", "failures", "nextPollAt", "attempt", "attemptTimes", "status", "lastStartedAt"}:
            raise WatchError("invalid_state")
        if not re.fullmatch(r"[0-9a-f]{64}", str(row.get("identity", ""))) or row.get("status") not in STATUSES:
            raise WatchError("invalid_state")
        for key in ("nextPollAt", "lastStartedAt", "failures"):
            if key in row and (not number(row[key]) or row[key] < 0):
                raise WatchError("invalid_state")
        times = row.get("attemptTimes", [])
        if not isinstance(times, list) or len(times) > 4 or any(not number(item) or item < 0 for item in times):
            raise WatchError("invalid_state")
        sample = row.get("sample")
        if sample is not None:
            if not isinstance(sample, dict) or set(sample) != {"at", "used", "deadline", "remaining", "allowed"}:
                raise WatchError("invalid_state")
            if any(not number(sample[k]) for k in ("at", "used", "deadline", "remaining")) or type(sample["allowed"]) is not bool:
                raise WatchError("invalid_state")
            if not 0 <= sample["used"] <= 100 or not 0 <= sample["remaining"] <= 604808:
                raise WatchError("invalid_state")
        attempt = row.get("attempt")
        if attempt is not None:
            if not isinstance(attempt, dict) or set(attempt) != {"at", "result"} or not number(attempt["at"]) or attempt["result"] not in ("unknown", "completed"):
                raise WatchError("invalid_state")
    return state


def summary(state):
    return {"accounts": [{"alias": alias, "status": row.get("status", "unknown"),
                          "lastObservationAt": row.get("sample", {}).get("at"),
                          "weeklyResetAt": row.get("sample", {}).get("deadline"),
                          "nextPollAt": row.get("nextPollAt"), "attemptPending": "attempt" in row}
                         for alias, row in state["accounts"].items()]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "run"])
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--send", action="store_true", help="allow fixed hello only after confirmed dormant week")
    parser.add_argument("--dry-run", action="store_true", help="validate paths only; no IO writes or network")
    args = parser.parse_args()
    try:
        root = validate_root(args.root)
        if args.dry_run:
            print(json.dumps({"action": args.action, "send": args.send, "mutation": False, "pollSeconds": 120}))
            return 0
        if not sys.platform.startswith("linux") or os.getuid() == 0:
            raise WatchError("nonroot_linux_user_required")
        private_path(root, directory=True)
        if args.action == "status":
            print(json.dumps(summary(load_state(root))))
            return 0
        with locked(root):
            document = read_json(root / "credentials.json")
            enrolled = credentials(document)
            state = load_state(root)
            if set(state["accounts"]) - {a["alias"] for a in enrolled}:
                raise WatchError("enrollment_changed")
            client = Client()
            renew = renewer(document, client, lambda value: atomic_json(root / "credentials.json", value))
            run_accounts(enrolled, state, client, lambda value: atomic_json(root / "state.json", value),
                         time.time(), args.send, renew, lambda value: append_event(root / "events.jsonl", value))
            print(json.dumps(summary(state)))
        return 0
    except (WatchError, OSError, ValueError, TypeError, KeyError):
        # Unexpected data/OS messages can contain paths or credentials; never echo them.
        print(json.dumps({"status": "blocked", "reason": "inspect_protected_configuration_or_runtime"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

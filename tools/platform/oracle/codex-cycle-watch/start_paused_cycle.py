#!/usr/bin/env python3
"""Internal A1 one-shot initializer. No selection changes or credential writes."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request

from hub_cycle_watch import read_json, validate_root, ensure_private_dir, WatchError

HOME = Path("/demo/owner/.opencodex-hub")
ROOT = Path("/demo/owner/.local/state/aicc-ocx-cycle-watch")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise WatchError("initializer_redirect_refused")


def initialize(selector, identity, attempt_id):
    if (not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", selector) or selector == "main"
            or not re.fullmatch(r"[a-f0-9]{64}", identity)
            or not re.fullmatch(r"cycle:[a-f0-9]{32}", attempt_id)):
        raise WatchError("initializer_refused")
    validate_root(ROOT)
    ensure_private_dir(ROOT)
    config = read_json(HOME / "config.json")
    account_id = (config.get("codexAccountNamespaces") or {}).get(selector)
    if (not isinstance(account_id, str) or account_id == "@main"
            or hashlib.sha256(account_id.encode()).hexdigest() != identity
            or not any(row.get("id") == account_id and not row.get("isMain")
                       for row in config.get("codexAccounts", []))):
        raise WatchError("initializer_identity_mismatch")
    provider = (config.get("providers") or {}).get("openai") or {}
    if provider.get("baseUrl") != "https://chatgpt.com/backend-api/codex" or provider.get("authMode") != "forward":
        raise WatchError("initializer_provider_mismatch")
    state = read_json(ROOT / "state.json")
    pending = state.get("accounts", {}).get(selector, {})
    attempt = pending.get("attempt") or {}
    age = time.time() - float(attempt.get("at", 0))
    if (pending.get("identity") != identity or pending.get("attemptId") != attempt_id
            or attempt.get("result") != "unknown" or not -2 <= age <= 30
            or (pending.get("sample") or {}).get("allowed") is not True
            or (pending.get("sample") or {}).get("used") != 0
            or pending.get("initializationBlockReason")):
        raise WatchError("initializer_pending_fence")
    # Read-only access snapshot after the parent's fresh hub quota refresh.
    # The hub remains the refresh-grant writer; never renew credentials here.
    record = read_json(HOME / "codex-accounts.json").get(account_id)
    if not isinstance(record, dict) or record.get("deletedAt") is not None or record.get("codexValidationPending"):
        raise WatchError("initializer_credential_unavailable")
    credential = record.get("credential") or record
    token, physical_id = credential.get("accessToken"), credential.get("chatgptAccountId")
    expires = credential.get("expiresAt")
    if (not isinstance(token, str) or not token or not isinstance(physical_id, str) or not physical_id
            or not isinstance(expires, (int, float)) or expires < (time.time() + 60) * 1000):
        raise WatchError("initializer_access_expired")
    # Re-check registration and credential generation without exposing secrets.
    latest = read_json(HOME / "config.json")
    if (latest.get("codexAccountNamespaces") or {}).get(selector) != account_id:
        raise WatchError("initializer_identity_mismatch")
    current = read_json(HOME / "codex-accounts.json").get(account_id) or {}
    current_credential = current.get("credential") or current
    if (current.get("generation") != record.get("generation") or current.get("deletedAt") is not None
            or current_credential.get("accessToken") != token or current_credential.get("chatgptAccountId") != physical_id):
        raise WatchError("initializer_credential_changed")
    claims = ROOT / "initializer-claims"
    ensure_private_dir(claims)
    claim = claims / (attempt_id[6:] + ".json")
    fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump({"identity": identity, "attemptId": attempt_id, "claimedAt": time.time()}, out)
        out.flush()
        os.fsync(out.fileno())
    directory = os.open(claims, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    # Canonical Codex rejects max_output_tokens. Keep a fixed one-character
    # task, no reasoning, a deadline and a streamed-output guard instead.
    body = {"model": "gpt-5.6-luna", "instructions": "Return exactly 1 and nothing else.",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "1"}]}],
            "reasoning": {"effort": "none"}, "stream": True, "store": False}
    request = urllib.request.Request("https://chatgpt.com/backend-api/codex/responses",
        data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": "Bearer " + token, "ChatGPT-Account-Id": physical_id,
                 "Content-Type": "application/json", "Accept": "text/event-stream"})
    deadline = time.monotonic() + 30
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        if response.status != 200:
            raise WatchError("send_outcome_unknown")
        size, output_chars, frame = 0, 0, []
        while time.monotonic() < deadline:
            line = response.readline(65537)
            size += len(line)
            if not line or size > 512 * 1024 or len(line) > 65536:
                break
            if line.strip():
                if line.startswith(b"data:"):
                    frame.append(line[5:].strip())
                continue
            data = b"\n".join(frame)
            frame = []
            if not data or data == b"[DONE]":
                continue
            event = json.loads(data)
            if event.get("type") == "response.output_text.delta":
                output_chars += len(str(event.get("delta", "")))
                if output_chars > 16:
                    break
            if event.get("type") in ("error", "response.failed", "response.incomplete"):
                break
            if event.get("type") == "response.completed" and (event.get("response") or {}).get("status") == "completed":
                return {"completed": True, "pausePreserved": True}
    raise WatchError("send_outcome_unknown")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise WatchError("initializer_refused")
        print(json.dumps(initialize(*sys.argv[1:])))
    except Exception:
        # Do not echo provider content, credentials or exception diagnostics.
        print(json.dumps({"completed": False, "error": "send_outcome_unknown"}))
        raise SystemExit(2)

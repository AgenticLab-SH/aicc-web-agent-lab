"""Pure, conservative long-window cycle detection. No credentials, IO or model calls."""
from __future__ import annotations

import math

WEEK = 604800
MONTH = 30 * 24 * 3600
POLL_SECONDS = 120
MAX_SAMPLE_AGE = 600
TOLERANCE = 8


class WatchError(Exception):
    """Only fixed, non-sensitive error codes may leave the runtime."""


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def observation(payload, server_time):
    rate = payload.get("rate_limit") if isinstance(payload, dict) else None
    if not isinstance(rate, dict) or not number(server_time):
        raise WatchError("invalid_usage")
    windows = [rate.get(key) for key in ("primary_window", "secondary_window", "tertiary_window")]
    weekly = [w for w in windows if isinstance(w, dict) and w.get("limit_window_seconds") == WEEK]
    if len(weekly) != 1:
        raise WatchError("weekly_window_unknown")
    window = weekly[0]
    used, deadline, remaining = (window.get(k) for k in ("used_percent", "reset_at", "reset_after_seconds"))
    if not all(number(v) for v in (used, deadline, remaining)):
        raise WatchError("invalid_usage")
    if not 0 <= used <= 100 or not 0 <= remaining <= WEEK + TOLERANCE:
        raise WatchError("invalid_usage")
    if abs(deadline - server_time - remaining) > TOLERANCE:
        raise WatchError("inconsistent_server_clock")
    allowed = rate.get("allowed") is True and rate.get("limit_reached") is False
    return {"at": server_time, "used": used, "deadline": deadline,
            "remaining": remaining, "allowed": allowed}


def full_window_seconds(sample):
    value = sample.get("windowSeconds", WEEK)
    return float(value) if number(value) and value > 0 else None


def dormant(sample):
    window = full_window_seconds(sample)
    return (window is not None
            and sample["allowed"]
            and sample["used"] == 0
            and abs(sample["remaining"] - window) <= TOLERANCE)


def moving_full_window(previous, current):
    if not previous or not dormant(previous) or not dormant(current):
        return False
    previous_window = full_window_seconds(previous)
    current_window = full_window_seconds(current)
    if previous_window is None or current_window is None or abs(previous_window - current_window) > TOLERANCE:
        return False
    elapsed = current["at"] - previous["at"]
    movement = current["deadline"] - previous["deadline"]
    return POLL_SECONDS - 10 <= elapsed <= MAX_SAMPLE_AGE and abs(movement - elapsed) <= TOLERANCE


def advance(state, current):
    """Return (new state, decision). Sending is performed by the separately locked IO layer."""
    updated = dict(state)
    previous = state.get("sample")
    updated["sample"] = current
    updated["failures"] = 0
    updated["nextPollAt"] = current["at"] + POLL_SECONDS
    pending = state.get("attempt")
    if pending:
        # Never clear a pending send merely because the API still says 0%.
        # Require a fixed deadline or nonzero usage AND a genuinely started window.
        fixed = previous and abs(current["deadline"] - previous["deadline"]) <= TOLERANCE
        window = full_window_seconds(current) or WEEK
        started = current["remaining"] < window - TOLERANCE and (current["used"] > 0 or fixed)
        if started and current["at"] >= pending["at"]:
            updated.pop("attempt", None)
            updated["lastStartedAt"] = current["at"]
            updated["status"] = "cycle_started"
        else:
            updated["status"] = "awaiting_window" if pending["result"] == "completed" else "send_outcome_unknown"
        return updated, "observe"
    if moving_full_window(previous, current):
        recent = [at for at in state.get("attemptTimes", []) if 0 <= current["at"] - at < 86400]
        if len(recent) >= 4:
            updated["status"] = "daily_send_cap"
            return updated, "observe"
        updated["status"] = "dormant_confirmed"
        return updated, "send"
    updated["status"] = "confirming_dormant" if dormant(current) else "watching"
    return updated, "observe"


def begin_attempt(state, at):
    updated = dict(state)
    updated["attemptTimes"] = [item for item in state.get("attemptTimes", []) if 0 <= at - item < 86400] + [at]
    updated["attempt"] = {"at": at, "result": "unknown"}
    updated["status"] = "send_outcome_unknown"
    return updated


def fail(state, now, code):
    updated = dict(state)
    count = min(int(state.get("failures", 0)) + 1, 8)
    updated.update(failures=count, status=code,
                   nextPollAt=now + min(3600, POLL_SECONDS * 2 ** (count - 1)))
    return updated

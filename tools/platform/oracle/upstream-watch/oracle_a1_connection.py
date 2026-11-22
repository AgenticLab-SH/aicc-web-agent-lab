"""Shared local/Micro boundary for the owner-only Oracle A1 contract."""

from __future__ import annotations

import json
import stat
from pathlib import Path


def load_bastion_config(path: Path) -> dict[str, str]:
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise PermissionError("Oracle connection config must be mode 0600")
    data = json.loads(path.read_text(encoding="utf-8"))
    required = {"bastion_target", "identity_file"}
    if required - set(data):
        raise KeyError("Oracle bastion config is incomplete")
    return {key: str(data[key]) for key in required}


def remote_contract_prelude() -> str:
    return """A1_CONNECTION="$HOME/.local/bin/oracle-a1-connection"
A1_CONFIG="$HOME/.config/oracle-a1/connection.json"
test "$(stat -c '%a' "$A1_CONNECTION")" = 700
test "$(stat -c '%a' "$A1_CONFIG")" = 600
"$A1_CONNECTION" status </dev/null >/dev/null
"""

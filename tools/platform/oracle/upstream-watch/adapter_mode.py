#!/usr/bin/env python3
"""Enable or disable only the optional Oracle upstream observer timer."""

from __future__ import annotations

import argparse
import shlex
import subprocess
from pathlib import Path

from oracle_a1_connection import load_bastion_config, remote_contract_prelude


TIMER = "open-aicc-upstream-watch.timer"
SERVICE = "open-aicc-upstream-watch.service"


def command(args: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, check=True)
    return result.stdout


def apply_mode(config: dict[str, str], mode: str) -> str:
    identity = str(Path(config["identity_file"]).expanduser())
    operation = "disable --now" if mode == "disabled" else "enable --now"
    expected_active = "inactive" if mode == "disabled" else "active"
    script = f"""set -euo pipefail
{remote_contract_prelude()}
"$A1_CONNECTION" exec -- bash -s <<'REMOTE'
set -euo pipefail
timer={shlex.quote(TIMER)}
service={shlex.quote(SERVICE)}
test "$(systemctl show "$service" -p Type --value)" = oneshot
test "$(systemctl show "$service" -p ActiveState --value)" != active
sudo systemctl {operation} "$timer"
test "$(systemctl show "$timer" -p UnitFileState --value)" = {shlex.quote(mode)}
test "$(systemctl show "$timer" -p ActiveState --value)" = {shlex.quote(expected_active)}
printf 'timer=%s unit=%s active=%s service=%s\n' \
  "$timer" \
  "$(systemctl show "$timer" -p UnitFileState --value)" \
  "$(systemctl show "$timer" -p ActiveState --value)" \
  "$(systemctl show "$service" -p ActiveState --value)"
REMOTE
"""
    return command([
        "ssh", "-i", identity, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
        config["bastion_target"], "bash", "-s",
    ], input_text=script)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connection-config", type=Path, required=True)
    parser.add_argument("--mode", choices=("disabled", "enabled"), required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply:
        print(f"WHAT_IF: {TIMER} -> {args.mode}; add --apply after local verification")
        return 0
    config = load_bastion_config(args.connection_config.expanduser())
    output = apply_mode(config, args.mode)
    print("\n".join(line for line in output.splitlines() if line.startswith("timer=")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

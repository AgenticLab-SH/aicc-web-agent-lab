#!/usr/bin/env python3
"""Exact Linux user-unit installer and receipt-bound stop/rollback. No SSH/auth writes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from cycle_policy import WatchError
from cycle_watch import atomic_json, credentials, locked, private_path, read_json, validate_root

UNIT = "aicc-codex-cycle-watch"
PROGRAMS = ("cycle_policy.py", "cycle_watch.py", "service.py")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def units(root, executable):
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(root)) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", executable):
        raise WatchError("unsafe_unit_path")
    service = f"""[Unit]
Description=Explicit-account Codex weekly cycle watcher
After=network-online.target

[Service]
Type=oneshot
ExecStart={executable} -B {root}/program/cycle_watch.py run --root {root} --send
WorkingDirectory={root}
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={root}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
TimeoutStartSec=240
StandardOutput=journal
StandardError=journal
"""
    timer = f"""[Unit]
Description=Check Codex weekly cycles every two minutes without inference

[Timer]
OnBootSec=30s
OnUnitInactiveSec=120s
AccuracySec=5s
RandomizedDelaySec=0
Unit={UNIT}.service

[Install]
WantedBy=timers.target
"""
    return {UNIT + ".service": service.encode(), UNIT + ".timer": timer.encode()}


def unit_dir():
    return Path.home() / ".config" / "systemd" / "user"


def systemctl(*args):
    result = subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise WatchError("systemd_operation_failed")
    return result.stdout.strip()


def build_plan(root, executable, directory, source):
    rendered = units(root, executable)
    files = {name: (source / name).read_bytes() for name in PROGRAMS}
    if any(len(data) > 262144 for data in files.values()):
        raise WatchError("program_too_large")
    snapshot = {"root": str(root), "python": executable, "unitDirectory": str(directory),
                "units": {name: digest(data) for name, data in rendered.items()},
                "programs": {name: digest(data) for name, data in files.items()},
                "preexisting": {name: (directory / name).exists() or (directory / name).is_symlink() for name in rendered}}
    snapshot["confirmation"] = digest(json.dumps(snapshot, sort_keys=True).encode())
    return snapshot, rendered, files


def write_new(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def check_receipt(root, directory):
    receipt = read_json(root / "install-receipt.json")
    if receipt.get("unit") != UNIT or receipt.get("root") != str(root) or receipt.get("unitDirectory") != str(directory):
        raise WatchError("wrong_receipt")
    if receipt.get("status") not in ("prepared", "installed", "stopped", "rolled_back") or set(receipt.get("units", {})) != {UNIT + ".service", UNIT + ".timer"}:
        raise WatchError("invalid_receipt")
    for name, expected in receipt["units"].items():
        path = directory / name
        if path.exists() or path.is_symlink():
            private_path(path)
            if digest(path.read_bytes()) != expected:
                raise WatchError("unit_drift")
    return receipt


def stop_or_rollback(root, directory, rollback=False):
    receipt = check_receipt(root, directory)
    if receipt["status"] == "rolled_back":
        raise WatchError("already_rolled_back")
    # These exact units are the whole recovery unit. Auth/state/program are preserved.
    for suffix in (".timer", ".service"):
        if (directory / (UNIT + suffix)).exists():
            systemctl("stop", UNIT + suffix)
    if (directory / (UNIT + ".timer")).exists():
        systemctl("disable", UNIT + ".timer")
    with locked(root):
        receipt = check_receipt(root, directory)
        if rollback:
            for name in receipt["units"]:
                path = directory / name
                if path.exists():
                    path.unlink()
            systemctl("daemon-reload")
        receipt["status"] = "rolled_back" if rollback else "stopped"
        atomic_json(root / "install-receipt.json", receipt)
    return {"status": receipt["status"], "credentialsPreserved": True, "statePreserved": True}


def install(root, executable, directory, source, confirmation):
    plan, rendered, files = build_plan(root, executable, directory, source)
    if confirmation != plan["confirmation"] or any(plan["preexisting"].values()):
        raise WatchError("fresh_plan_required")
    if (root / "install-receipt.json").exists() or (root / "program").exists():
        raise WatchError("existing_installation_refused")
    credentials(read_json(root / "credentials.json"))
    # Existing linger only. This installer never enables a system-level privilege.
    linger = subprocess.run(["loginctl", "show-user", str(os.getuid()), "-p", "Linger", "--value"],
                            capture_output=True, text=True, timeout=15)
    if linger.returncode or linger.stdout.strip() != "yes":
        raise WatchError("existing_user_linger_required")
    systemctl("show", "--property=Version", "--value")
    receipt = {"unit": UNIT, "root": str(root), "unitDirectory": str(directory),
               "status": "prepared", "units": plan["units"], "programs": plan["programs"]}
    atomic_json(root / "install-receipt.json", receipt)
    (root / "program").mkdir(mode=0o700)
    for name, data in files.items():
        write_new(root / "program" / name, data)
    for name, data in rendered.items():
        write_new(directory / name, data)
    systemctl("daemon-reload")
    systemctl("enable", "--now", UNIT + ".timer")
    systemctl("is-active", UNIT + ".timer")
    receipt["status"] = "installed"
    atomic_json(root / "install-receipt.json", receipt)
    return {"status": "installed", "pollSeconds": 120, "unit": UNIT}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "install", "status", "stop", "rollback"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--unit", choices=[UNIT], required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--confirm", help="fresh install plan SHA; stop/rollback require the exact unit name")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        root = validate_root(args.root)
        directory = unit_dir()
        if args.dry_run or args.action == "plan":
            # No mkdir, state, auth reads, systemctl or network on this path.
            plan, _, _ = build_plan(root, args.python, directory, Path(__file__).parent)
            print(json.dumps(dict(plan, action=args.action, mutation=False)))
            return 0
        if not sys.platform.startswith("linux") or os.getuid() == 0:
            raise WatchError("nonroot_linux_user_required")
        private_path(root, directory=True)
        # The containing systemd directory may be 0755, but must be owned,
        # non-symlinked and not writable by group/others.
        for ancestor in [directory, *directory.parents]:
            if ancestor.is_symlink():
                raise WatchError("symlink_refused")
        info = directory.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise WatchError("unsafe_unit_directory")
        if args.action == "status":
            receipt = check_receipt(root, directory)
            timer = "absent" if receipt["status"] == "rolled_back" else systemctl("show", UNIT + ".timer", "-p", "ActiveState", "--value")
            print(json.dumps({"installation": receipt["status"], "timer": timer}))
            return 0
        if args.action == "install":
            with locked(root):
                result = install(root, args.python, directory, Path(__file__).parent, args.confirm)
        else:
            if args.confirm != UNIT:
                raise WatchError("exact_unit_confirmation_required")
            result = stop_or_rollback(root, directory, args.action == "rollback")
        print(json.dumps(result))
        return 0
    except (WatchError, OSError, ValueError, TypeError, subprocess.SubprocessError):
        print(json.dumps({"status": "blocked", "reason": "verify_target_plan_receipt_and_user_service"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Exact system-manager units running as the existing non-root credential owner.

Use when the user manager silently ignores filesystem sandboxing. This never
changes kernel/AppArmor policy, linger, accounts, existing apps or credentials.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

from service import UNIT, PROGRAMS, units

DIRECTORY = Path("/etc/systemd/system")
RECEIPT = UNIT + ".receipt.json"
PROVENANCE = "credential-provenance.json"
MAX_METADATA = 262144


def digest(data):
    return hashlib.sha256(data).hexdigest()


def render(root, user):
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user):
        raise ValueError("invalid_user")
    if root.as_posix() != "/home/" + user + "/" + UNIT:
        raise ValueError("exact_owner_root_required")
    result = units(root.as_posix(), "/usr/bin/python3")
    name = UNIT + ".service"
    result[name] = result[name].replace(b"Type=oneshot\n", f"Type=oneshot\nUser={user}\nGroup={user}\n".encode())
    return result


def plan(root, user, directory=DIRECTORY):
    content = render(root, user)
    snapshot = {"scope": "system", "unit": UNIT, "root": str(root), "user": user,
                "units": {name: digest(data) for name, data in content.items()},
                "programs": {name: digest((root / "program" / name).read_bytes()) for name in PROGRAMS},
                "preexisting": {name: (directory / name).exists() or (directory / name).is_symlink()
                                for name in [*content, RECEIPT]}}
    snapshot["confirmation"] = digest(json.dumps(snapshot, sort_keys=True).encode())
    return snapshot, content


def secure(path, uid, directory=False):
    info = path.lstat()
    good = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not good or info.st_uid != uid or info.st_mode & 0o077 or path.is_symlink():
        raise ValueError("unsafe_owner_storage")
    if not directory and info.st_nlink != 1:
        raise ValueError("hardlink_refused")


def auth_provenance_ready(state, provenance):
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("accounts"), dict):
        return False
    aliases = state["accounts"]
    if not 1 <= len(aliases) <= 16:
        return False
    if not isinstance(provenance, dict) or set(provenance) != {"version", "accounts"}:
        return False
    if provenance.get("version") != 1 or not isinstance(provenance.get("accounts"), dict):
        return False
    if set(provenance["accounts"]) != set(aliases):
        return False
    for alias, state_row in aliases.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", alias) or not isinstance(state_row, dict):
            return False
        identity = state_row.get("identity")
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
            return False
        row = provenance["accounts"].get(alias)
        if not isinstance(row, dict) or set(row) != {"method", "identity", "verifiedAt"}:
            return False
        verified = row.get("verifiedAt")
        if (row.get("method") != "server_device_auth" or row.get("identity") != identity
                or not isinstance(verified, (int, float)) or isinstance(verified, bool) or verified <= 0):
            return False
    return True


def read_owner_json(path, uid):
    secure(path, uid)
    raw = path.read_bytes()
    if len(raw) > MAX_METADATA:
        raise ValueError("metadata_too_large")
    return json.loads(raw)


def resume_auth_ready(root, uid):
    provenance = root / PROVENANCE
    if not (provenance.exists() or provenance.is_symlink()):
        return False
    return auth_provenance_ready(
        read_owner_json(root / "state.json", uid),
        read_owner_json(provenance, uid),
    )


def save(path, data, fresh=False):
    raw = json.dumps(data, sort_keys=True).encode()
    if fresh:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        sync_directory(path.parent)
        return
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
                os.unlink(temporary)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def control(*args):
    result = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError("systemd_operation_failed")
    return result.stdout.strip()


def verify_receipt(value, root, user, directory=DIRECTORY):
    expected = render(root, user)
    if value.get("root") != str(root) or value.get("user") != user or value.get("scope") != "system" or value.get("unit") != UNIT:
        raise ValueError("wrong_receipt")
    if value.get("units") != {name: digest(data) for name, data in expected.items()}:
        raise ValueError("unit_contract_changed")
    for name, checksum in value["units"].items():
        path = directory / name
        if path.exists() or path.is_symlink():
            secure(path, 0)
            if digest(path.read_bytes()) != checksum:
                raise ValueError("unit_drift")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "install", "status", "resume", "stop", "rollback"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--user", required=True)
    parser.add_argument("--unit", required=True, choices=[UNIT])
    parser.add_argument("--confirm")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    render(args.root, args.user)
    if args.action == "plan" or args.dry_run:
        snapshot, _ = plan(args.root, args.user)
        print(json.dumps(dict(snapshot, action=args.action, mutation=False)))
        return
    import pwd
    if os.getuid() != 0:
        raise ValueError("system_unit_install_requires_sudo")
    owner = pwd.getpwnam(args.user)
    if owner.pw_uid == 0 or args.root.parent != Path(owner.pw_dir):
        raise ValueError("existing_nonroot_owner_required")
    for path in [args.root, *args.root.parents, DIRECTORY]:
        if path.is_symlink():
            raise ValueError("symlink_refused")
    secure(args.root, owner.pw_uid, True)
    secure(args.root / "program", owner.pw_uid, True)
    for name in PROGRAMS:
        secure(args.root / "program" / name, owner.pw_uid)
    receipt_path = DIRECTORY / RECEIPT
    if args.action == "install":
        snapshot, content = plan(args.root, args.user)
        if args.confirm != snapshot["confirmation"] or any(snapshot["preexisting"].values()):
            raise ValueError("fresh_plan_required")
        # Only structural/non-secret provenance validation; root never reads OAuth secrets.
        secure(args.root / "credentials.json", owner.pw_uid)
        if not resume_auth_ready(args.root, owner.pw_uid):
            raise ValueError("independent_server_auth_required")
        receipt = dict(snapshot, status="prepared")
        save(receipt_path, receipt, fresh=True)
        for name, data in content.items():
            fd = os.open(DIRECTORY / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
        control("daemon-reload")
        control("enable", "--now", UNIT + ".timer")
        control("is-active", UNIT + ".timer")
        receipt["status"] = "installed"
    else:
        secure(receipt_path, 0)
        receipt = json.loads(receipt_path.read_text())
        verify_receipt(receipt, args.root, args.user)
        if args.action == "status":
            try:
                auth_ready = resume_auth_ready(args.root, owner.pw_uid)
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                auth_ready = False
            print(json.dumps({"installation": receipt["status"],
                              "timer": control("show", UNIT + ".timer", "-p", "ActiveState", "--value"),
                              "resumeReady": auth_ready}))
            return
        if args.confirm != UNIT:
            raise ValueError("exact_unit_confirmation_required")
        if args.action == "resume":
            if receipt["status"] != "stopped" or not all((DIRECTORY / name).exists() for name in receipt["units"]):
                raise ValueError("stopped_intact_install_required")
            snapshot, _ = plan(args.root, args.user)
            if snapshot["programs"] != receipt["programs"]:
                raise ValueError("program_drift")
            if not resume_auth_ready(args.root, owner.pw_uid):
                raise ValueError("independent_server_auth_required")
            control("enable", "--now", UNIT + ".timer")
            control("is-active", UNIT + ".timer")
            receipt["status"] = "installed"
            save(receipt_path, receipt)
            print(json.dumps({"status": "installed", "unit": UNIT, "runAs": args.user}))
            return
        for suffix in (".timer", ".service"):
            if (DIRECTORY / (UNIT + suffix)).exists():
                control("stop", UNIT + suffix)
        if (DIRECTORY / (UNIT + ".timer")).exists():
            control("disable", UNIT + ".timer")
        if args.action == "rollback":
            for name in receipt["units"]:
                path = DIRECTORY / name
                if path.exists():
                    path.unlink()
            control("daemon-reload")
        receipt["status"] = "rolled_back" if args.action == "rollback" else "stopped"
    save(receipt_path, receipt)
    print(json.dumps({"status": receipt["status"], "unit": UNIT, "runAs": args.user, "credentialsPreserved": True}))


if __name__ == "__main__":
    main()

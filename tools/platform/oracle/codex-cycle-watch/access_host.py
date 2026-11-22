#!/usr/bin/env python3
"""Add/revoke one owner-authorized SSH key without replacing existing keys."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

MARKER = "aicc-oracle-a1-permanent-v1"


def check(path, directory=False):
    info = path.lstat()
    valid = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid or path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("unsafe_ssh_storage")
    if not directory and info.st_nlink != 1:
        raise ValueError("hardlink_refused")


def key_line(raw):
    parts = raw.strip().split()
    if len(parts) not in (2, 3) or parts[0] != "ssh-rsa" or len(raw) > 4096:
        raise ValueError("rsa_public_key_required")
    blob = base64.b64decode(parts[1], validate=True)
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    return (f"ssh-rsa {parts[1]} {MARKER}\n").encode(), fingerprint


def enroll(ssh_dir, raw):
    check(ssh_dir, True)
    authorized = ssh_dir / "authorized_keys"
    check(authorized)
    line, fingerprint = key_line(raw)
    fd = os.open(authorized, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW)
    with os.fdopen(fd, "r+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        before = stream.read()
        if line.rstrip() in before.splitlines():
            return {"status": "already_enrolled", "fingerprint": fingerprint}
        if MARKER.encode() in before:
            raise ValueError("different_key_with_marker")
        backup = ssh_dir / (MARKER + ".before")
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as saved:
            saved.write(before)
            saved.flush()
            os.fsync(saved.fileno())
        added = (b"\n" if before and not before.endswith(b"\n") else b"") + line
        stream.write(added)
        stream.flush()
        os.fsync(stream.fileno())
        stream.seek(0)
        if stream.read() != before + added:
            raise ValueError("concurrent_key_change")
    return {"status": "enrolled", "fingerprint": fingerprint, "oldKeysPreserved": True}


def revoke(ssh_dir, raw):
    check(ssh_dir, True)
    authorized = ssh_dir / "authorized_keys"
    check(authorized)
    line, fingerprint = key_line(raw)
    with authorized.open("rb") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        before = stream.read()
        rows = before.splitlines(keepends=True)
        matches = [i for i, row in enumerate(rows) if row.rstrip(b"\r\n") == line.rstrip(b"\n")]
        if len(matches) != 1:
            raise ValueError("exact_enrolled_line_required")
        after = b"".join(row for i, row in enumerate(rows) if i != matches[0])
        fd, temporary = tempfile.mkstemp(dir=ssh_dir)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(after)
                out.flush()
                os.fsync(out.fileno())
            if authorized.read_bytes() != before:
                raise ValueError("concurrent_key_change")
            os.replace(temporary, authorized)
            directory_fd = os.open(ssh_dir, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {"status": "revoked", "fingerprint": fingerprint, "otherKeysPreserved": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "enroll", "revoke"))
    parser.add_argument("--home", required=True)
    args = parser.parse_args()
    home = Path(args.home)
    if not home.is_absolute() or home != Path.home() or any(p.is_symlink() for p in [home, *home.parents]):
        raise ValueError("exact_current_home_required")
    ssh_dir = home / ".ssh"
    check(ssh_dir, True)
    check(ssh_dir / "authorized_keys")
    if args.action == "status":
        lines = (ssh_dir / "authorized_keys").read_bytes().splitlines()
        print(json.dumps({"status": "ready", "keyLines": len(lines),
                          "enrolled": any(line.endswith(b" " + MARKER.encode()) for line in lines)}))
    else:
        operation = enroll if args.action == "enroll" else revoke
        print(json.dumps(operation(ssh_dir, sys.stdin.read(4097))))


if __name__ == "__main__":
    main()

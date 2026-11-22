#!/usr/bin/env python3
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

DEFAULT_ROOT = Path("/demo/owner/.local/share/ocx-hub/node_modules/@bitkyc08/opencodex")
OLD = '''  if (!isApiAuthRequired(config)) {
    if (!isLoopbackHostname(host.hostname) || !isAllowedManagementOrigin(req, config)) return null;
    const origin = managementRequestOrigin(req, config);
    return origin ? mintSession(origin, origin, "loopback", state, now) : null;
  }
'''
NEW = '''  if (!isApiAuthRequired(config)) {
    if (!isLoopbackHostname(host.hostname) || !isAllowedManagementOrigin(req, config)) return null;
    const serverOrigin = managementRequestOrigin(req, config);
    if (!serverOrigin) return null;
    // A loopback-only Hub may be reached through an authenticated SSH-forwarded
    // client management origin. Preserve that browser Origin in the GUI session
    // while keeping the server authority bound to the Hub management listener.
    const browserOrigin = canonicalGuiBrowserOrigin(req.headers.get("Origin") ?? serverOrigin);
    if (!browserOrigin) return null;
    return mintSession(serverOrigin, browserOrigin, "loopback", state, now);
  }
'''
def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def upstream_supports_split_origin(text: str) -> bool:
    start = text.find("  if (!isApiAuthRequired(config)) {")
    if start < 0:
        return False
    end = text.find("\n\n  if (", start + 1)
    block = text[start:end if end >= 0 else len(text)]
    return (
        'canonicalGuiBrowserOrigin(req.headers.get("Origin") ?? serverOrigin)' in block
        and 'mintSession(serverOrigin, browserOrigin' in block
    )

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.environ.get("OCX_HUB_PACKAGE_ROOT", str(DEFAULT_ROOT)))
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    root = Path(args.root)
    target = root / "src/server/gui-session.ts"
    package = root / "package.json"
    state = Path.home() / ".local/state/aicc-ocx-patches"
    state.mkdir(parents=True, exist_ok=True)
    lock_path = state / "gui-autoauth.lock"

    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"ok": True, "changed": False, "status": "busy"}))
            return 0

        if not target.is_file():
            print(json.dumps({"ok": False, "changed": False, "status": "missing-target"}))
            return 2 if args.strict else 0

        raw = target.read_bytes()
        text = raw.decode("utf-8")
        before = sha256(raw)
        version = "unknown"
        try:
            version = json.loads(package.read_text(encoding="utf-8")).get("version", "unknown")
        except Exception:
            pass
        if upstream_supports_split_origin(text):
            status = "supported"
            changed = False
        elif OLD in text:
            backup_dir = state / "backups" / str(version)
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup = backup_dir / f"gui-session.{before}.ts"
            if not backup.exists():
                shutil.copy2(target, backup)
            patched = text.replace(OLD, NEW, 1)
            fd, tmp_name = tempfile.mkstemp(prefix=".gui-session.", suffix=".tmp", dir=str(target.parent))
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(patched)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.chmod(tmp_name, 0o644)
                os.replace(tmp_name, target)
            finally:
                if os.path.exists(tmp_name):
                    os.unlink(tmp_name)
            status = "patched"
            changed = True
        else:
            status = "unsupported-layout"
            changed = False

        after = sha256(target.read_bytes())
        result = {
            "ok": status != "unsupported-layout",
            "changed": changed,
            "status": status,
            "version": version,
            "beforeSha256": before,
            "afterSha256": after,
        }
        print(json.dumps(result, sort_keys=True))
        if status == "unsupported-layout" and args.strict:
            return 2
        return 0

if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Emit a secret-free local readiness report for the AICC auth portal."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import stat
import subprocess
import urllib.error
import urllib.request
from pathlib import Path


REQUIRED_SOURCE = (
    "components/account-manager/ops/auth-portal/broker.py",
    "components/account-manager/ops/auth-portal/mac_sync.py",
    "components/account-manager/ops/auth-portal/deploy/deploy.sh",
    "components/account-manager/ops/auth-portal/deploy/rollback.sh",
    "components/account-manager/docs/auth-portal-ocx-sync.md",
)


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def mode(path: Path) -> str | None:
    if not path.exists():
        return None
    return oct(stat.S_IMODE(path.stat().st_mode))


def command_ok(command: list[str]) -> bool:
    try:
        return subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=8,
            check=False,
        ).returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def health_status(url: str) -> int | None:
    if not url.startswith("https://"):
        return None
    try:
        request = urllib.request.Request(url.rstrip("/") + "/health", method="GET")
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, TimeoutError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--aicc-root", required=True, type=Path)
    parser.add_argument("--state-root", type=Path)
    args = parser.parse_args()

    aicc_root = args.aicc_root.expanduser().resolve()
    state_root = (args.state_root or Path(
        os.environ.get("AICC_STATE_ROOT", "~/.ai-control-center")
    )).expanduser().resolve()
    account_state = Path(os.environ.get(
        "AICC_ACCOUNT_MANAGER_STATE_ROOT", str(state_root / "account-manager")
    )).expanduser()
    config_path = Path(os.environ.get(
        "CM_AUTH_LOCAL_CONFIG", str(account_state / "auth-portal.env")
    )).expanduser()
    values = parse_env(config_path)

    keychain_service = values.get("CM_AUTH_KEYCHAIN_SERVICE", "")
    portal_url = values.get("CM_AUTH_PORTAL_URL", "")
    launch_dir = Path.home() / "Library" / "LaunchAgents"
    plist_candidates = (
        launch_dir / "com.codex-account-manager.auth-sync.plist",
        launch_dir / "com.agenthub.cm-auth-sync.plist",
    )
    installed_plists = [path for path in plist_candidates if path.is_file()]
    labels: list[str] = []
    for plist_path in installed_plists:
        try:
            with plist_path.open("rb") as handle:
                label = plistlib.load(handle).get("Label")
            if isinstance(label, str) and label:
                labels.append(label)
        except (OSError, plistlib.InvalidFileException):
            pass

    uid = str(os.getuid())
    loaded_labels = [
        label for label in labels
        if command_ok(["launchctl", "print", f"gui/{uid}/{label}"])
    ]
    report = {
        "source": {
            "root_exists": aicc_root.is_dir(),
            "required_files_present": all((aicc_root / item).is_file() for item in REQUIRED_SOURCE),
            "missing_count": sum(not (aicc_root / item).is_file() for item in REQUIRED_SOURCE),
        },
        "local_config": {
            "present": config_path.is_file(),
            "mode": mode(config_path),
            "mode_0600": mode(config_path) == "0o600",
            "required_routing_fields": all(values.get(key) for key in (
                "CM_AUTH_TARGET_ACCOUNT",
                "CM_AUTH_OCX_TARGET_ACCOUNT",
                "CM_AUTH_PORTAL_URL",
                "CM_AUTH_KEYCHAIN_SERVICE",
            )),
        },
        "keychain": {
            "service_configured": bool(keychain_service),
            "entry_present": bool(keychain_service) and command_ok([
                "security", "find-generic-password", "-s", keychain_service,
            ]),
        },
        "launch_agent": {
            "installed_count": len(installed_plists),
            "loaded_count": len(loaded_labels),
            "loaded": bool(loaded_labels),
        },
        "portal": {
            "https_url_configured": portal_url.startswith("https://"),
            "health_status": health_status(portal_url) if portal_url else None,
        },
    }
    report["ready"] = bool(
        report["source"]["required_files_present"]
        and report["local_config"]["mode_0600"]
        and report["local_config"]["required_routing_fields"]
        and report["keychain"]["entry_present"]
        and report["launch_agent"]["loaded"]
        and report["portal"]["health_status"] == 200
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

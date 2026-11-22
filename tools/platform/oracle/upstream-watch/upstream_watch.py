#!/usr/bin/env python3
"""Low-memory GitHub and npm update observer.

This program never clones, pulls, installs or updates a component. It performs
bounded metadata reads, writes an atomic current-state file and appends one
compact event only when a source's state materially changes.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


USER_AGENT = "open-aicc-upstream-watch/1"
KEY_ROOT = Path("/etc/open-aicc/upstream-watch-keys")
KNOWN_HOSTS = Path("/etc/open-aicc/github_known_hosts")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fetch_json(url: str, token: str | None = None) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def git_remote_status(source: dict, key: Path | None = None) -> dict:
    repository = source["repository"]
    tracked = source.get("trackedRef") or "HEAD"
    remote_ref = "HEAD" if tracked == "HEAD" else f"refs/heads/{tracked}"
    url = f"git@github.com:{repository}.git" if key else f"https://github.com/{repository}.git"
    env = os.environ.copy()
    if key:
        env["GIT_SSH_COMMAND"] = (
            f"ssh -i {key} -o IdentitiesOnly=yes -o BatchMode=yes "
            f"-o StrictHostKeyChecking=yes -o UserKnownHostsFile={KNOWN_HOSTS}"
        )
    try:
        result = subprocess.run(
            ["git", "ls-remote", "--exit-code", url, remote_ref],
            check=False,
            capture_output=True,
            text=True,
            timeout=25,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"status": "unknown", "reason": type(error).__name__}
    if result.returncode != 0:
        return {"status": "unknown", "reason": f"git_ls_remote_exit_{result.returncode}"}
    current = result.stdout.split(maxsplit=1)[0] if result.stdout.strip() else ""
    if len(current) != 40:
        return {"status": "unknown", "reason": "missing_commit_sha"}
    baseline = source.get("baselineRevision")
    if source.get("observationMode") == "reference":
        return {"status": "reference", "baselineRevision": None, "currentRevision": current}
    if not isinstance(baseline, str) or not re.fullmatch(r"[0-9a-f]{40}", baseline):
        return {"status": "unknown", "reason": "baseline_revision_unknown", "baselineRevision": baseline, "currentRevision": current}
    return {
        "status": "current" if current == baseline else "update_available",
        "baselineRevision": baseline,
        "currentRevision": current,
    }


def github_status(source: dict, token: str | None, credential_mode: str = "remote-bounded") -> dict:
    if credential_mode == "local-git":
        return git_remote_status(source)
    if source.get("visibility") != "private":
        return git_remote_status(source)
    credential_id = source.get("credentialId")
    key = KEY_ROOT / str(credential_id) if credential_id else None
    if key and key.is_file():
        return git_remote_status(source, key)
    if not token:
        return {"status": "auth_required", "reason": "private_repository_requires_read_only_credential"}
    repository = source["repository"]
    ref = urllib.parse.quote(source.get("trackedRef") or "HEAD", safe="")
    try:
        payload = fetch_json(f"https://api.github.com/repos/{repository}/commits/{ref}", token)
    except urllib.error.HTTPError as error:
        return {"status": "unknown", "reason": f"github_http_{error.code}"}
    except (OSError, ValueError) as error:
        return {"status": "unknown", "reason": type(error).__name__}
    current = str(payload.get("sha", ""))
    if not current:
        return {"status": "unknown", "reason": "missing_commit_sha"}
    baseline = source.get("baselineRevision")
    if source.get("observationMode") == "reference":
        return {"status": "reference", "baselineRevision": None, "currentRevision": current}
    if not isinstance(baseline, str) or not re.fullmatch(r"[0-9a-f]{40}", baseline):
        return {"status": "unknown", "reason": "baseline_revision_unknown", "baselineRevision": baseline, "currentRevision": current}
    return {
        "status": "current" if current == baseline else "update_available",
        "baselineRevision": baseline,
        "currentRevision": current,
    }


def npm_status(source: dict) -> dict:
    encoded = urllib.parse.quote(source["package"], safe="")
    try:
        payload = fetch_json(f"https://registry.npmjs.org/{encoded}")
    except urllib.error.HTTPError as error:
        return {"status": "unknown", "reason": f"npm_http_{error.code}"}
    except (OSError, ValueError) as error:
        return {"status": "unknown", "reason": type(error).__name__}
    channel = source.get("channel", "latest")
    current = str(payload.get("dist-tags", {}).get(channel, ""))
    if not current:
        return {"status": "unknown", "reason": "missing_dist_tag"}
    baseline = source.get("baselineVersion")
    if source.get("observationMode") == "reference":
        return {
            "status": "reference",
            "baselineVersion": None,
            "currentVersion": current,
            "channel": channel,
        }
    if not baseline:
        return {"status": "unknown", "reason": "baseline_version_unknown", "currentVersion": current, "channel": channel}
    return {
        "status": "current" if current == baseline else "update_available",
        "baselineVersion": baseline,
        "currentVersion": current,
        "channel": channel,
    }


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def load_previous(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {row["id"]: row["status"] for row in data.get("sources", [])}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def run(manifest_path: Path, state_path: Path, events_path: Path, credential_mode: str = "remote-bounded") -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    previous = load_previous(state_path)
    token = os.environ.get("UPSTREAM_WATCH_GITHUB_TOKEN")
    def observe(source: dict) -> dict:
        observed = github_status(source, token, credential_mode) if source["type"] == "github" else npm_status(source)
        metadata = {key: source[key] for key in (
            "label", "repository", "package", "sourceUrl", "observationMode", "installed",
            "applyPolicy", "applyAction", "applyReason"
        ) if key in source}
        return {"id": source["id"], "type": source["type"], **metadata, **observed}

    sources = manifest["sources"]
    worker_count = min(8, max(1, len(sources)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="aicc-upstream") as executor:
        rows = list(executor.map(observe, sources))
    counts = {status: sum(row["status"] == status for row in rows) for status in ("current", "update_available", "reference", "auth_required", "unknown")}
    report = {
        "schemaVersion": 1,
        "checkedAt": now(),
        "automaticApply": False,
        "counts": counts,
        "sources": rows,
    }
    changed = [row for row in rows if previous.get(row["id"]) != row["status"]]
    atomic_json(state_path, report)
    if changed:
        events_path.parent.mkdir(parents=True, exist_ok=True)
        with events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"observedAt": report["checkedAt"], "changes": changed}, ensure_ascii=False) + "\n")
        os.chmod(events_path, 0o600)
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--credential-mode", choices=("remote-bounded", "local-git"), default="remote-bounded")
    args = parser.parse_args()
    report = run(args.manifest, args.state, args.events, args.credential_mode)
    print(json.dumps({"ok": report["counts"]["unknown"] == 0, "counts": report["counts"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

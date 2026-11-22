#!/usr/bin/env python3
"""Build a secret-free observer manifest from owner-local source registries."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tomllib
from datetime import datetime, timezone
from pathlib import Path


GITHUB_REPOSITORY = re.compile(r"^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$")


def git(path: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def git_optional(path: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(path), *args], check=False, capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def tracked_remote_baseline(project_path: Path, remote: str) -> tuple[str, str]:
    configured = git_optional(project_path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    prefix = f"{remote}/"
    if configured.startswith(prefix):
        revision = git_optional(project_path, "rev-parse", configured)
        if re.fullmatch(r"[0-9a-f]{40}", revision):
            return configured[len(prefix):], revision
    remote_head = git_optional(project_path, "symbolic-ref", f"refs/remotes/{remote}/HEAD")
    head_prefix = f"refs/remotes/{remote}/"
    if remote_head.startswith(head_prefix):
        revision = git_optional(project_path, "rev-parse", remote_head)
        if re.fullmatch(r"[0-9a-f]{40}", revision):
            return remote_head[len(head_prefix):], revision
    return git(project_path, "branch", "--show-current") or "HEAD", git(project_path, "rev-parse", "HEAD")


def ledger_sources(ledger: Path | None, seen: set[str]) -> list[dict]:
    if ledger is None:
        return []
    data = json.loads(ledger.read_text(encoding="utf-8"))
    grouped: dict[str, dict] = {}
    for source in data.get("sources", []):
        if source.get("status") in {"rejected", "duplicate", "superseded"}:
            continue
        monitor = source.get("upstream_monitor", {})
        if monitor.get("mode") != "git-ls-remote":
            continue
        match = GITHUB_REPOSITORY.match(str(source.get("canonical_url", "")))
        revision = str(monitor.get("latest_seen_ref", ""))
        if not match or not re.fullmatch(r"[0-9a-f]{40}", revision):
            continue
        repository = f"{match.group(1)}/{match.group(2)}"
        if repository in seen:
            continue
        row = grouped.setdefault(repository, {
            "id": f"external-{match.group(1)}-{match.group(2)}".lower(),
            "type": "github",
            "repository": repository,
            "visibility": "public",
            "trackedRef": "HEAD",
            "baselineRevision": revision,
            "sourceIds": [],
        })
        row["sourceIds"].append(str(source["id"]))
    seen.update(grouped)
    return list(grouped.values())


def build(portfolio: Path, ocx_version: str, source_ledger: Path | None = None) -> dict:
    data = tomllib.loads(portfolio.read_text(encoding="utf-8"))
    sources: list[dict] = []
    seen: set[str] = set()
    for project in data.get("projects", []):
        repository = str(project.get("canonical_repo", "")).strip()
        state = str(project.get("canonical_state", "ready"))
        if not repository or state != "ready" or repository in seen:
            continue
        project_path = Path(str(project["path"])).expanduser()
        if not (project_path / ".git").exists():
            continue
        seen.add(repository)
        visibility = str(project.get("canonical_visibility", "private"))
        tracked_ref, baseline_revision = tracked_remote_baseline(project_path, str(project.get("canonical_remote", "origin")))
        sources.append({
            "id": str(project["id"]),
            "type": "github",
            "repository": repository,
            "visibility": visibility,
            "trackedRef": tracked_ref,
            "baselineRevision": baseline_revision,
            **({"credentialId": hashlib.sha256(repository.encode("utf-8")).hexdigest()[:20]} if visibility == "private" else {}),
        })
    sources.extend(ledger_sources(source_ledger, seen))
    sources.append({
        "id": "ocx-upstream-npm",
        "type": "npm",
        "package": "@bitkyc08/opencodex",
        "baselineVersion": ocx_version,
        "channel": "latest",
    })
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "policy": {"automaticApply": False, "privateWithoutCredential": "auth_required", "networkFailure": "unknown"},
        "sources": sorted(sources, key=lambda source: source["id"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--portfolio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ocx-version", required=True)
    parser.add_argument("--source-ledger", type=Path)
    args = parser.parse_args()
    manifest = build(args.portfolio.expanduser(), args.ocx_version, args.source_ledger.expanduser() if args.source_ledger else None)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.output.chmod(0o600)
    print(json.dumps({"ok": True, "sourceCount": len(manifest["sources"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

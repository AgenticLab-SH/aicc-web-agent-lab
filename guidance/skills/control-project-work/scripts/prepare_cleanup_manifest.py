#!/usr/bin/env python3
"""Print a conservative, read-only cleanup manifest for explicit local targets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


TEXT_EXTENSIONS = {
    ".bat", ".cmd", ".conf", ".css", ".csv", ".html", ".ini", ".js",
    ".json", ".jsx", ".md", ".ps1", ".py", ".sh", ".toml", ".ts",
    ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
EXCLUDED_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv"}


def run_git(root: Path, *args: str) -> tuple[int, str]:
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=False,
    )
    return result.returncode, result.stdout.strip()


def git_root_for(path: Path) -> Path | None:
    base = path if path.is_dir() else path.parent
    code, output = run_git(base, "rev-parse", "--show-toplevel")
    return Path(output).resolve() if code == 0 and output else None


def git_state(path: Path, root: Path | None) -> tuple[str, str | None]:
    if root is None:
        return "untracked", None
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError:
        return "untracked", None
    code, _ = run_git(root, "ls-files", "--error-unmatch", "--", relative)
    if code != 0:
        return "untracked", None
    _, status = run_git(root, "status", "--porcelain", "--", relative)
    _, revision = run_git(root, "rev-parse", "HEAD")
    return ("tracked-modified" if status else "tracked-clean"), (revision or None)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def iter_files(target: Path):
    if target.is_file():
        yield target
        return
    for current, dirs, files in os.walk(target):
        dirs[:] = [name for name in dirs if name not in EXCLUDED_DIRS]
        for name in files:
            yield Path(current, name)


def text_files(root: Path, limit: int, max_bytes: int):
    count = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in EXCLUDED_DIRS]
        for name in files:
            path = Path(current, name)
            if path.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            try:
                if path.stat().st_size > max_bytes:
                    continue
            except OSError:
                continue
            if count >= limit:
                return count, True
            count += 1
            yield path
    return count, False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inventory exact cleanup targets and print JSON; never modifies or deletes files."
    )
    parser.add_argument("--root", required=True, help="Absolute scope root containing every target.")
    parser.add_argument("--target", action="append", required=True, help="Exact target path; repeat as needed.")
    parser.add_argument("--scan-root", action="append", default=[], help="Root for text-reference scan; defaults to --root.")
    parser.add_argument("--reason", default="superseded candidate; manual confirmation required")
    parser.add_argument("--max-scan-files", type=int, default=25000)
    parser.add_argument("--max-text-bytes", type=int, default=2_000_000)
    args = parser.parse_args()

    scope = Path(args.root).expanduser().resolve()
    if not scope.is_dir():
        parser.error("--root must be an existing directory")

    targets: list[Path] = []
    for raw in args.target:
        target = Path(raw).expanduser().resolve()
        if not target.exists():
            parser.error(f"target does not exist: {target}")
        try:
            target.relative_to(scope)
        except ValueError:
            parser.error(f"target escapes --root: {target}")
        if target == scope:
            parser.error("refusing to inventory the scope root itself")
        targets.append(target)

    scan_roots = [Path(value).expanduser().resolve() for value in args.scan_root] or [scope]
    for scan_root in scan_roots:
        if not scan_root.is_dir():
            parser.error(f"scan root is not an existing directory: {scan_root}")

    target_files = {file.resolve() for target in targets for file in iter_files(target)}
    needles: dict[Path, set[str]] = {}
    for target in targets:
        relative = target.relative_to(scope)
        needles[target] = {
            target.name, str(relative), relative.as_posix(), str(target), target.as_posix()
        }

    callers: dict[Path, list[str]] = {target: [] for target in targets}
    scanned = 0
    scan_truncated = False
    for scan_root in scan_roots:
        generator = text_files(
            scan_root, max(0, args.max_scan_files - scanned), args.max_text_bytes
        )
        while True:
            try:
                path = next(generator)
            except StopIteration as stop:
                count, truncated = stop.value
                scanned += count
                scan_truncated = scan_truncated or truncated
                break
            if path.resolve() in target_files:
                continue
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line_number, line in enumerate(lines, 1):
                for target, values in needles.items():
                    if any(value and value in line for value in values):
                        callers[target].append(f"{path.resolve()}:{line_number}")

    entries = []
    unresolved = []
    for target in targets:
        files = list(iter_files(target))
        file_entries = []
        total_size = 0
        states = set()
        revisions = set()
        for file in files:
            size = file.stat().st_size
            total_size += size
            root = git_root_for(file)
            state, revision = git_state(file, root)
            states.add(state)
            if revision:
                revisions.add(revision)
            file_entries.append({
                "path": str(file.resolve()), "size": size, "sha256": sha256(file),
                "git_root": str(root) if root else None, "git_revision": revision,
                "git_state": state,
            })
        if not files:
            states.add("untracked")
        recoverable = bool(files) and states == {"tracked-clean"} and len(revisions) == 1
        recovery_source = f"git:{next(iter(revisions))}" if recoverable else None
        git_roots = sorted({entry["git_root"] for entry in file_entries if entry["git_root"]})
        aggregate_state = next(iter(states)) if len(states) == 1 else "mixed"
        aggregate_revision = next(iter(revisions)) if len(revisions) == 1 else None
        if not recovery_source:
            unresolved.append(f"Create a byte-preserving backup outside the target set: {target}")
        if callers[target]:
            unresolved.append(f"Review and update callers before removal: {target}")
        entries.append({
            "path": str(target), "type": "directory" if target.is_dir() else "file",
            "size": total_size, "sha256": sha256(target) if target.is_file() else None,
            "git_root": git_roots[0] if len(git_roots) == 1 else None,
            "git_revision": aggregate_revision, "git_state": aggregate_state,
            "files": file_entries if target.is_dir() else None,
            "callers": sorted(set(callers[target])), "recovery_source": recovery_source,
        })

    output = {
        "created_at": datetime.now(timezone.utc).isoformat(), "read_only": True,
        "scope_root": str(scope), "reason": args.reason, "targets": entries,
        "reference_scan": {
            "roots": [str(root) for root in scan_roots], "files_scanned": scanned,
            "truncated": scan_truncated,
            "note": "Conservative text match; inspect false positives and non-text callers manually.",
        },
        "unresolved_requirements": sorted(set(unresolved)),
        "verification": [
            "manual caller and automation check", "surviving workflow check before removal",
            "recovery source exists outside removal set",
        ],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

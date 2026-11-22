#!/usr/bin/env python3
"""Read-only inventory of registered project upstreams and crawling sources.

Sources remain canonical in the existing AICC registries. Optional --write creates
only a derived, owner-local snapshot. No package-manager install or network crawl.
"""
from __future__ import annotations

import argparse
import ipaddress
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import urlsplit, urlunsplit
from urllib.request import build_opener, ProxyHandler

DEFAULT_REPO = Path(__file__).resolve().parents[4]
DEFAULT_STATE = Path.home() / ".ai-control-center"
DEPENDENCY_NAME = re.compile(r"^[A-Za-z0-9@/_\-.+]+$")
DIRECTORY_KINDS = ("apps", "packages", "services", "components")
MANIFESTS = ("package.json", "pyproject.toml", "requirements.txt")
MAX_PROJECTS = 150
MAX_MANIFESTS_PER_PROJECT = 80
MAX_DEPENDENCIES = 5000


def load_json(path: Path, fallback: dict | None = None) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else fallback or {}
    except (OSError, ValueError):
        return fallback or {}


def public_url(raw: str) -> str | None:
    """Strip URL credentials, query, fragment and reject local/non-HTTP sources."""
    try:
        p = urlsplit(str(raw))
        if p.scheme != "https" or not p.hostname or p.port not in (None, 443):
            return None
        host = p.hostname.lower()
        if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        return urlunsplit(("https", host, p.path or "/", "", ""))
    except ValueError:
        return None


def portfolio(state: Path) -> tuple[list[dict], int, list[str]]:
    file = state / "cross-device" / "project-portfolio.toml"
    if not file.is_file():
        return [], 0, ["portfolio_not_available"]
    try:
        data = tomllib.loads(file.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return [], 0, ["portfolio_parse_failed"]
    entries = data.get("projects", [])
    if not isinstance(entries, list):
        return [], 0, ["portfolio_invalid"]
    dedup: set[str] = set()
    projects: list[dict] = []
    for item in entries[:MAX_PROJECTS]:
        if not isinstance(item, dict) or item.get("canonical_state", "ready") != "ready":
            continue
        if item.get("role") not in ("source", None):
            continue
        repo = str(item.get("canonical_repo", "")).strip()
        project_id = str(item.get("id", "")).strip()
        raw_path = str(item.get("path", "")).strip()
        if not repo or not project_id or not raw_path or repo in dedup:
            continue
        dedup.add(repo)
        project_path = Path(raw_path).expanduser()
        projects.append({
            "id": project_id,
            "repo": repo,
            "path": str(project_path),
            "present": project_path.is_dir(),
            "role": "source",
            "declaredState": "ready",
        })
    issues = ["project_list_truncated"] if len(entries) > MAX_PROJECTS else []
    return projects, len(entries), issues


def direct_manifests(project_root: Path) -> list[Path]:
    if not project_root.is_dir():
        return []
    paths = [project_root / name for name in MANIFESTS]
    for folder in DIRECTORY_KINDS:
        group = project_root / folder
        if not group.is_dir():
            continue
        try:
            children = sorted((p for p in group.iterdir() if p.is_dir()), key=lambda p: p.name)[:60]
        except OSError:
            continue
        for child in children:
            paths.extend(child / name for name in MANIFESTS)
    return [p for p in paths[:MAX_MANIFESTS_PER_PROJECT] if p.is_file()]


def append_dependency(out: list[dict], project: str, manifest: str, ecosystem: str, name: str, spec: object):
    if not isinstance(name, str) or not DEPENDENCY_NAME.fullmatch(name):
        return
    version = str(spec).strip() if isinstance(spec, (str, int, float)) else "UNKNOWN"
    # Prevent embedding git credentials, URLs or shell syntax from manifests.
    if (len(version) > 100 or "://" in version or
            re.search(r"[\r\n\t$;{}\x00-\x1f]", version)):
        version = "URL_OR_DYNAMIC_REDACTED"
    out.append({"projectId": project, "file": manifest,
                "ecosystem": ecosystem, "name": name, "declared": version})


def package_dependencies(project: dict, issues: list[str]) -> list[dict]:
    root = Path(project["path"])
    deps: list[dict] = []
    paths = direct_manifests(root)
    for file in paths:
        rel = file.relative_to(root).as_posix()
        if file.name == "package.json":
            data = load_json(file)
            for kind in ("dependencies", "devDependencies", "optionalDependencies"):
                for name, spec in (data.get(kind) or {}).items() if isinstance(data.get(kind), dict) else []:
                    append_dependency(deps, project["id"], rel, "npm:" + kind, name, spec)
        elif file.name == "pyproject.toml":
            try:
                data = tomllib.loads(file.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                issues.append("malformed_pyproject:" + project["id"] + ":" + rel)
                continue
            for dep in (data.get("project", {}).get("dependencies") or []):
                name = re.split(r"[<>=!~; \[]", dep, maxsplit=1)[0].strip()
                append_dependency(deps, project["id"], rel, "python", name, dep)
            poetry = data.get("tool", {}).get("poetry", {}).get("dependencies", {})
            if isinstance(poetry, dict):
                for name, spec in poetry.items():
                    if name != "python":
                        append_dependency(deps, project["id"], rel, "python:poetry", name, spec)
        else:
            try:
                text = file.read_text(encoding="utf-8-sig")
            except OSError:
                issues.append("unreadable_requirements:" + project["id"] + ":" + rel)
                continue
            for line in text.splitlines()[:300]:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith(("-", "git+", "http")):
                    continue
                name = re.split(r"[<>=!~; \[]", line, maxsplit=1)[0].strip()
                append_dependency(deps, project["id"], rel, "python:requirements", name, line)
        if len(deps) > MAX_DEPENDENCIES:
            issues.append("dependency_list_truncated:" + project["id"])
            return deps[:MAX_DEPENDENCIES]
    return deps


def provenance(repo: Path) -> tuple[list[dict], list[str]]:
    path = repo / "guidance/skills/aicc-guidance-review/references/absorption-ledger.json"
    content = load_json(path)
    sources = []
    for item in content.get("sources", []):
        if not isinstance(item, dict):
            continue
        url = public_url(item.get("canonical_url", ""))
        if not url:
            continue
        monitor = item.get("upstream_monitor")
        sources.append({
            "id": str(item.get("id", ""))[:120],
            "kind": str(item.get("kind", "unknown"))[:60],
            "url": url,
            "status": str(item.get("status", "unknown"))[:40],
            "monitorMode": (monitor or {}).get("mode", "none") if isinstance(monitor, dict) else "none",
            "lastChecked": (monitor or {}).get("last_checked") if isinstance(monitor, dict) else None,
        })
    return sources, [] if path.is_file() else ["provenance_ledger_missing"]


def official_crawlers(repo: Path) -> tuple[list[dict], list[str]]:
    path = repo / "src/knowledge-review/policy.mjs"
    if not path.is_file():
        return [], ["official_crawler_policy_missing"]
    code = path.read_text(encoding="utf-8")
    # Parse declarations only; NEVER evaluate/execute a crawler as part of inventory.
    expression = r"\bid:\s*'([a-z0-9-]+)'[\s\S]{0,450}?\bseedUrl:\s*'([^']+)'"
    entries = []
    for found in re.finditer(expression, code):
        url = public_url(found.group(2))
        if url:
            entries.append({"id": found.group(1), "url": url,
                            "policy": "manualOnly,automaticApply=false", "source": "OFFICIAL_SOURCE_REGISTRY"})
    ids = {x["id"] for x in entries}
    issues = [] if len(ids) == len(entries) and entries else ["crawler_policy_not_fully_parsed"]
    return entries, issues


def runtime_status(live: bool) -> tuple[dict, list[str]]:
    result: dict = {"readOnly": True, "observed": live,
                    "localOcxVersion": "UNKNOWN", "webGptVersion": "UNKNOWN",
                    "hubRole": "UNKNOWN", "cliVersion": "UNKNOWN"}
    issues = []
    if not live:
        return result, ["runtime_not_probed"]
    opener = build_opener(ProxyHandler({}))
    for label, url in [
        ("localOcxVersion", "http://192.0.2.1:10100/readyz"),
        ("webGptVersion", "http://192.0.2.1:17841/healthz")
    ]:
        try:
            with opener.open(url, timeout=2) as response:
                result[label] = str(json.loads(response.read(16_384)).get("version") or "UNKNOWN")
        except Exception:
            issues.append(label + "_unavailable")
    try:
        with opener.open("http://192.0.2.1:10102/", timeout=2) as response:
            text = response.read(5_000).decode("utf-8", "replace")
            found = re.search(r'opencodex-runtime-role"\s+content="([^"]+)"', text)
            result["hubRole"] = found.group(1) if found else "UNKNOWN"
    except Exception:
        issues.append("a1_hub_unavailable")
    executable = shutil.which("ocx.cmd" if os.name == "nt" else "ocx")
    if executable:
        try:
            output = subprocess.run([executable, "--version"], capture_output=True,
                                    text=True, timeout=5, check=False)
            match = re.search(r"(?:opencodex\s+)?(\d+\.\d+\.\d+)", output.stdout)
            if output.returncode == 0 and match:
                result["cliVersion"] = match.group(1)
        except (OSError, subprocess.TimeoutExpired):
            issues.append("cli_version_probe_failed")
    else:
        issues.append("cli_not_on_path")
    result["cliMatchesRuntime"] = (
        result["cliVersion"] == result["localOcxVersion"]
        if "UNKNOWN" not in (result["cliVersion"], result["localOcxVersion"]) else None
    )
    return result, issues


def collect(repo: Path, state: Path, live: bool = False) -> dict:
    projects, registered, issues = portfolio(state)
    dependencies: list[dict] = []
    for project in projects:
        if project["present"]:
            dependencies.extend(package_dependencies(project, issues))
        else:
            issues.append("missing_project:" + project["id"])
    provenance_rows, more = provenance(repo)
    issues.extend(more)
    crawlers, more = official_crawlers(repo)
    issues.extend(more)
    live_rows, more = runtime_status(live)
    issues.extend(more)
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "owner-local-derived-observation",
        "automaticApply": False,
        "coverage": {
            "registeredProjectEntries": registered,
            "distinctReadySourceProjects": len(projects),
            "presentSourceProjects": sum(x["present"] for x in projects),
            "dependenciesDeclared": len(dependencies),
            "externalProvenanceRecords": len(provenance_rows),
            "officialCrawlerTargets": len(crawlers),
            "wholePcScanned": False,
            "unregisteredSourcesIncluded": False
        },
        "projects": projects,
        "directDependencies": dependencies,
        "externalSources": provenance_rows,
        "officialCrawlerTargets": crawlers,
        "runtime": live_rows,
        "unknown": sorted(set(issues)),
        "sourceAuthorities": {
            "projects": "cross-device/project-portfolio.toml",
            "provenance": "guidance/skills/aicc-guidance-review/references/absorption-ledger.json",
            "officialCrawlers": "src/knowledge-review/policy.mjs",
            "upstreamUpdates": "src/upstream-monitor.mjs"
        },
    }


def write_snapshot(path: Path, result: dict) -> None:
    if path.name != "upstream-assets.json" or path.parent.name != "inventory":
        raise ValueError("refusing to write outside the derived inventory location")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp: Path | None = None
    try:
        fd, name = tempfile.mkstemp(prefix=".upstream-assets-", suffix=".tmp", dir=path.parent)
        temp = Path(name)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(temp, path)
    finally:
        if temp is not None and temp.exists():
            temp.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_REPO)
    parser.add_argument("--state-root", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--live", action="store_true", help="Read local loopback health endpoints and CLI")
    parser.add_argument("--write", action="store_true", help="Write derived owner-local inventory only")
    parser.add_argument("--json", action="store_true", help="Print full derived JSON; may include private project names")
    args = parser.parse_args()
    result = collect(args.repo_root.resolve(), args.state_root.resolve(), args.live)
    if args.write:
        write_snapshot(args.state_root.resolve() / "inventory/upstream-assets.json", result)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"coverage": result["coverage"], "runtime": result["runtime"],
                          "unknown": result["unknown"], "written": bool(args.write)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

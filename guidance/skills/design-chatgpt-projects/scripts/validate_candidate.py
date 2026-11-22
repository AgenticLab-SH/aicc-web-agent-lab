#!/usr/bin/env python3
"""Read-only structural validator for a ChatGPT Project portfolio candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


REQUIRED_SELECTOR_METADATA = {"purpose", "provenance", "lifecycle", "freshness", "privacy", "rights"}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_roots(candidate: Path, plan: dict) -> dict[str, Path]:
    roots: dict[str, Path] = {}
    for root_id, raw in plan["roots"].items():
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = candidate / path
        path = path.resolve()
        if not path.is_dir():
            raise ValueError(f"missing root: {root_id}")
        roots[root_id] = path
    return roots


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    args = parser.parse_args()

    candidate = Path(args.candidate).expanduser().resolve()
    manifest = load_json(candidate / "portfolio-manifest.json")
    plan = load_json(candidate / "source-set-plan.json")
    projects = manifest["projects"]
    project_ids = {item["id"] for item in projects}
    if len(projects) != manifest["target"]["logicalProjects"]:
        raise ValueError("logical project count mismatch")
    if project_ids != set(plan["projects"]):
        raise ValueError("manifest and source plan project IDs differ")
    if any(re.fullmatch(r"(?:R|NEW|V)\d+", project_id, re.I) for project_id in project_ids):
        raise ValueError("migration marker used as durable logical ID")
    if manifest["approvalRequiredBeforeRemoteCreate"] is not True or plan["remoteUploadApproved"] is not False:
        raise ValueError("approval gate is not closed")

    target = manifest["target"]
    if target["uniqueRemoteProjects"] != target["logicalProjects"] * 2:
        raise ValueError("expected Business owner plus Personal replica topology")
    if target.get("customGpts") != 0 or target.get("extraAssets") != 0:
        raise ValueError("candidate must not add Custom GPTs or extra assets")
    if set(target.get("visibleProjects", {}).values()) != {target["logicalProjects"]}:
        raise ValueError("visible project counts must equal logical project count")
    expected_ids = sorted(project_ids)
    topology = manifest["physicalTopology"]
    if set(topology) != {"business_owner", "business_member", "personal_replica"}:
        raise ValueError("required physical bindings are missing")
    if topology["business_owner"].get("mode") != "create_owner":
        raise ValueError("Business owner binding must create the owner Project")
    if topology["business_member"].get("mode") != "share_existing":
        raise ValueError("Business member binding must share the owner Project")
    if topology["business_member"].get("sourceBinding") != "business_owner":
        raise ValueError("Business member source binding mismatch")
    if topology["personal_replica"].get("mode") != "create_replica":
        raise ValueError("Personal binding must create a replica")
    for binding in topology.values():
        if binding["logicalProjectIds"] != expected_ids:
            raise ValueError("physical topology logical IDs mismatch")

    roots = resolve_roots(candidate, plan)
    total_sources = 0
    for project in projects:
        instructions = candidate / project["localPath"] / "PROJECT_INSTRUCTIONS.md"
        if not instructions.is_file() or not 200 <= len(instructions.read_text(encoding="utf-8")) <= 8000:
            raise ValueError(f"invalid Instructions: {project['id']}")

        selected: list[Path] = []
        for selector in plan["projects"][project["id"]]["selectors"]:
            if REQUIRED_SELECTOR_METADATA - set(selector):
                raise ValueError(f"selector metadata missing: {project['id']}")
            root = roots[selector["root"]]
            candidates = [root / item for item in selector.get("paths", [])]
            for pattern in selector.get("globs", []):
                candidates.extend(sorted(root.glob(pattern)))
            excluded = set(selector.get("excludeBasenames", []))
            selected.extend(path.resolve() for path in candidates if path.name not in excluded)
        if any(not path.is_file() or path.is_symlink() for path in selected):
            raise ValueError(f"invalid source file: {project['id']}")
        basenames = [path.name for path in selected]
        if len(basenames) != len(set(basenames)):
            raise ValueError(f"duplicate source basename: {project['id']}")
        expected_count = plan["projects"][project["id"]]["expectedCount"]
        if len(selected) != expected_count:
            raise ValueError(f"source count mismatch: {project['id']}")
        records = sorted(f"{path.name}\0{hashlib.sha256(path.read_bytes()).hexdigest()}" for path in selected)
        digest = hashlib.sha256("\n".join(records).encode("utf-8")).hexdigest()
        if digest != plan["projects"][project["id"]]["sourceSetSha256"]:
            raise ValueError(f"source hash mismatch: {project['id']}")
        total_sources += len(selected)

    print("PASS ChatGPT Project candidate structure")
    print(f"logical projects: {len(projects)}")
    print(f"source candidates: {total_sources}")
    print("remote upload approved: false")


if __name__ == "__main__":
    main()

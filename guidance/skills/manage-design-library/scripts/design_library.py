#!/usr/bin/env python3
"""Safely collect and query a registered personal design-reference library."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any

CATEGORY_DIRS = {
    "web": "01_WEB_UI", "presentation": "02_PRESENTATION_PPT",
    "word": "03_DOCUMENT_WORD", "pdf": "04_PDF_LAYOUT", "report": "05_REPORT",
    "image": "06_IMAGE_GRAPHICS", "visualization": "07_VISUALIZATION",
    "cross-media": "08_CROSS_MEDIA_SYSTEM", "motion": "09_MOTION_VIDEO",
}
UNKNOWN = "UNKNOWN"
RESERVED_ITEM_FILENAMES = {"source.md", "metadata.json", "notes.md"}
SYSTEM_MANIFEST_ROLES = {"frame", "design", "adapters", "examples", "sources"}


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(code)


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def slugify(value: str) -> str:
    value = re.sub(r"[^0-9A-Za-z가-힣]+", "-", value.strip().lower()).strip("-")
    return value[:72] or "design-reference"


def config_path() -> Path:
    explicit = os.environ.get("AICC_DESIGN_LIBRARY_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    state_root = Path(os.environ.get("AICC_STATE_ROOT", Path.home() / ".ai-control-center"))
    return state_root / "config" / "design-library.json"


def load_library() -> Path:
    config_file = config_path()
    if not config_file.is_file():
        emit({"ok": False, "status": "hold", "reason": "design library registry missing", "config": str(config_file)}, 2)
    try:
        config = json.loads(config_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        emit({"ok": False, "status": "hold", "reason": f"invalid design library registry: {error}"}, 2)
    root_value = config.get("root")
    if not isinstance(root_value, str) or not Path(root_value).is_absolute():
        emit({"ok": False, "status": "hold", "reason": "registered library root must be absolute"}, 2)
    root = Path(root_value).resolve()
    marker = root / str(config.get("marker", ".design-library.json"))
    if not root.is_dir() or root.is_symlink() or not marker.is_file():
        emit({"ok": False, "status": "hold", "reason": "registered library root or marker is invalid", "root": str(root)}, 2)
    if os.name != "nt":
        os.chmod(root, 0o700)
    return root


def load_catalog(root: Path) -> dict[str, Any]:
    try:
        catalog = json.loads((root / "CATALOG.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        emit({"ok": False, "status": "hold", "reason": f"invalid catalog: {error}"}, 2)
    if catalog.get("schemaVersion") != 1 or not isinstance(catalog.get("items"), list):
        emit({"ok": False, "status": "hold", "reason": "unsupported catalog schema"}, 2)
    return catalog


def normalized_tags(raw: str) -> list[str]:
    tags: list[str] = []
    for value in raw.split(","):
        tag = value.strip().lower()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def stored_original(root: Path, item: dict[str, Any]) -> Path:
    relative = item.get("relativePath")
    stored_name = item.get("storedFilename", item.get("originalFilename"))
    if not isinstance(relative, str) or not isinstance(stored_name, str):
        raise ValueError("catalog item lacks a stored original path")
    stored = (root / relative / stored_name).resolve()
    if root != stored and root not in stored.parents:
        raise ValueError("catalog item escapes the registered library")
    if not stored.is_file() or stored.is_symlink():
        raise ValueError("stored original must be a real file")
    return stored


def remove_verified_source(source: Path, stored: Path, digest: str) -> bool:
    if source == stored:
        return False
    if not source.is_file() or source.is_symlink():
        raise ValueError("source must remain a real file until verified removal")
    if sha256(stored) != digest or sha256(source) != digest:
        raise ValueError("source removal refused because the stored copy hash differs")
    source.unlink()
    return True


def validate_system_manifest(item_dir: Path, item_id: str) -> list[dict[str, Any]]:
    """Validate an optional multi-file cross-media system without requiring it for ordinary items."""
    manifest_path = item_dir / "SYSTEM.json"
    if not manifest_path.exists():
        return []
    if not manifest_path.is_file() or manifest_path.is_symlink():
        return [{"id": item_id, "invalid": "SYSTEM.json must be a real file"}]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [{"id": item_id, "invalid": "SYSTEM.json"}]
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "cross-media-frame-design-system":
        return [{"id": item_id, "invalid": "unsupported SYSTEM.json schema or kind"}]
    version = manifest.get("version")
    files = manifest.get("files")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        return [{"id": item_id, "invalid": "SYSTEM.json version"}]
    if not isinstance(files, dict) or set(files) != SYSTEM_MANIFEST_ROLES:
        return [{"id": item_id, "invalid": "SYSTEM.json file roles"}]
    problems: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for role in sorted(SYSTEM_MANIFEST_ROLES):
        entry = files.get(role)
        if not isinstance(entry, dict):
            problems.append({"id": item_id, "invalid": f"SYSTEM.json {role} entry"})
            continue
        relative = entry.get("path")
        digest = entry.get("sha256")
        if (not isinstance(relative, str) or Path(relative).name != relative or
                relative in seen_paths or not isinstance(digest, str) or
                not re.fullmatch(r"[0-9a-f]{64}", digest)):
            problems.append({"id": item_id, "invalid": f"SYSTEM.json {role} path or hash"})
            continue
        seen_paths.add(relative)
        target = item_dir / relative
        if not target.is_file() or target.is_symlink():
            problems.append({"id": item_id, "missing": relative, "role": role})
        elif sha256(target) != digest:
            problems.append({"id": item_id, "mismatch": f"SYSTEM.json {role} sha256"})
    return problems


def add(args: argparse.Namespace) -> None:
    root = load_library()
    source = Path(args.source).expanduser().resolve()
    if not source.is_file() or source.is_symlink():
        emit({"ok": False, "status": "hold", "reason": "source must be a real file", "source": str(source)}, 2)
    catalog = load_catalog(root)
    digest = sha256(source)
    duplicate = next((item for item in catalog["items"] if item.get("sha256") == digest), None)
    if duplicate:
        if args.dry_run:
            emit({"ok": True, "status": "would-move-duplicate-source" if args.move_source else "duplicate",
                  "item": duplicate, "sourcePreserved": True, "sourceRemoved": False})
        source_removed = False
        if args.move_source:
            try:
                source_removed = remove_verified_source(source, stored_original(root, duplicate), digest)
            except (OSError, ValueError) as error:
                emit({"ok": False, "status": "duplicate-source-retained", "reason": str(error),
                      "item": duplicate, "sourcePreserved": True}, 1)
        emit({"ok": True, "status": "duplicate-source-moved" if source_removed else "duplicate",
              "item": duplicate, "sourcePreserved": not source_removed, "sourceRemoved": source_removed})
    received = args.received or dt.date.today().isoformat()
    try:
        dt.date.fromisoformat(received)
    except ValueError:
        emit({"ok": False, "status": "hold", "reason": "received must be YYYY-MM-DD"}, 2)
    title = args.title.strip()
    item_id = f"{received}-{slugify(title)}"
    destination_dir = root / CATEGORY_DIRS[args.category] / item_id
    if destination_dir.exists():
        item_id = f"{item_id}-{digest[:8]}"
        destination_dir = root / CATEGORY_DIRS[args.category] / item_id
    relative_dir = destination_dir.relative_to(root).as_posix()
    stored_name = source.name
    if stored_name.casefold() in RESERVED_ITEM_FILENAMES:
        suffix = source.suffix
        stem = source.stem
        stored_name = f"{stem}-original{suffix}"
    destination_file = destination_dir / stored_name
    category_dir = destination_dir.parent
    if not category_dir.is_dir() or category_dir.is_symlink():
        emit({"ok": False, "status": "hold", "reason": "category destination must be a real directory", "category": str(category_dir)}, 2)
    tags = normalized_tags(args.tags)
    if args.category not in tags:
        tags.insert(0, args.category)
    metadata = {
        "schemaVersion": 1, "id": item_id, "title": title, "category": args.category,
        "tags": tags, "relativePath": relative_dir, "originalFilename": source.name,
        "storedFilename": stored_name,
        "sha256": digest, "bytes": source.stat().st_size, "receivedAt": received,
        "source": {"type": args.source_type, "url": args.source_url, "owner": args.source_owner,
                   "licenseOrPermission": args.license, "publicRedistribution": args.redistribution},
        "evidence": {"observed": args.observed, "inferred": args.inferred,
                     "recommended": args.recommended, "unknown": args.unknown},
        "preference": {"liked": args.liked, "reuse": args.reuse, "avoid": args.avoid},
    }
    planned_status = "would-add-and-move" if args.dry_run and args.move_source else "would-add"
    result = {"ok": True, "status": planned_status if args.dry_run else "added", "item": metadata,
              "destinationFile": str(destination_file), "sourcePreserved": True}
    if args.dry_run:
        emit(result)
    destination_dir.mkdir(parents=False, exist_ok=False)
    if os.name != "nt":
        os.chmod(destination_dir, 0o700)
    try:
        shutil.copy2(source, destination_file)
        if os.name != "nt":
            os.chmod(destination_file, 0o600)
        atomic_text(destination_dir / "METADATA.json", json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        source_record = f"""# Source Record

- Title: {title}
- Source type: {args.source_type}
- Source URL: {args.source_url}
- Source owner: {args.source_owner}
- Captured or received at: {received}
- License or permission: {args.license}
- Public redistribution: {args.redistribution}
- Original filename: {source.name}
- SHA-256: {digest}

## Evidence boundary

- Observed: {args.observed}
- Inferred: {args.inferred}
- Recommended: {args.recommended}
- Unknown: {args.unknown}

## Personal preference

- What I like: {args.liked}
- What to reuse: {args.reuse}
- What to avoid: {args.avoid}
- Suitable outputs: {', '.join(tags)}
"""
        atomic_text(destination_dir / "SOURCE.md", source_record)
        catalog["items"].append(metadata)
        catalog["items"].sort(key=lambda item: (item.get("receivedAt", ""), item.get("id", "")))
        atomic_text(root / "CATALOG.json", json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    except Exception:
        shutil.rmtree(destination_dir, ignore_errors=True)
        raise
    if args.move_source:
        try:
            source_removed = remove_verified_source(source, destination_file, digest)
        except (OSError, ValueError) as error:
            result.update({"ok": False, "status": "added-source-retained", "reason": str(error),
                           "sourcePreserved": True, "sourceRemoved": False})
            emit(result, 1)
        result.update({"status": "added-and-source-moved" if source_removed else "added",
                       "sourcePreserved": not source_removed, "sourceRemoved": source_removed})
    emit(result)


def audit(_: argparse.Namespace) -> None:
    root = load_library()
    catalog = load_catalog(root)
    registered_paths = {item.get("relativePath") for item in catalog["items"]}
    missing: list[str] = []
    invalid: list[dict[str, Any]] = []
    for item in catalog["items"]:
        relative = item.get("relativePath")
        item_dir = root / relative if isinstance(relative, str) else None
        if item_dir is None or not item_dir.is_dir():
            missing.append(str(item.get("id", UNKNOWN)))
            continue
        stored_name = item.get("storedFilename", item.get("originalFilename"))
        for required in ("SOURCE.md", "METADATA.json", stored_name):
            if not isinstance(required, str) or not (item_dir / required).is_file():
                invalid.append({"id": item.get("id", UNKNOWN), "missing": required})
        metadata_path = item_dir / "METADATA.json"
        original_path = item_dir / stored_name if isinstance(stored_name, str) else None
        if metadata_path.is_file():
            try:
                item_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                if item_metadata != item:
                    invalid.append({"id": item.get("id", UNKNOWN), "mismatch": "catalog-vs-metadata"})
            except (OSError, json.JSONDecodeError):
                invalid.append({"id": item.get("id", UNKNOWN), "invalid": "METADATA.json"})
        if original_path is not None and original_path.is_file():
            if sha256(original_path) != item.get("sha256"):
                invalid.append({"id": item.get("id", UNKNOWN), "mismatch": "sha256"})
            if original_path.stat().st_size != item.get("bytes"):
                invalid.append({"id": item.get("id", UNKNOWN), "mismatch": "bytes"})
        invalid.extend(validate_system_manifest(item_dir, str(item.get("id", UNKNOWN))))
    unregistered: list[str] = []
    inbox = root / "00_INBOX"
    for file in sorted(inbox.iterdir()):
        if file.is_file() and file.name != "README.md":
            unregistered.append(file.relative_to(root).as_posix())
    for category_dir in CATEGORY_DIRS.values():
        base = root / category_dir
        for item_dir in sorted(base.iterdir() if base.is_dir() else []):
            if item_dir.is_dir() and item_dir.relative_to(root).as_posix() not in registered_paths:
                unregistered.append(item_dir.relative_to(root).as_posix())
    emit({"ok": not missing and not invalid, "status": "clean" if not missing and not invalid and not unregistered else "attention",
          "items": len(catalog["items"]), "missingItems": missing, "invalidItems": invalid, "unregistered": unregistered},
         0 if not missing and not invalid else 1)


def search(args: argparse.Namespace) -> None:
    root = load_library()
    catalog = load_catalog(root)
    terms = [term.lower() for term in args.text]
    required_tags = set(normalized_tags(args.tags))
    matches = []
    for item in catalog["items"]:
        if args.category and item.get("category") != args.category:
            continue
        if required_tags and not required_tags.issubset(set(item.get("tags", []))):
            continue
        if terms and not all(term in json.dumps(item, ensure_ascii=False).lower() for term in terms):
            continue
        matches.append(item)
    emit({"ok": True, "status": "found", "count": len(matches), "items": matches})


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__)
    commands = main.add_subparsers(dest="command", required=True)
    add_parser = commands.add_parser("add", help="copy and catalog one design reference")
    add_parser.add_argument("source")
    add_parser.add_argument("--category", choices=CATEGORY_DIRS, required=True)
    add_parser.add_argument("--title", required=True)
    add_parser.add_argument("--tags", default="")
    add_parser.add_argument("--received")
    add_parser.add_argument("--source-type", default=UNKNOWN)
    add_parser.add_argument("--source-url", default=UNKNOWN)
    add_parser.add_argument("--source-owner", default=UNKNOWN)
    add_parser.add_argument("--license", default=UNKNOWN)
    add_parser.add_argument("--redistribution", default=UNKNOWN)
    add_parser.add_argument("--observed", default=UNKNOWN)
    add_parser.add_argument("--inferred", default=UNKNOWN)
    add_parser.add_argument("--recommended", default=UNKNOWN)
    add_parser.add_argument("--unknown", default=UNKNOWN)
    add_parser.add_argument("--liked", default=UNKNOWN)
    add_parser.add_argument("--reuse", default=UNKNOWN)
    add_parser.add_argument("--avoid", default="third-party copy, logos, assets, and distinctive composition")
    add_parser.add_argument("--dry-run", action="store_true")
    add_parser.add_argument("--move-source", action="store_true",
                            help="delete the exact source only after the stored copy hash is verified")
    add_parser.set_defaults(handler=add)
    audit_parser = commands.add_parser("audit", help="check catalog and list unregistered inbox files")
    audit_parser.set_defaults(handler=audit)
    search_parser = commands.add_parser("search", help="query catalog metadata")
    search_parser.add_argument("text", nargs="*")
    search_parser.add_argument("--category", choices=CATEGORY_DIRS)
    search_parser.add_argument("--tags", default="")
    search_parser.set_defaults(handler=search)
    return main


def main() -> None:
    args = parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REQUIRED_FIELDS = ("title", "author", "date", "output")
PLACEHOLDER_PATTERNS = (
    re.compile(r"\b(?:TODO|TBD|FIXME)\b", re.IGNORECASE),
    re.compile(r"<[^>\n]+>"),
    re.compile(r"YYYY-MM-DD"),
)
LOCAL_PRIVATE_PATH = re.compile(r"(?:/Users/[^/\s]+|/home/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)")
IMAGE = re.compile(r"!\[[^]]*\]\(([^)]+)\)")


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        raise ValueError("Markdown must start with YAML-style frontmatter.")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError("Frontmatter closing delimiter was not found.")
    metadata: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"Invalid frontmatter line: {line}")
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip("\"'")
    return metadata, text[end + 5 :]


def validate(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    errors: list[str] = []
    try:
        metadata, body = parse_frontmatter(text)
    except ValueError as exc:
        return [str(exc)]

    for field in REQUIRED_FIELDS:
        if not metadata.get(field):
            errors.append(f"Missing frontmatter field: {field}")

    headings = re.findall(r"^#\s+(.+)$", body, flags=re.MULTILINE)
    if len(headings) != 1:
        errors.append(f"Use exactly one H1 in the body; found {len(headings)}.")

    for pattern in PLACEHOLDER_PATTERNS:
        match = pattern.search(text)
        if match:
            errors.append(f"Unresolved placeholder: {match.group(0)}")

    private_path = LOCAL_PRIVATE_PATH.search(body)
    if private_path:
        errors.append(f"Private absolute path exposed in body: {private_path.group(0)}")

    for target in IMAGE.findall(body):
        clean_target = target.split("#", 1)[0].strip()
        if re.match(r"^[a-z]+://", clean_target, flags=re.IGNORECASE):
            continue
        if not (path.parent / clean_target).exists():
            errors.append(f"Image not found: {target}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a General Report Design Markdown source.")
    parser.add_argument("markdown", type=Path)
    args = parser.parse_args()
    path = args.markdown.resolve()
    errors = validate(path)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"CHECK PASSED: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

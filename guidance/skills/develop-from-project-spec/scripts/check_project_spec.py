#!/usr/bin/env python3
"""Validate the minimum traceable contract of a repository-local specification."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REQUIRED_HEADINGS = (
    "Authority and document roles",
    "Outcome",
    "User value",
    "Scope",
    "Requirements",
    "Scenarios",
    "Quality and boundaries",
    "Dependencies and risks",
    "UNKNOWN and HOLD",
    "Acceptance evidence",
    "Implementation outline",
)


def resolve_inside(root: Path, value: Path) -> Path | None:
    candidate = value if value.is_absolute() else root / value
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="Git root containing the specification")
    parser.add_argument("--spec", type=Path, default=Path("SPEC.md"), help="Spec path relative to the Git root")
    parser.add_argument("--intent", type=Path, help="Required source intent path for a focused spec")
    args = parser.parse_args()

    root = args.root.resolve()
    spec_path = resolve_inside(root, args.spec)
    if spec_path is None:
        print(f"FAIL: spec must stay inside {root}")
        return 1
    if not spec_path.is_file():
        print(f"FAIL: missing {spec_path}")
        return 1

    text = spec_path.read_text(encoding="utf-8")
    headings = set(re.findall(r"^##\s+(.+?)\s*$", text, flags=re.MULTILINE))
    missing = [heading for heading in REQUIRED_HEADINGS if heading not in headings]
    fr_ids = set(re.findall(r"\bFR-\d{3}\b", text))
    sc_ids = set(re.findall(r"\bSC-\d{3}\b", text))
    scenario_ids = set(re.findall(r"\bS-\d{3}\b", text))

    errors: list[str] = []
    if missing:
        errors.append("missing headings: " + ", ".join(missing))
    if not fr_ids:
        errors.append("no FR-### requirement IDs")
    if not sc_ids:
        errors.append("no SC-### success-criterion IDs")
    if not scenario_ids:
        errors.append("no S-### scenario IDs")
    if any(marker in text for marker in ("<Product>", "<observable", "<who is", "TODO")):
        errors.append("unfinished template markers remain")

    if args.intent:
        intent_path = resolve_inside(root, args.intent)
        if intent_path is None:
            errors.append(f"intent must stay inside {root}")
        elif not intent_path.is_file():
            errors.append(f"missing source intent: {intent_path}")
        else:
            expected = intent_path.relative_to(root).as_posix()
            source = re.search(r"^-\s*Source intent:\s*(.+?)\s*$", text, flags=re.MULTILINE)
            actual = source.group(1).strip().replace("\\", "/") if source else ""
            if actual != expected:
                errors.append(f"Source intent must be {expected}")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    print(
        f"PASS: {spec_path} "
        f"({len(fr_ids)} requirements, {len(sc_ids)} criteria, {len(scenario_ids)} scenarios)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

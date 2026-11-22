#!/usr/bin/env python3
"""Validate the minimum owner-reviewable contract of a change intent."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REQUIRED_HEADINGS = (
    "Problem",
    "Evidence",
    "Desired outcome",
    "Affected users and systems",
    "Constraints",
    "Out of scope",
    "Success signals",
    "Open questions",
    "Decision",
)
REQUIRED_FIELDS = ("ID", "Status", "Owner", "Target", "Supersedes")
ALLOWED_STATUSES = {"draft", "accepted", "rejected", "delivered", "superseded"}


def within_root(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="Git root containing the intent")
    parser.add_argument("intent", type=Path, help="Intent path, relative to the Git root")
    args = parser.parse_args()

    root = args.root.resolve()
    intent_path = args.intent if args.intent.is_absolute() else root / args.intent
    intent_path = intent_path.resolve()
    if not within_root(root, intent_path):
        print(f"FAIL: intent must stay inside {root}")
        return 1
    if not intent_path.is_file():
        print(f"FAIL: missing {intent_path}")
        return 1

    text = intent_path.read_text(encoding="utf-8")
    headings = set(re.findall(r"^##\s+(.+?)\s*$", text, flags=re.MULTILINE))
    missing_headings = [heading for heading in REQUIRED_HEADINGS if heading not in headings]
    fields = {
        key: match.group(1).strip()
        for key in REQUIRED_FIELDS
        if (match := re.search(rf"^-\s*{re.escape(key)}:\s*(.+?)\s*$", text, flags=re.MULTILINE))
    }

    errors: list[str] = []
    if missing_headings:
        errors.append("missing headings: " + ", ".join(missing_headings))
    missing_fields = [field for field in REQUIRED_FIELDS if field not in fields]
    if missing_fields:
        errors.append("missing metadata: " + ", ".join(missing_fields))
    status = fields.get("Status", "").lower()
    if status and status not in ALLOWED_STATUSES:
        errors.append("invalid Status; use " + ", ".join(sorted(ALLOWED_STATUSES)))
    if fields.get("ID") and not re.fullmatch(r"INT-[A-Za-z0-9][A-Za-z0-9._-]*", fields["ID"]):
        errors.append("ID must use INT-<stable-id>")
    if status in {"accepted", "rejected", "delivered", "superseded"}:
        decision = re.search(
            r"^##\s+Decision\s*$\n(?P<body>.*?)(?=^##\s+|\Z)",
            text,
            flags=re.MULTILINE | re.DOTALL,
        )
        if not decision or not decision.group("body").strip() or "pending" in decision.group("body").lower():
            errors.append(f"Status {status} requires a non-pending Decision")
    if any(marker in text for marker in ("<Change>", "<stable-id>", "<person", "TODO")):
        errors.append("unfinished template markers remain")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    print(f"PASS: {intent_path} (status {status})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

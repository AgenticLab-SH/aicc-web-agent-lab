#!/usr/bin/env python3
"""Deterministic AFW design-artifact preflight; browser QA remains a separate gate."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


REQUIRED_DESIGN_HEADINGS = (
    "Product character",
    "Foundation tokens",
    "Typography",
    "Motion",
    "Responsive",
    "Accessibility",
    "Provenance",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=Path)
    parser.add_argument("--design", default="agenticfabworks-web-design.md")
    parser.add_argument("--qa", default="design-qa.md")
    args = parser.parse_args()

    project = args.project.resolve()
    design = project / args.design
    qa = project / args.qa
    findings: list[str] = []

    if not design.is_file():
        findings.append(f"missing design source: {design}")
    else:
        body = design.read_text(encoding="utf-8")
        for heading in REQUIRED_DESIGN_HEADINGS:
            if heading.lower() not in body.lower():
                findings.append(f"design source missing section: {heading}")

    if not qa.is_file():
        findings.append(f"missing design QA: {qa}")
    else:
        body = qa.read_text(encoding="utf-8")
        if "final result: passed" not in body.lower():
            findings.append("design QA is not passed")
        if "score:" not in body.lower():
            findings.append("design QA has no score")

    for finding in findings:
        print(f"FAIL {finding}")
    if findings:
        return 1
    print(f"PASS design contract: {project}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

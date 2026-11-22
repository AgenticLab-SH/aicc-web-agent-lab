#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate_report_markdown.py")
SPEC = importlib.util.spec_from_file_location("validate_report_markdown", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ReportValidatorTest(unittest.TestCase):
    def test_valid_report_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "report.md"
            path.write_text(
                "---\n"
                "title: 점검 보고서\n"
                "author: 작성자\n"
                "date: 2026-08-14\n"
                "output: report.pdf\n"
                "---\n\n"
                "# 점검 보고서\n\n실제 결과를 확인했습니다.\n",
                encoding="utf-8",
            )
            self.assertEqual(MODULE.validate(path), [])

    def test_placeholder_and_private_path_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "report.md"
            path.write_text(
                "---\n"
                "title: TODO\n"
                "author: 작성자\n"
                "date: YYYY-MM-DD\n"
                "output: report.pdf\n"
                "---\n\n"
                "# 보고서\n\n/" + "Users/example/private/file.txt를 확인합니다.\n",
                encoding="utf-8",
            )
            errors = MODULE.validate(path)
            self.assertTrue(any("placeholder" in error for error in errors))
            self.assertTrue(any("Private absolute path" in error for error in errors))

    def test_missing_image_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "report.md"
            path.write_text(
                "---\n"
                "title: 그림 보고서\n"
                "author: 작성자\n"
                "date: 2026-08-14\n"
                "output: report.pdf\n"
                "---\n\n"
                "# 그림 보고서\n\n![결과](assets/missing.png)\n",
                encoding="utf-8",
            )
            self.assertTrue(any("Image not found" in error for error in MODULE.validate(path)))


if __name__ == "__main__":
    unittest.main()

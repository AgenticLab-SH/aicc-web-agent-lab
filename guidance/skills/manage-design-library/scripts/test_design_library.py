#!/usr/bin/env python3
"""Regression tests for design_library.py using only temporary directories."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("design_library.py")
CATEGORIES = (
    "00_INBOX", "01_WEB_UI", "02_PRESENTATION_PPT", "03_DOCUMENT_WORD",
    "04_PDF_LAYOUT", "05_REPORT", "06_IMAGE_GRAPHICS", "07_VISUALIZATION",
    "08_CROSS_MEDIA_SYSTEM", "09_MOTION_VIDEO",
)


class DesignLibraryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.library = self.root / "library"
        self.state = self.root / "state"
        for category in CATEGORIES:
            (self.library / category).mkdir(parents=True, exist_ok=True)
        (self.library / ".design-library.json").write_text(
            '{"schemaVersion":1,"kind":"personal-design-reference-library"}\n', encoding="utf-8"
        )
        (self.library / "CATALOG.json").write_text(
            '{"schemaVersion":1,"items":[]}\n', encoding="utf-8"
        )
        config = self.state / "config" / "design-library.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({
            "schemaVersion": 1, "root": str(self.library), "marker": ".design-library.json"
        }) + "\n", encoding="utf-8")
        self.env = {**os.environ, "AICC_STATE_ROOT": str(self.state)}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_tool(self, *arguments: str, expect: int = 0) -> dict:
        result = subprocess.run(
            ["python3", str(SCRIPT), *arguments], env=self.env,
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, expect, result.stderr or result.stdout)
        return json.loads(result.stdout)

    def test_reserved_filename_move_and_duplicate_dry_run(self) -> None:
        source = self.root / "source.md"
        source.write_text("# Reserved source name\n", encoding="utf-8")
        preview = self.run_tool(
            "add", str(source), "--category", "web", "--title", "Reserved Source",
            "--move-source", "--dry-run",
        )
        self.assertEqual(preview["status"], "would-add-and-move")
        self.assertTrue(source.exists())

        moved = self.run_tool(
            "add", str(source), "--category", "web", "--title", "Reserved Source", "--move-source",
        )
        self.assertEqual(moved["status"], "added-and-source-moved")
        self.assertFalse(source.exists())
        stored = Path(moved["destinationFile"])
        self.assertEqual(stored.name, "source-original.md")

        duplicate = self.root / "duplicate.md"
        duplicate.write_bytes(stored.read_bytes())
        duplicate_preview = self.run_tool(
            "add", str(duplicate), "--category", "web", "--title", "Duplicate",
            "--move-source", "--dry-run",
        )
        self.assertEqual(duplicate_preview["status"], "would-move-duplicate-source")
        self.assertTrue(duplicate.exists())

        duplicate_move = self.run_tool(
            "add", str(duplicate), "--category", "web", "--title", "Duplicate", "--move-source",
        )
        self.assertEqual(duplicate_move["status"], "duplicate-source-moved")
        self.assertFalse(duplicate.exists())
        self.assertEqual(self.run_tool("audit")["status"], "clean")

    def test_optional_cross_media_system_manifest(self) -> None:
        source = self.root / "frame.md"
        source.write_text("# Frame\n", encoding="utf-8")
        added = self.run_tool(
            "add", str(source), "--category", "cross-media", "--title", "Frame system",
        )
        item_dir = Path(added["destinationFile"]).parent
        role_files = {
            "frame": Path(added["destinationFile"]),
            "design": item_dir / "design.md",
            "adapters": item_dir / "adapters.md",
            "examples": item_dir / "examples.md",
            "sources": item_dir / "SOURCES.md",
        }
        for role, path in role_files.items():
            if role != "frame":
                path.write_text(f"# {role}\n", encoding="utf-8")
        manifest = {
            "schemaVersion": 1,
            "kind": "cross-media-frame-design-system",
            "version": "1.0.0",
            "files": {
                role: {"path": path.name, "sha256": __import__("hashlib").sha256(path.read_bytes()).hexdigest()}
                for role, path in role_files.items()
            },
        }
        (item_dir / "SYSTEM.json").write_text(json.dumps(manifest) + "\n", encoding="utf-8")
        self.assertEqual(self.run_tool("audit")["status"], "clean")

        role_files["design"].write_text("# changed\n", encoding="utf-8")
        audit = self.run_tool("audit", expect=1)
        self.assertEqual(audit["status"], "attention")
        self.assertIn(
            {"id": added["item"]["id"], "mismatch": "SYSTEM.json design sha256"},
            audit["invalidItems"],
        )


if __name__ == "__main__":
    unittest.main()

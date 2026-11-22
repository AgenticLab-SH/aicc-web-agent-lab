from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_manifest", ROOT / "build_manifest.py")
BUILD = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(BUILD)


class BuildManifestTests(unittest.TestCase):
    def test_shared_upstream_is_grouped_and_inactive_source_is_skipped(self) -> None:
        ledger = {"sources": [
            {"id": "one", "status": "absorbed", "canonical_url": "https://github.com/org/repo", "upstream_monitor": {"mode": "git-ls-remote", "latest_seen_ref": "a" * 40}},
            {"id": "two", "status": "absorbed", "canonical_url": "https://github.com/org/repo.git", "upstream_monitor": {"mode": "git-ls-remote", "latest_seen_ref": "a" * 40}},
            {"id": "old", "status": "superseded", "canonical_url": "https://github.com/org/old", "upstream_monitor": {"mode": "git-ls-remote", "latest_seen_ref": "b" * 40}},
        ]}
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "ledger.json"
            file.write_text(json.dumps(ledger), encoding="utf-8")
            rows = BUILD.ledger_sources(file, set())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sourceIds"], ["one", "two"])


if __name__ == "__main__":
    unittest.main()

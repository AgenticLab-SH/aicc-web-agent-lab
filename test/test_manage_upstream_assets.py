"""Contract checks for the read-only, registered-only upstream inventory skill."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SRC = Path(__file__).resolve().parents[1] / "guidance/skills/manage-upstream-assets/scripts/inventory.py"
spec = importlib.util.spec_from_file_location("aicc_upstream_inventory", SRC)
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class UpstreamInventoryTests(unittest.TestCase):
    def test_registered_sources_dependencies_and_crawlers_without_mutation(self):
        with tempfile.TemporaryDirectory(prefix="aicc-upstream-") as t:
            root = Path(t)
            repo = root / "source"
            state = root / "owner"
            project = root / "project"
            (state / "cross-device").mkdir(parents=True)
            (project / "apps" / "ui").mkdir(parents=True)
            (repo / "guidance/skills/aicc-guidance-review/references").mkdir(parents=True)
            (repo / "src/knowledge-review").mkdir(parents=True)
            portfolio = (
                '[[projects]]\nid="source1"\npath="' + project.as_posix() + '"\nrole="source"\n'
                'canonical_state="ready"\ncanonical_repo="Org/one"\n'
                '[[projects]]\nid="duplicate"\npath="' + project.as_posix() + '"\n'
                'role="worktree"\ncanonical_state="ready"\ncanonical_repo="Org/one"\n'
            )
            (state / "cross-device/project-portfolio.toml").write_text(portfolio, encoding="utf-8")
            (project / "package.json").write_text(
                json.dumps({"dependencies": {"safe-lib": "^1.2.3", "unsafe-lib": "https://secret.invalid/a?token=value"}}),
                encoding="utf-8",
            )
            (project / "apps/ui/pyproject.toml").write_text(
                '[project]\ndependencies=["httpx>=0.27"]\n', encoding="utf-8"
            )
            ledger = {"sources": [
                {"id": "safe", "kind": "dependency", "canonical_url": "https://github.com/org/lib?token=no",
                 "status": "absorbed", "upstream_monitor": {"mode": "git-ls-remote"}},
                {"id": "unsafe", "canonical_url": "http://127.0.0.1:10100/secret", "status": "absorbed"},
            ]}
            (repo / "guidance/skills/aicc-guidance-review/references/absorption-ledger.json").write_text(
                json.dumps(ledger), encoding="utf-8"
            )
            (repo / "src/knowledge-review/policy.mjs").write_text(
                "id: 'official-source', label: 'Official', seedUrl: 'https://example.com/llms.txt', "
                "manualOnly: true, automaticApply: false", encoding="utf-8"
            )
            snap = inventory.collect(repo, state, live=False)
            self.assertEqual(snap["coverage"]["registeredProjectEntries"], 2)
            self.assertEqual(snap["coverage"]["distinctReadySourceProjects"], 1)
            self.assertEqual(snap["coverage"]["dependenciesDeclared"], 3)
            self.assertEqual(snap["coverage"]["officialCrawlerTargets"], 1)
            self.assertEqual(snap["coverage"]["externalProvenanceRecords"], 1)
            self.assertFalse(snap["automaticApply"])
            self.assertFalse(snap["coverage"]["wholePcScanned"])
            self.assertIn("runtime_not_probed", snap["unknown"])
            self.assertFalse((state / "inventory").exists(), "read-only mode unexpectedly wrote files")
            redact = next(v for v in snap["directDependencies"] if v["name"] == "unsafe-lib")
            self.assertEqual(redact["declared"], "URL_OR_DYNAMIC_REDACTED")
            self.assertEqual(snap["externalSources"][0]["url"], "https://github.com/org/lib")
            inventory.write_snapshot(state / "inventory/upstream-assets.json", snap)
            self.assertTrue((state / "inventory/upstream-assets.json").exists())
            self.assertEqual(json.loads((state / "inventory/upstream-assets.json").read_text())["schemaVersion"], 1)
            with self.assertRaises(ValueError):
                inventory.write_snapshot(state / "inventory/credentials.json", snap)

    def test_no_secret_urls_and_missing_source_are_held(self):
        self.assertIsNone(inventory.public_url("https://user:password@localhost:10100/private"))
        # Credentials are removed even from an otherwise valid official host.
        self.assertEqual(inventory.public_url("https://user:token@example.com/a?q=secret#fragment"),
                         "https://example.com/a")
        with tempfile.TemporaryDirectory() as t:
            snap = inventory.collect(Path(t), Path(t), live=False)
            self.assertIn("portfolio_not_available", snap["unknown"])
            self.assertIn("official_crawler_policy_missing", snap["unknown"])


if __name__ == "__main__":
    unittest.main()

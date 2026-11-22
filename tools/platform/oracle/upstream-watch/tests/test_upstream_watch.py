from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("upstream_watch", ROOT / "upstream_watch.py")
WATCH = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(WATCH)


class UpstreamWatchTests(unittest.TestCase):
    def test_private_without_key_or_token_requires_auth(self) -> None:
        source = {"repository": "owner/repo", "trackedRef": "main", "baselineRevision": "abc", "visibility": "private", "credentialId": "missing"}
        with mock.patch.object(WATCH, "KEY_ROOT", Path("/definitely/missing")):
            self.assertEqual(WATCH.github_status(source, None)["status"], "auth_required")

    def test_local_git_mode_uses_existing_git_credentials_for_private_sources(self) -> None:
        source = {"repository": "owner/repo", "trackedRef": "main", "baselineRevision": "a" * 40, "visibility": "private"}
        with mock.patch.object(WATCH, "git_remote_status", return_value={"status": "current"}) as local_git:
            self.assertEqual(WATCH.github_status(source, None, "local-git")["status"], "current")
        local_git.assert_called_once_with(source)

    def test_git_remote_status_compares_sha(self) -> None:
        source = {"repository": "owner/repo", "trackedRef": "main", "baselineRevision": "a" * 40, "visibility": "public"}
        completed = subprocess.CompletedProcess([], 0, stdout=("b" * 40) + "\trefs/heads/main\n", stderr="")
        with mock.patch.object(WATCH.subprocess, "run", return_value=completed):
            result = WATCH.git_remote_status(source)
        self.assertEqual(result["status"], "update_available")

    def test_npm_update(self) -> None:
        source = {"package": "pkg", "baselineVersion": "1.0.0", "channel": "latest"}
        with mock.patch.object(WATCH, "fetch_json", return_value={"dist-tags": {"latest": "1.1.0"}}):
            result = WATCH.npm_status(source)
        self.assertEqual(result["currentVersion"], "1.1.0")

    def test_reference_npm_reports_latest_without_claiming_install(self) -> None:
        source = {"package": "pkg", "observationMode": "reference", "channel": "latest"}
        with mock.patch.object(WATCH, "fetch_json", return_value={"dist-tags": {"latest": "3.2.1"}}):
            result = WATCH.npm_status(source)
        self.assertEqual(result["status"], "reference")
        self.assertEqual(result["currentVersion"], "3.2.1")
        self.assertIsNone(result["baselineVersion"])

    def test_run_writes_only_one_material_event(self) -> None:
        manifest = {"sources": [{"id": "npm", "type": "npm", "package": "pkg", "baselineVersion": "1", "channel": "latest"}]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = root / "manifest.json"
            state = root / "state.json"
            events = root / "events.jsonl"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with mock.patch.object(WATCH, "npm_status", return_value={"status": "current", "baselineVersion": "1", "currentVersion": "1"}):
                WATCH.run(manifest_path, state, events)
                WATCH.run(manifest_path, state, events)
            self.assertEqual(len(events.read_text(encoding="utf-8").splitlines()), 1)
            self.assertFalse(json.loads(state.read_text(encoding="utf-8"))["automaticApply"])

    def test_run_preserves_bounded_source_policy_metadata(self) -> None:
        manifest = {"sources": [{
            "id": "codex", "type": "npm", "package": "@openai/codex", "baselineVersion": "1", "channel": "latest",
            "label": "Codex CLI", "applyPolicy": "guarded-action", "applyAction": "codex-cli.update"
        }]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = root / "manifest.json"
            state = root / "state.json"
            events = root / "events.jsonl"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with mock.patch.object(WATCH, "npm_status", return_value={"status": "current", "baselineVersion": "1", "currentVersion": "1"}):
                report = WATCH.run(manifest_path, state, events)
            self.assertEqual(report["sources"][0]["label"], "Codex CLI")
            self.assertEqual(report["sources"][0]["applyAction"], "codex-cli.update")


if __name__ == "__main__":
    unittest.main()

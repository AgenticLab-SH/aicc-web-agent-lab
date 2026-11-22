from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


TOOL = Path(__file__).resolve().parents[1] / "inspect" / "project_portfolio.py"
SPEC = importlib.util.spec_from_file_location("project_portfolio", TOOL)
assert SPEC and SPEC.loader
portfolio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(portfolio)


class ProjectPortfolioTest(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(self.addCleanupDirectory())
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / "README.md").write_text("# Test\n", encoding="utf-8")
        (root / "AGENTS.md").write_text("# Rules\n", encoding="utf-8")
        (root / ".gitignore").write_text(".env\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(root), "remote", "add", "dual", "https://github.com/Test/private-source.git"],
            check=True,
        )
        return root

    def addCleanupDirectory(self) -> str:
        temporary = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(temporary, ignore_errors=True))
        return temporary

    def test_registered_remote_and_optional_docs_are_detected(self) -> None:
        root = self.make_repo()
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "dual",
                "canonical_repo": "Test/private-source",
                "canonical_state": "ready",
            }
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["canonical_remote_repo"], "Test/private-source")
        self.assertTrue(result["has_readme"])
        self.assertTrue(result["has_agents"])

    def test_root_docs_are_optional(self) -> None:
        root = self.make_repo()
        (root / "README.md").unlink()
        (root / "AGENTS.md").unlink()
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "dual",
                "canonical_repo": "Test/private-source",
                "canonical_state": "ready",
            }
        )
        self.assertTrue(result["ok"])
        self.assertFalse(result["has_readme"])
        self.assertFalse(result["has_agents"])
        self.assertNotIn("root README missing", result["warnings"])
        self.assertNotIn("root AGENTS.md missing", result["warnings"])

    def test_remote_mismatch_is_an_error(self) -> None:
        root = self.make_repo()
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "dual",
                "canonical_repo": "Test/another-source",
                "canonical_state": "ready",
            }
        )
        self.assertFalse(result["ok"])
        self.assertTrue(any("mismatch" in error for error in result["errors"]))

    def test_pending_remote_reports_its_blocker(self) -> None:
        root = self.make_repo()
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "dual",
                "canonical_repo": "Test/future-source",
                "canonical_state": "pending",
                "canonical_blocker": "clean history required",
            }
        )
        self.assertTrue(result["ok"])
        self.assertTrue(any("clean history required" in warning for warning in result["warnings"]))

    def test_pending_remote_may_be_intentionally_absent(self) -> None:
        root = self.make_repo()
        subprocess.run(["git", "-C", str(root), "remote", "remove", "dual"], check=True)
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "origin",
                "canonical_repo": "",
                "canonical_state": "pending",
                "canonical_blocker": "privacy review required",
            },
            check_github=True,
            enforce_local_name=True,
        )
        self.assertTrue(result["ok"])
        self.assertIsNone(result["canonical_remote_repo"])
        self.assertTrue(any("privacy review required" in warning for warning in result["warnings"]))

    def test_tracking_reports_untracked_ahead_and_behind_without_mutation(self) -> None:
        root = self.make_repo()
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "-qm", "initial"], check=True)
        subprocess.run(["git", "-C", str(root), "branch", "tracking", "HEAD"], check=True)
        subprocess.run(["git", "-C", str(root), "branch", "--set-upstream-to", "tracking", "main"], check=True)
        (root / "untracked.txt").write_text("pending\n", encoding="utf-8")
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "dual",
                "canonical_repo": "Test/private-source",
                "canonical_state": "ready",
            }
        )
        self.assertEqual(result["upstream"], "tracking")
        self.assertEqual(result["ahead"], 0)
        self.assertEqual(result["behind"], 0)
        self.assertEqual(result["untracked_files"], 1)
        self.assertRegex(result["head"], r"^[a-f0-9]{40}$")

    def test_owner_only_json_output(self) -> None:
        root = self.make_repo()
        manifest = Path(self.addCleanupDirectory()) / "portfolio.toml"
        manifest.write_text(
            f'''[[projects]]\nid = "test"\npath = "{root.as_posix()}"\ncanonical_remote = "dual"\ncanonical_repo = "Test/private-source"\n''',
            encoding="utf-8",
        )
        output = manifest.with_name("report.json")
        exit_code = portfolio.main(["--manifest", str(manifest), "--output", str(output)])
        self.assertEqual(exit_code, 0)
        if __import__("os").name != "nt":
            self.assertEqual(output.stat().st_mode & 0o077, 0)
        self.assertEqual(__import__("json").loads(output.read_text(encoding="utf-8"))["project_count"], 1)

    def test_local_name_policy_requires_git_root_basename(self) -> None:
        root = self.make_repo()
        subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "remote",
                "set-url",
                "dual",
                f"https://github.com/Test/{root.name}.git",
            ],
            check=True,
        )
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "dual",
                "canonical_repo": f"Test/{root.name}",
                "canonical_state": "ready",
            },
            enforce_local_name=True,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["expected_github_name"], root.name)

    def test_local_name_policy_supports_documented_override(self) -> None:
        root = self.make_repo()
        subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "remote",
                "set-url",
                "dual",
                "https://github.com/Test/portable-name.git",
            ],
            check=True,
        )
        result = portfolio.inspect_project(
            {
                "id": "test",
                "path": str(root),
                "canonical_remote": "dual",
                "canonical_repo": "Test/portable-name",
                "canonical_state": "ready",
                "github_name_override": "portable-name",
            },
            enforce_local_name=True,
        )
        self.assertTrue(result["ok"])

    def test_default_manifest_lives_in_personal_aicc_state(self) -> None:
        home = Path(self.addCleanupDirectory())
        self.assertEqual(
            portfolio.default_manifest_path(env={}, home=home),
            home / ".ai-control-center" / "cross-device" / "project-portfolio.toml",
        )

    def test_default_manifest_honors_custom_aicc_state_root(self) -> None:
        self.assertEqual(
            portfolio.default_manifest_path(env={"AICC_STATE_ROOT": "/private/aicc"}),
            Path("/private/aicc/cross-device/project-portfolio.toml"),
        )


if __name__ == "__main__":
    unittest.main()

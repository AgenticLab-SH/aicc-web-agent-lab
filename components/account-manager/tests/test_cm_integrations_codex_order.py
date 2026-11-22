"""Windows Codex discovery follows PATH order; fixture files only, no process launch."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import cm_integrations  # noqa: E402


@unittest.skipUnless(os.name == "nt", "Windows PATH/PATHEXT contract")
class CodexPathOrderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cm-codex-order-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def discover(self, directories):
        environment = dict(os.environ)
        environment["PATH"] = os.pathsep.join(map(str, directories))
        environment.pop("CM_REAL_CODEX", None)
        with mock.patch.dict(os.environ, environment, clear=True):
            with mock.patch.object(cm_integrations, "_section", return_value={}):
                return cm_integrations.real_codex_command()

    def test_earlier_official_exe_wins_over_later_npm_cmd(self):
        official, npm = self.root / "official", self.root / "npm"
        official.mkdir()
        npm.mkdir()
        (official / "codex.exe").write_bytes(b"")
        (npm / "codex.cmd").write_text("@echo off\n")
        self.assertEqual(self.discover([official, npm]), str(official / "codex.exe"))

    def test_wrapper_directory_is_skipped(self):
        wrapper = Path(cm_integrations.__file__).resolve().parent
        other = self.root / "other"
        other.mkdir()
        (other / "codex.cmd").write_text("@echo off\n")
        self.assertEqual(self.discover([wrapper, other]), str(other / "codex.cmd"))
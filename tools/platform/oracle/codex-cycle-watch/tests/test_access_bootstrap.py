import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import access_bootstrap as access


class AccessTests(unittest.TestCase):
    def before(self):
        return {"are-all-plugins-disabled": False, "is-management-disabled": False,
                "is-monitoring-disabled": False, "plugins-config": None}

    def test_only_bastion_changes_and_input_preserved(self):
        before = self.before()
        before["plugins-config"] = [{"name": "Monitoring", "desired-state": "ENABLED"}]
        snapshot = copy.deepcopy(before)
        value = access.config_with_bastion(before, True)
        self.assertEqual(value["pluginsConfig"], [{"name": "Monitoring", "desiredState": "ENABLED"},
                                                 {"name": "Bastion", "desiredState": "ENABLED"}])
        self.assertEqual(before, snapshot)

    def test_drift_refused_but_bastion_change_allowed(self):
        before = self.before()
        after = self.before()
        after["plugins-config"] = [{"name": "Bastion", "desired-state": "ENABLED"}]
        access.check_agent_drift(before, after)
        after["is-management-disabled"] = True
        with self.assertRaises(ValueError):
            access.check_agent_drift(before, after)

    def test_foreign_session_not_deleted(self):
        with patch.object(access, "owned_bastions", return_value=[{"id": "synthetic"}]), \
             patch.object(access, "cli", return_value={"data": [{"display-name": "foreign", "lifecycle-state": "ACTIVE"}]}) as cli:
            with self.assertRaises(ValueError):
                access.stop({})
            self.assertEqual(cli.call_count, 1)

    def test_stop_only_owned_session(self):
        with patch.object(access, "owned_bastions", return_value=[{"id": "synthetic"}]), \
             patch.object(access, "cli", side_effect=[{"data": [{"id": "session-fixture", "display-name": access.MARKER, "lifecycle-state": "ACTIVE"}]}, {}]) as cli:
            access.stop({})
            self.assertEqual(cli.call_args.args[:3], ("bastion", "session", "delete"))

    def test_dry_run_is_pure_for_every_operation(self):
        for action in ("start", "session", "stop", "rollback", "status", "plan"):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "aicc-oracle-access"
                result = subprocess.run([sys.executable, str(Path(access.__file__)), action, "--root", str(root),
                                         "--instance", "ocid1.instance.oc1.ap-osaka-1.fixture", "--dry-run"], capture_output=True)
                self.assertEqual(result.returncode, 0)
                self.assertFalse(json.loads(result.stdout)["mutation"])
                self.assertFalse(root.exists())

    def test_root_is_bounded(self):
        for root in ("/", "relative", "/demo/owner/aicc-oracle-access"):
            with self.assertRaises(ValueError):
                access.root_path(root)


if __name__ == "__main__":
    unittest.main()

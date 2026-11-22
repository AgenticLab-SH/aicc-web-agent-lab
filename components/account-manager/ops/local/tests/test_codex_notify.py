from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import codex_notify as notify


class CodexNotifyTests(unittest.TestCase):
    def test_aicc_event_is_record_only_and_excludes_identity_details(self):
        event = notify.build_aicc_event("app", now_ms=1_234)
        encoded = json.dumps(event, ensure_ascii=False)
        self.assertEqual(event["urgency"], 1)
        self.assertEqual(event["type"], "routine_progress")
        self.assertEqual(event["projectKey"], "account-manager")
        for forbidden in ("example.com", "hostname", "PID", "accountId", "auth"):
            self.assertNotIn(forbidden, encoded)

    def test_configured_aicc_path_must_be_absolute_regular_file(self):
        self.assertIsNone(notify.resolve_aicc_notify_command({"AICC_NOTIFY_BIN": "relative/aicc"}))
        with tempfile.TemporaryDirectory() as directory:
            command = Path(directory) / "aicc"
            command.write_text("placeholder", encoding="utf-8")
            self.assertEqual(
                notify.resolve_aicc_notify_command({"AICC_NOTIFY_BIN": str(command)}),
                str(command),
            )

    def test_aicc_send_uses_fixed_argv_and_json_stdin(self):
        completed = mock.Mock(returncode=0, stdout="{}", stderr="")
        with mock.patch("codex_notify.resolve_aicc_notify_command", return_value="/safe/aicc"), mock.patch(
            "codex_notify.subprocess.run", return_value=completed
        ) as run, mock.patch.dict(os.environ, {}, clear=True):
            ok, reason = notify.send_codex_aicc_event(notify.build_aicc_event("cli", now_ms=99))
        self.assertTrue(ok)
        self.assertEqual(reason, "armed")
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/safe/aicc", "notify", "arm", "--json"])
        self.assertEqual(json.loads(kwargs["input"])["eventId"], "account-manager:change:cli:99")
        self.assertFalse(kwargs["check"])

    def test_telegram_fallback_is_opt_in(self):
        with mock.patch("codex_notify.send_codex_aicc_event", return_value=(False, "offline")), mock.patch(
            "codex_notify.send_codex_telegram"
        ) as telegram, mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(notify.notify_account_change("app", "person@example.com", pid=4321))
        telegram.assert_not_called()


if __name__ == "__main__":
    unittest.main()

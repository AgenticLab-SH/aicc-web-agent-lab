import base64
import json
from pathlib import Path
import sys
import unittest

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
import cycle_watch as watch
import import_device_auth as importer

NOW = 1800000000
WEEK = 604800


def token(subject, expires=NOW + WEEK):
    body = base64.urlsafe_b64encode(json.dumps({"sub": subject, "exp": expires}).encode()).decode().rstrip("=")
    return "synthetic." + body + ".signature"


def document(subject="owner"):
    return {"version": 1, "accounts": [{
        "alias": "team-one", "accessToken": token(subject, NOW - 60),
        "chatgptAccountId": "workspace-one", "refreshToken": "synthetic-old-refresh",
    }]}


def candidate(subject="owner", expires=NOW + WEEK):
    return importer.candidate_from_auth("team-one", {"tokens": {
        "access_token": token(subject, expires), "refresh_token": "synthetic-new-refresh",
        "account_id": "workspace-one",
    }})


class ImportDeviceAuthTests(unittest.TestCase):
    def state(self):
        current = watch.credentials(document())[0]
        return {"version": 1, "accounts": {"team-one": {
            "identity": current["identity"], "status": "renewal_failed", "failures": 4,
            "nextPollAt": NOW + 3600,
        }}}

    def test_candidate_requires_complete_device_auth(self):
        with self.assertRaises(watch.WatchError):
            importer.candidate_from_auth("team-one", {"tokens": {"access_token": token("owner")}})

    def test_migrate_same_identity_and_fresh_usage(self):
        sample = {"at": NOW, "used": 12, "deadline": NOW + 500000,
                  "remaining": 500000, "allowed": True}
        creds, state = importer.migrate("team-one", document(), self.state(), candidate(), sample, NOW)
        row = creds["accounts"][0]
        self.assertEqual(row["refreshToken"], "synthetic-new-refresh")
        self.assertEqual(state["accounts"]["team-one"]["status"], "watching")
        self.assertEqual(state["accounts"]["team-one"]["sample"], sample)
        self.assertEqual(state["accounts"]["team-one"]["failures"], 0)

    def test_identity_change_and_pending_attempt_are_refused(self):
        with self.assertRaisesRegex(watch.WatchError, "identity_changed"):
            importer.migrate("team-one", document(), self.state(), candidate("other"),
                             {"at": NOW, "used": 1, "deadline": NOW + 1, "remaining": 1, "allowed": True}, NOW)
        state = self.state()
        state["accounts"]["team-one"]["attempt"] = {"at": NOW - 1, "result": "unknown"}
        with self.assertRaisesRegex(watch.WatchError, "pending_attempt_refused"):
            importer.migrate("team-one", document(), state, candidate(),
                             {"at": NOW, "used": 1, "deadline": NOW + 1, "remaining": 1, "allowed": True}, NOW)

    def test_provenance_marks_only_server_local_device_auth(self):
        identity = candidate()["identity"]
        provenance = importer.provenance_with_import(
            {"version": 1, "accounts": {}}, "team-one", identity, NOW
        )
        self.assertEqual(provenance["accounts"]["team-one"]["method"], "server_device_auth")
        self.assertEqual(provenance["accounts"]["team-one"]["identity"], identity)
        with self.assertRaisesRegex(watch.WatchError, "invalid_provenance"):
            importer.provenance_with_import(
                {"version": 1, "accounts": {"old": {"method": "cloned"}}},
                "team-one", identity, NOW
            )


if __name__ == "__main__":
    unittest.main()

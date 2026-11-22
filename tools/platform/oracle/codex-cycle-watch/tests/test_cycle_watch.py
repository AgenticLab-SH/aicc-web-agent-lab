import base64
import contextlib
import copy
from email.utils import formatdate
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
from cycle_policy import WEEK, WatchError, advance, begin_attempt, fail, observation
import cycle_watch as watch
import service

NOW = 1800000000


def sample(at=NOW, used=0, remaining=WEEK, allowed=True):
    return {"at": at, "used": used, "remaining": remaining, "deadline": at + remaining, "allowed": allowed}


def payload(at=NOW, remaining=WEEK, used=0):
    return {"rate_limit": {"allowed": True, "limit_reached": False,
                           "primary_window": {"used_percent": used, "limit_window_seconds": WEEK,
                                              "reset_after_seconds": remaining, "reset_at": at + remaining},
                           "secondary_window": None}}


def token(subject="test-user", expires=NOW + WEEK):
    encoded = base64.urlsafe_b64encode(json.dumps({"sub": subject, "exp": expires}).encode()).decode().rstrip("=")
    return "synthetic." + encoded + ".not-a-real-signature"


def account(alias="team-one", subject="test-user"):
    return watch.credentials({"version": 1, "accounts": [{"alias": alias, "accessToken": token(subject),
                                                          "chatgptAccountId": "fake-workspace"}]})[0]


class PolicyTests(unittest.TestCase):
    def test_first_full_sample_only_observes(self):
        state, decision = advance({}, sample())
        self.assertEqual(decision, "observe")
        self.assertEqual(state["status"], "confirming_dormant")

    def test_two_moving_full_samples_authorize(self):
        state, _ = advance({}, sample())
        _, decision = advance(state, sample(NOW + 120))
        self.assertEqual(decision, "send")

    def test_zero_percent_fixed_deadline_does_not_authorize(self):
        state, _ = advance({}, sample())
        _, decision = advance(state, sample(NOW + 120, remaining=WEEK - 120))
        self.assertEqual(decision, "observe")

    def test_old_sample_does_not_authorize(self):
        self.assertEqual(advance({"sample": sample()}, sample(NOW + 601))[1], "observe")

    def test_too_close_and_clock_regression_do_not_authorize(self):
        for delta in (0, 10, -120):
            self.assertEqual(advance({"sample": sample()}, sample(NOW + delta))[1], "observe")

    def test_exhausted_or_disallowed_never_send(self):
        for current in (sample(NOW + 120, used=100), sample(NOW + 120, allowed=False)):
            self.assertEqual(advance({"sample": sample()}, current)[1], "observe")

    def test_early_unscheduled_reset_requires_two_new_samples(self):
        active, _ = advance({}, sample(remaining=300000, used=65))
        reset, decision = advance(active, sample(NOW + 120))
        self.assertEqual(decision, "observe")
        self.assertEqual(advance(reset, sample(NOW + 240))[1], "send")

    def test_natural_reset_requires_two_new_samples(self):
        active, _ = advance({}, sample(remaining=30, used=65))
        reset, _ = advance(active, sample(NOW + 120))
        self.assertEqual(advance(reset, sample(NOW + 240))[1], "send")

    def test_short_window_not_weekly(self):
        data = payload()
        data["rate_limit"]["primary_window"]["limit_window_seconds"] = 18000
        with self.assertRaisesRegex(WatchError, "weekly_window_unknown"):
            observation(data, NOW)

    def test_weekly_secondary_is_used(self):
        data = payload()
        data["rate_limit"]["secondary_window"] = data["rate_limit"]["primary_window"]
        data["rate_limit"]["primary_window"] = {"limit_window_seconds": 18000, "used_percent": 0}
        self.assertEqual(observation(data, NOW), sample())

    def test_missing_null_nan_bool_out_of_range_fail_closed(self):
        for value in (None, float("nan"), True, -1, 101, "0"):
            with self.subTest(value=value), self.assertRaises(WatchError):
                observation(payload(used=value), NOW)

    def test_inconsistent_server_clock(self):
        with self.assertRaisesRegex(WatchError, "inconsistent_server_clock"):
            observation(payload(), NOW + 100)

    def test_unknown_attempt_never_replayed_while_dormant(self):
        state = begin_attempt({"sample": sample()}, NOW)
        for offset in (120, 240, 10000, WEEK * 2):
            state, decision = advance(state, sample(NOW + offset))
            self.assertEqual(decision, "observe")
            self.assertIn("attempt", state)

    def test_started_period_rearms_then_next_period_can_send(self):
        state = begin_attempt({"sample": sample()}, NOW)
        state, _ = advance(state, sample(NOW + 120, remaining=WEEK - 120))
        self.assertNotIn("attempt", state)
        self.assertEqual(state["status"], "cycle_started")
        state, _ = advance(state, sample(NOW + WEEK))
        self.assertEqual(advance(state, sample(NOW + WEEK + 120))[1], "send")

    def test_backoff_is_bounded(self):
        state = {}
        for _ in range(20):
            state = fail(state, NOW, "http_error")
        self.assertEqual(state["nextPollAt"], NOW + 3600)

    def test_daily_cap_and_expiry(self):
        state = {"sample": sample(), "attemptTimes": [NOW - 100, NOW - 200, NOW - 300, NOW - 400]}
        updated, decision = advance(state, sample(NOW + 120))
        self.assertEqual(decision, "observe")
        self.assertEqual(updated["status"], "daily_send_cap")
        state["attemptTimes"] = [NOW - 86400] * 4
        self.assertEqual(advance(state, sample(NOW + 120))[1], "send")


class FakeClient:
    def __init__(self, samples, error=None):
        self.samples = iter(samples)
        self.error = error
        self.sends = 0
        self.reads = 0

    def usage(self, _):
        self.reads += 1
        value = next(self.samples)
        if isinstance(value, Exception):
            raise value
        return value

    def hello(self, _):
        self.sends += 1
        if self.error:
            raise self.error


class ExecutionTests(unittest.TestCase):
    def state(self):
        return {"version": 1, "accounts": {"team-one": {"identity": account()["identity"], "sample": sample()}}}

    def run_once(self, client, state=None, persist=None, send=True, event_log=None):
        state = state or self.state()
        return watch.run_accounts([account()], state, client, persist or (lambda _: None),
                                  NOW + 120, send, event_log=event_log)

    def test_pending_is_saved_before_post(self):
        saved = []
        client = FakeClient([sample(NOW + 120), sample(NOW + 121)])
        original = client.hello
        def hello(acct):
            self.assertEqual(saved[-1]["accounts"]["team-one"]["attempt"]["result"], "unknown")
            original(acct)
        client.hello = hello
        result = self.run_once(client, persist=lambda state: saved.append(copy.deepcopy(state)))
        self.assertEqual(client.sends, 1)
        self.assertEqual(result["accounts"]["team-one"]["attempt"]["result"], "completed")

    def test_failed_persistence_sends_nothing(self):
        client = FakeClient([sample(NOW + 120), sample(NOW + 121)])
        with self.assertRaises(OSError):
            self.run_once(client, persist=lambda _: (_ for _ in ()).throw(OSError("fixture")))
        self.assertEqual(client.sends, 0)

    def test_ambiguous_send_is_durable_and_not_retried(self):
        client = FakeClient([sample(NOW + 120), sample(NOW + 121)], WatchError("network_error"))
        result = self.run_once(client)
        later = FakeClient([sample(NOW + 240)])
        watch.run_accounts([account()], result, later, lambda _: None, NOW + 240, True)
        self.assertEqual(client.sends, 1)
        self.assertEqual(later.sends, 0)
        self.assertIn("attempt", result["accounts"]["team-one"])

    def test_crash_after_success_before_save_does_not_replay(self):
        durable = []
        client = FakeClient([sample(NOW + 120), sample(NOW + 121)])
        def save(value):
            if durable:
                raise OSError("crash after post")
            durable.append(copy.deepcopy(value))
        with self.assertRaises(OSError):
            self.run_once(client, persist=save)
        after_restart = FakeClient([sample(NOW + 240)])
        watch.run_accounts([account()], durable[0], after_restart, lambda _: None, NOW + 240, True)
        self.assertEqual(after_restart.sends, 0)

    def test_immediate_preflight_catches_real_user_use(self):
        client = FakeClient([sample(NOW + 120), sample(NOW + 121, used=1, remaining=WEEK - 1)])
        self.run_once(client)
        self.assertEqual(client.sends, 0)

    def test_read_only_never_sends(self):
        client = FakeClient([sample(NOW + 120)])
        self.run_once(client, send=False)
        self.assertEqual(client.sends, 0)
        self.assertEqual(client.reads, 1)

    def test_reset_success_logs_detected_attempted_and_succeeded(self):
        events = []
        client = FakeClient([sample(NOW + 120), sample(NOW + 121)])
        self.run_once(client, event_log=events.append)
        self.assertEqual([event["outcome"] for event in events],
                         ["detected", "attempted", "succeeded"])
        self.assertTrue(all(event["type"] == "reset_initialization" for event in events))
        self.assertNotIn("accessToken", json.dumps(events))

    def test_reset_failure_logs_detected_attempted_and_failed(self):
        events = []
        client = FakeClient([sample(NOW + 120), sample(NOW + 121)], WatchError("network_error"))
        self.run_once(client, event_log=events.append)
        self.assertEqual([event["outcome"] for event in events],
                         ["detected", "attempted", "failed"])
        self.assertEqual(events[-1]["reason"], "network_error")

    def test_read_only_reset_logs_skip_without_send(self):
        events = []
        client = FakeClient([sample(NOW + 120)])
        self.run_once(client, send=False, event_log=events.append)
        self.assertEqual([event["outcome"] for event in events], ["detected", "skipped"])
        self.assertEqual(events[-1]["reason"], "send_disabled")
        self.assertEqual(client.sends, 0)

    def test_expired_credential_performs_no_network(self):
        acct = account()
        acct["expires"] = NOW
        client = FakeClient([])
        result = watch.run_accounts([acct], self.state(), client, lambda _: None, NOW + 120, True)
        self.assertEqual(client.reads, 0)
        self.assertEqual(result["accounts"]["team-one"]["status"], "credential_expired")

    def test_auth_error_not_zero_usage(self):
        result = self.run_once(FakeClient([WatchError("unauthorized")]))
        self.assertEqual(result["accounts"]["team-one"]["status"], "unauthorized")

    def test_identity_swap_is_refused(self):
        state = self.state()
        state["accounts"]["team-one"]["identity"] = "different"
        with self.assertRaisesRegex(WatchError, "identity_changed"):
            self.run_once(FakeClient([]), state=state)

    def test_poll_backoff_skips_network(self):
        state = self.state()
        state["accounts"]["team-one"]["nextPollAt"] = NOW + 300
        client = FakeClient([])
        self.run_once(client, state)
        self.assertEqual(client.reads, 0)


class SecurityAndTransportTests(unittest.TestCase):
    def test_refresh_token_optional_but_broad_store_is_rejected(self):
        raw = {k: v for k, v in account().items() if k in ("alias", "accessToken", "chatgptAccountId")}
        raw["refreshToken"] = "synthetic-refresh-fixture"
        self.assertEqual(watch.credentials({"version": 1, "accounts": [raw]})[0]["refreshToken"], raw["refreshToken"])
        raw["desktopAuth"] = {}
        with self.assertRaises(WatchError):
            watch.credentials({"version": 1, "accounts": [raw]})

    def test_same_workspace_different_users_allowed_duplicate_users_refused(self):
        rows = [{k: v for k, v in account(alias, subject).items() if k in ("alias", "accessToken", "chatgptAccountId")}
                for alias, subject in (("team-one", "one"), ("team-two", "two"))]
        self.assertEqual(len(watch.credentials({"version": 1, "accounts": rows})), 2)
        rows[1]["accessToken"] = rows[0]["accessToken"]
        with self.assertRaisesRegex(WatchError, "duplicate_account"):
            watch.credentials({"version": 1, "accounts": rows})

    def test_summary_does_not_export_identity_or_tokens(self):
        state = {"accounts": {"team-one": dict(account(), sample=sample(), status="watching")}}
        output = json.dumps(watch.summary(state))
        for secret in (account()["identity"], account()["accessToken"], "fake-workspace", "test-user"):
            self.assertNotIn(secret, output)

    def test_redirect_is_refused(self):
        with self.assertRaises(WatchError):
            watch.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid/")

    def test_sse_requires_completed_not_just_http_success(self):
        client = watch.Client()
        for raw in (b'data: {"type":"response.created"}\n', b'data: [DONE]\n', b'invalid'):
            with patch.object(client, "request", return_value=(raw, None)), self.assertRaises(WatchError):
                client.hello(account())

    def test_sse_completed_and_fixed_minimal_prompt(self):
        client = watch.Client()
        raw = b'data: {"type":"response.completed","response":{"status":"completed"}}\n'
        with patch.object(client, "request", return_value=(raw, None)) as request:
            client.hello(account())
        body = json.loads(request.call_args.args[2])
        self.assertEqual(body["model"], "gpt-5.6-luna")
        self.assertEqual(body["instructions"], "Return 1.")
        self.assertEqual(body["input"][0]["content"][0]["text"], "1")
        self.assertEqual(body["reasoning"], {"effort": "none"})
        self.assertEqual(body["max_output_tokens"], 16)
        self.assertFalse(body["store"])
        self.assertNotIn("tools", body)
        self.assertNotIn("previous_response_id", body)
        self.assertEqual(request.call_args.args[1], watch.RESPONSE_URL)

    def test_usage_requires_fresh_server_date(self):
        client = watch.Client()
        with patch.object(client, "request", return_value=(json.dumps(payload()).encode(), formatdate(NOW, usegmt=True))):
            with self.assertRaises(WatchError):
                client.usage(account())
            with patch.object(watch.time, "time", return_value=NOW):
                self.assertEqual(client.usage(account()), sample())

    def test_http_response_size_is_bounded(self):
        client = watch.Client()
        class Response:
            headers = {}
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read1(self, _):
                return b"x" * 8192
        with patch.object(client.opener, "open", return_value=Response()), self.assertRaisesRegex(WatchError, "response_too_large"):
            client.request(account(), watch.USAGE_URL)

    def test_corrupt_pending_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "state.json").touch()
            for pending in ({"result": "unknown"}, {"at": NOW, "result": "made-up"}, "bad"):
                document = {"version": 1, "accounts": {"team-one": {"identity": account()["identity"], "status": "watching", "attempt": pending}}}
                with patch.object(watch, "read_json", return_value=document), self.assertRaises(WatchError):
                    watch.load_state(root)

    def test_state_extra_secret_field_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "state.json").touch()
            document = {"version": 1, "accounts": {"team-one": {"identity": account()["identity"], "status": "watching", "accessToken": "secret"}}}
            with patch.object(watch, "read_json", return_value=document), self.assertRaises(WatchError):
                watch.load_state(root)

    def test_root_must_be_exact_absolute_leaf(self):
        for value in ("/", "relative", "/demo/owner", "/demo/owner/aicc-codex-cycle-watch"):
            with self.assertRaises(WatchError):
                watch.validate_root(value)


class RenewalTests(unittest.TestCase):
    def enrolled(self):
        row = {"alias": "team-one", "accessToken": token(expires=NOW + 30),
               "chatgptAccountId": "fake-workspace", "refreshToken": "synthetic-old-refresh"}
        document = {"version": 1, "accounts": [row]}
        return document, watch.credentials(document)[0]

    def test_refresh_validates_identity_expiry_and_keeps_existing_grant_if_omitted(self):
        _, old = self.enrolled()
        client = watch.Client()
        with patch.object(client, "request", return_value=(json.dumps({"access_token": token()}).encode(), None)) as request:
            new = client.refresh(old, NOW)
        self.assertEqual(new["refreshToken"], old["refreshToken"])
        self.assertEqual(request.call_args.args[1], watch.TOKEN_URL)
        self.assertIn(b"grant_type=refresh_token", request.call_args.args[2])
        for invalid in ({"access_token": token("other")}, {"access_token": token(expires=NOW)},
                        {"access_token": token(), "refresh_token": ""}, {}, []):
            with patch.object(client, "request", return_value=(json.dumps(invalid).encode(), None)), self.assertRaises(WatchError):
                client.refresh(old, NOW)

    def test_rotated_credential_saved_before_usage_and_not_state(self):
        document, old = self.enrolled()
        client = FakeClient([sample()])
        replacement = dict(account(), refreshToken="synthetic-rotated-refresh")
        client.refresh = lambda *_: replacement
        saved = []
        renew = watch.renewer(document, client, lambda value: saved.append(copy.deepcopy(value)))
        original_usage = client.usage
        def usage(acct):
            self.assertEqual(saved[-1]["accounts"][0]["refreshToken"], replacement["refreshToken"])
            self.assertEqual(acct["accessToken"], replacement["accessToken"])
            return original_usage(acct)
        client.usage = usage
        state = watch.run_accounts([old], {"version": 1, "accounts": {}}, client, lambda _: None, NOW, False, renew)
        self.assertNotIn("refreshToken", json.dumps(state))
        self.assertEqual(client.reads, 1)

    def test_failed_save_aborts_before_usage_and_preserves_inmemory_old(self):
        document, old = self.enrolled()
        original = copy.deepcopy(document)
        client = FakeClient([])
        client.refresh = lambda *_: dict(account(), refreshToken="synthetic-new-refresh")
        def broken(_):
            raise OSError("fixture")
        renew = watch.renewer(document, client, broken)
        with self.assertRaises(OSError):
            watch.run_accounts([old], {"version": 1, "accounts": {}}, client, lambda _: None, NOW, True, renew)
        self.assertEqual(document, original)
        self.assertEqual(client.reads, 0)
        self.assertEqual(client.sends, 0)

    def test_refresh_failure_stops_usage_and_backs_off(self):
        document, old = self.enrolled()
        client = FakeClient([])
        def broken(*_):
            raise WatchError("unauthorized")
        client.refresh = broken
        state = watch.run_accounts([old], {"version": 1, "accounts": {}}, client, lambda _: None, NOW, True,
                                   watch.renewer(document, client, lambda _: None))
        self.assertEqual(state["accounts"]["team-one"]["status"], "renewal_failed")
        self.assertGreater(state["accounts"]["team-one"]["nextPollAt"], NOW)
        self.assertEqual(client.reads, 0)

    def test_fresh_credential_does_not_refresh(self):
        _, old = self.enrolled()
        old.update(account())
        client = FakeClient([sample()])
        def unexpected(*_):
            self.fail("must not refresh a fresh credential")
        watch.run_accounts([old], {"version": 1, "accounts": {}}, client, lambda _: None, NOW, False, unexpected)

    def test_token_request_has_no_chatgpt_bearer_header(self):
        _, old = self.enrolled()
        client = watch.Client()
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read1(self, _): return b""
        with patch.object(client.opener, "open", return_value=Response()) as opened:
            client.request(old, watch.TOKEN_URL, b"synthetic")
        headers = opened.call_args.args[0].headers
        self.assertNotIn("Authorization", headers)
        self.assertNotIn("Chatgpt-account-id", headers)
        with self.assertRaises(WatchError):
            client.request(old, "https://example.invalid/")


class ServiceTests(unittest.TestCase):
    def test_timer_120_seconds_and_no_shell_or_auth_in_unit(self):
        rendered = service.units(PurePosixPath("/demo/owner/aicc-codex-cycle-watch"), "/usr/bin/python3")
        self.assertIn(b"OnUnitInactiveSec=120s", rendered[service.UNIT + ".timer"])
        unit = rendered[service.UNIT + ".service"]
        self.assertIn(b"--send", unit)
        self.assertIn(b"UMask=0077", unit)
        self.assertNotIn(b"Bearer", unit)
        self.assertNotIn(b"refresh", unit)

    def test_unit_injection_refused(self):
        with self.assertRaises(WatchError):
            service.units(PurePosixPath("/demo/owner/aicc-codex-cycle-watch"), "/usr/bin/python3\nExecStart=bad")

    def test_plan_is_read_only_and_content_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = PurePosixPath("/demo/owner/aicc-codex-cycle-watch")
            directory = Path(temp) / "units"
            plan, _, _ = service.build_plan(root, "/usr/bin/python3", directory, SOURCE)
            self.assertFalse(directory.exists())
            self.assertEqual(len(plan["confirmation"]), 64)

    def test_stale_plan_refused_before_auth_read_or_systemctl(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(service, "read_json") as reader, patch.object(service, "systemctl") as ctl:
                with self.assertRaises(WatchError):
                    service.install(PurePosixPath("/demo/owner/aicc-codex-cycle-watch"), "/usr/bin/python3", Path(temp) / "units", SOURCE, "bad")
                reader.assert_not_called()
                ctl.assert_not_called()

    def test_rollback_only_touches_named_units_and_preserves_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root, directory = Path(temp), Path(temp) / "units"
            directory.mkdir()
            rendered = service.units(PurePosixPath("/demo/owner/aicc-codex-cycle-watch"), "/usr/bin/python3")
            for name, content in rendered.items():
                (directory / name).write_bytes(content)
            (directory / "unrelated.service").write_text("preserve")
            (root / "credentials.json").write_text("preserve")
            (root / "state.json").write_text("preserve")
            receipt = {"status": "installed", "units": {name: service.digest(value) for name, value in rendered.items()}}
            with patch.object(service, "check_receipt", return_value=receipt), patch.object(service, "locked", return_value=contextlib.nullcontext()), patch.object(service, "atomic_json") as save, patch.object(service, "systemctl") as ctl:
                result = service.stop_or_rollback(root, directory, True)
            self.assertEqual(result["status"], "rolled_back")
            self.assertTrue((directory / "unrelated.service").exists())
            self.assertTrue((root / "credentials.json").exists())
            self.assertTrue((root / "state.json").exists())
            self.assertEqual(save.call_args.args[1]["status"], "rolled_back")

    def test_help_does_not_require_auth_or_platform(self):
        for program in ("cycle_watch.py", "service.py"):
            result = subprocess.run([sys.executable, "-B", str(SOURCE / program), "--help"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)

    def test_prepared_partial_install_can_rollback_without_units(self):
        with tempfile.TemporaryDirectory() as temp:
            root, directory = Path(temp), Path(temp) / "units"
            directory.mkdir()
            receipt = {"status": "prepared", "units": {service.UNIT + ".timer": "unused", service.UNIT + ".service": "unused"}}
            with patch.object(service, "check_receipt", return_value=receipt), patch.object(service, "locked", return_value=contextlib.nullcontext()), patch.object(service, "atomic_json"), patch.object(service, "systemctl") as ctl:
                result = service.stop_or_rollback(root, directory, True)
            self.assertEqual(result["status"], "rolled_back")
            ctl.assert_called_once_with("daemon-reload")

    def test_watcher_dry_run_creates_no_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "aicc-codex-cycle-watch"
            result = subprocess.run([sys.executable, "-B", str(SOURCE / "cycle_watch.py"), "run", "--root", str(root), "--send", "--dry-run"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertFalse(root.exists())
            self.assertFalse(json.loads(result.stdout)["mutation"])


@unittest.skipUnless(os.name == "posix", "Linux filesystem/lock gates must run on the target; Windows is not POSIX evidence")
class LinuxStorageTests(unittest.TestCase):
    def test_private_event_log_appends_complete_owner_only_records(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            os.chmod(root, 0o700)
            event_file = root / "events.jsonl"
            watch.append_event(event_file, {"version": 1, "outcome": "succeeded"})
            watch.append_event(event_file, {"version": 1, "outcome": "failed", "reason": "network_error"})
            self.assertEqual(stat.S_IMODE(event_file.stat().st_mode), 0o600)
            rows = [json.loads(line) for line in event_file.read_text().splitlines()]
            self.assertEqual([row["outcome"] for row in rows], ["succeeded", "failed"])

    def test_private_storage_atomic_write_and_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            os.chmod(root, 0o700)
            watch.atomic_json(root / "state.json", {"version": 1, "accounts": {}})
            self.assertEqual(watch.read_json(root / "state.json")["version"], 1)
            with watch.locked(root):
                with self.assertRaisesRegex(WatchError, "already_running"):
                    with watch.locked(root):
                        pass

    def test_world_readable_and_symlinks_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "secret.json"
            target.write_text("{}")
            os.chmod(target, 0o644)
            with self.assertRaises(WatchError):
                watch.read_json(target)
            os.chmod(target, 0o600)
            link = root / "link.json"
            link.symlink_to(target)
            with self.assertRaises(WatchError):
                watch.read_json(link)


if __name__ == "__main__":
    unittest.main()

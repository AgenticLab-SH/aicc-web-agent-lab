import io
import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import hub_cycle_watch as hub
from cycle_policy import MONTH, WEEK, WatchError


def account(selector, identity, at, used=0, deadline=None, plan="team", allowed=True, window="weekly", active=False):
    window_seconds = MONTH if window == "monthly" else WEEK
    if deadline is None:
        deadline = at + window_seconds
    return {
        "id": "private-" + identity[:8],
        "identity": identity,
        "selector": selector,
        "active": active,
        "plan": plan,
        "window": window,
        "sample": {
            "at": float(at),
            "used": float(used),
            "deadline": float(deadline),
            "remaining": max(0.0, float(deadline) - float(at)),
            "allowed": allowed,
            "windowSeconds": window_seconds,
        },
    }


class FakeClient:
    def __init__(self, refreshes, send_error=None):
        self.refreshes = list(refreshes)
        self.send_error = send_error
        self.sent = []

    def refresh_accounts(self):
        if not self.refreshes:
            raise AssertionError("unexpected refresh")
        return self.refreshes.pop(0)

    def start_cycle(self, row):
        self.sent.append(row["selector"])
        if self.send_error:
            raise self.send_error
        return True


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = json.dumps(payload).encode()
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit=None):
        return self.payload


class HubCycleWatchTests(unittest.TestCase):
    def query_commands(self, messages, pending=None):
        root = self.root()
        state = {"quotaQuery": {"cursor": "1793767900.000000", "pending": pending or {}}}
        config = {"dmChannelId": "D123456789", "recipientUserId": "U123456789"}
        client = mock.Mock()
        client.quota_text.return_value = "계정 한도표"
        calls = []

        def api(method, payload, token, opener=None):
            calls.append((method, payload))
            if method == "conversations.history":
                return {"messages": messages}
            return {"ts": "1793768000.000001"}

        with mock.patch.object(hub, "slack_api", side_effect=api):
            hub.poll_quota_queries(root, state, client, config, "fixture", 1793768000)
        return state, client, calls

    def test_menu_choice_parser_is_exact_and_read_only(self):
        self.assertEqual(hub.parse_slack_choice("선택 1"), ("quota", None))
        self.assertEqual(hub.parse_slack_choice("선택 2"), ("credits", None))
        self.assertEqual(hub.parse_slack_choice("선택 3"), ("accounts", None))
        self.assertEqual(hub.parse_slack_choice("선택 4"), ("watch", None))
        self.assertEqual(hub.parse_slack_choice("선택 5"), ("controls", None))
        self.assertEqual(hub.parse_slack_choice("계정 16"), ("account", 16))
        self.assertEqual(hub.parse_slack_choice("초기화권 1"), ("credit", 1))
        for value in ("선택 6", "계정 0", "초기화권 17", "초기화권 1 --consume", "중지", "확정 1"):
            self.assertIsNone(hub.parse_slack_choice(value))

    def test_connector_attributed_owner_message_is_recognized_but_unrelated_text_is_not(self):
        attributed = "메뉴\n*다음을 사용하여 보냄* <@U0BQK45127N|ChatGPT>"
        self.assertEqual(hub.parse_slack_choice(attributed), ("help", None))
        self.assertEqual(hub.parse_slack_choice(
            "선택 2\n*다음을 사용하여 보냄* <@U0BQK45127N|ChatGPT>"), ("credits", None))
        self.assertEqual(hub.parse_slack_choice("메뉴\n*다음을 사용하여 보냄* <@invalid|UnknownApp>"), ("help", None))
        self.assertEqual(hub.parse_slack_choice("메뉴\n다른 요청 시작"), ("help", None))
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000003", "user": "U123456789", "text": attributed},
            {"ts": "1793767950.000004", "user": "U000000000", "text": attributed}])
        self.assertIn("AICC 기능 선택", calls[1][1]["text"])
        self.assertIn("1793767950.000003", state["quotaQuery"]["pending"])
        self.assertNotIn("1793767950.000004", state["quotaQuery"]["pending"])
        self.assertNotIn("ChatGPT", json.dumps(state))
        client.quota_text.assert_not_called()

    def test_connector_same_line_footer_is_read_only_choice(self):
        self.assertEqual(hub.parse_slack_choice(
            "메뉴 *다음을 사용하여 보냄* <@U012345678>"), ("help", None))
        self.assertEqual(hub.parse_slack_choice(
            "선택 1 *앱 출처 안내*"), ("quota", None))
        self.assertEqual(hub.parse_slack_choice(
            "계정 12 *앱 출처 안내*"), ("account", 12))
        self.assertIsNone(hub.parse_slack_choice("메뉴얼 요청"))
        self.assertIsNone(hub.parse_slack_choice("선택 7 *앱 출처 안내*"))

    def test_owner_attributed_bot_subtype_allowed_other_subtypes_ignored(self):
        attributed = "메뉴\n*다음을 사용하여 보냄* <@U0BQK45127N|ChatGPT>"
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000005", "user": "U123456789",
             "text": attributed, "subtype": "bot_message"},
            {"ts": "1793767950.000006", "user": "U123456789",
             "text": "초기화권", "subtype": "file_share"},
            {"ts": "1793767950.000007", "user": "U000000000",
             "text": attributed, "subtype": "bot_message"}])
        pending = state["quotaQuery"]["pending"]
        self.assertIn("1793767950.000005", pending)
        self.assertNotIn("1793767950.000006", pending)
        self.assertNotIn("1793767950.000007", pending)
        self.assertIn("AICC 기능 선택", calls[1][1]["text"])
        self.assertEqual(state["quotaQuery"]["lastOwnerObservation"]["subtype"], "file_share")
        self.assertFalse(state["quotaQuery"]["lastOwnerObservation"]["accepted"])
        self.assertNotIn("ChatGPT", json.dumps(state))
        client.quota_text.assert_not_called()

    def test_menu_choice_returns_exact_result_and_dedupes_batch(self):
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000001", "user": "U123456789", "text": "선택 2"},
            {"ts": "1793767950.000002", "user": "U123456789", "text": "초기화권"}])
        client.quota_text.assert_called_once_with(credits_only=True)
        self.assertEqual(len(calls), 2)
        self.assertEqual(state["quotaQuery"]["pending"]["1793767950.000001"]["kind"], "credits")
        self.assertEqual(state["quotaQuery"]["pending"]["1793767950.000002"]["kind"], "credits")
        self.assertNotIn("선택 2", json.dumps(state))

    def test_numbered_details_and_owner_binding(self):
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000001", "user": "U123456789", "text": "계정 4"},
            {"ts": "1793767950.000002", "user": "U000000000", "text": "초기화권 9"}])
        client.quota_text.assert_called_once_with(account_index=4)
        self.assertEqual(state["quotaQuery"]["pending"]["1793767950.000001"]["accountIndex"], 4)
        self.assertNotIn("1793767950.000002", state["quotaQuery"]["pending"])
        self.assertEqual(len(calls), 2)

    def test_watch_and_controls_use_no_quota_or_model(self):
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000001", "user": "U123456789", "text": "선택 4"},
            {"ts": "1793767950.000002", "user": "U123456789", "text": "선택 5"}])
        client.quota_text.assert_not_called()
        self.assertIn("감시 상태", calls[1][1]["text"])
        self.assertIn("미리보기", calls[1][1]["text"])
        self.assertIn("Slack", calls[1][1]["text"])

    def test_credit_only_format_does_not_repeat_quota_grid(self):
        at = 1793767981
        report = hub.format_quota_report(
            [{"id": "one", "quota": {"shortPercent": 19}}],
            {"one": "p1"}, at,
            {"one": {"available": 1, "expiresAt": [
                datetime.datetime.fromtimestamp(at + 3600, datetime.timezone.utc).isoformat()]}},
            credits_only=True, account_number=3)
        self.assertIn("3. *p1*", report)
        self.assertIn("초기화권 1장", report)
        self.assertNotIn(chr(96)*3, report)


    def test_help_query_never_refreshes_quota_or_runs_model(self):
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000001", "user": "U123456789", "text": " HELP "}])
        client.quota_text.assert_not_called()
        self.assertEqual(calls[1][0], "chat.postMessage")
        self.assertIn("도움말", calls[1][1]["text"])
        self.assertIn("SKCT", calls[1][1]["text"])
        self.assertEqual(state["quotaQuery"]["pending"]["1793767950.000001"]["kind"], "help")
        self.assertNotIn("HELP", json.dumps(state))

    def test_mixed_help_and_quota_get_one_reply_one_refresh(self):
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000001", "user": "U123456789", "text": "메뉴"},
            {"ts": "1793767950.000002", "user": "U123456789", "text": "ocx   한도"}])
        client.quota_text.assert_called_once()
        self.assertEqual(len(calls), 2)
        self.assertIn("계정 한도표", calls[1][1]["text"])
        self.assertTrue(all(row.get("sentAt") for row in state["quotaQuery"]["pending"].values()))

    def test_unknown_and_other_user_commands_are_ignored(self):
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000001", "user": "U000000000", "text": "help"},
            {"ts": "1793767950.000002", "user": "U123456789", "text": "개발 시작"}])
        self.assertEqual(len(calls), 1)
        client.quota_text.assert_not_called()
        self.assertFalse(state["quotaQuery"]["pending"])

    def test_legacy_pending_quota_keeps_semantics_and_help_receipts_dedupe(self):
        pending = {"1793767950.000001": {"attempts": 0},
                   "1793767950.000002": {"attempts": 0, "kind": "help", "sentAt": 1793767990}}
        state, client, calls = self.query_commands([
            {"ts": "1793767950.000002", "user": "U123456789", "text": "help"}], pending)
        client.quota_text.assert_called_once()
        self.assertNotIn("AICC 사용 안내", calls[1][1]["text"])
        self.assertIn("계정 한도표", calls[1][1]["text"])

    def test_quota_report_aligns_windows_preserves_zero_and_monthly(self):
        rows = [{"id": "one", "accountName": "개인 계정", "active": True,
                 "quota": {"shortPercent": 0, "shortResetAt": 1793780452,
                           "weeklyPercent": 98, "weeklyResetAt": 1794044586,
                           "monthlyPercent": 0, "monthlyResetAt": 1795976490}}]
        report = hub.format_quota_report(rows, {"one": "p1"}, 1793767981)
        self.assertIn("11/04 13:53 KST", report)
        self.assertIn("허브 선택", report)
        self.assertEqual(report.count("```"), 2)
        table = report.split("```")[1].strip().splitlines()
        self.assertEqual(len(table), 4)
        self.assertIn("0%", table[1])
        self.assertIn("100%", table[1])
        self.assertIn("98%", table[2])
        self.assertIn("2%", table[2])
        self.assertTrue(table[3].startswith("월간"))
        self.assertIn("11/04 17:20", table[1])
        self.assertIn("선택 ≠ 현재 실행", report)

    def test_quota_report_unknown_identity_and_markup_stay_safe(self):
        rows = [{"id": "one", "accountName": "evil```\n<@everyone>", "needsReauth": True,
                 "quota": {"shortPercent": -1, "weeklyPercent": True,
                           "weeklyResetAt": 1e100}},
                {"id": "one", "accountName": "duplicate"},
                {"id": "private-secret-id", "accountName": "not registered"},
                {"id": "two", "email": "private@example.com", "paused": True}]
        report = hub.format_quota_report(rows, {"one": "p1", "two": "p2"}, 1793767981)
        self.assertEqual(report.count("```"), 4)
        self.assertIn("미확인", report)
        self.assertIn("재로그인 필요", report)
        self.assertIn("일시 중지", report)
        for secret in ("private@example.com", "private-secret-id", "duplicate", "<@everyone>"):
            self.assertNotIn(secret, report)

    def test_quota_report_countdown_and_individual_credit_expiry(self):
        observed_at = 1793767981
        expires = datetime.datetime.fromtimestamp(
            observed_at + 26 * 3600, datetime.timezone.utc).isoformat()
        rows = [{"id": "one", "quota": {
            "shortPercent": 81, "shortResetAt": observed_at + 90 * 60,
            "weeklyPercent": 45, "weeklyResetAt": observed_at + 48 * 3600,
            "resetCredits": 3}}]
        inventories = {"one": {"available": 3, "expiresAt": [
            expires, "2020-01-01T00:00:00+00:00", "invalid-date"]}}
        report = hub.format_quota_report(rows, {"one": "p1"}, observed_at, inventories)
        self.assertIn("1시간 30분", report)
        self.assertIn("48시간 0분", report)
        self.assertIn("초기화권 3장", report)
        self.assertIn("1번 · 만료", report)
        self.assertIn("1일 2시간", report)
        self.assertIn("2번 · 만료", report)
        self.assertIn("기한 경과 · 재조회 필요", report)
        self.assertIn("3번 · 만료 미확인 · 남은 미확인", report)
        self.assertNotIn("20%", report)

    def test_quota_report_credit_lookup_unavailable_does_not_become_zero(self):
        rows = [{"id": "one", "quota": {"shortPercent": 5,
                                       "shortResetAt": 1793767981 + 3600,
                                       "resetCredits": 2}}]
        report = hub.format_quota_report(rows, {"one": "p1"}, 1793767981,
                                         {"one": {"unavailable": True}})
        self.assertIn("5%", report)
        self.assertIn("초기화권 2장 · 개별 만료 미확인", report)

    def test_quota_text_uses_one_refresh_and_read_only_credit_inventory(self):
        now = 1793767981
        expires = datetime.datetime.fromtimestamp(
            now + 26 * 3600, datetime.timezone.utc).isoformat()
        commands = []

        def cli(command, timeout=35):
            commands.append((command, timeout))
            if command == [hub.DEFAULT_OCX, "account", "refresh", "openai", "--json"]:
                return {"accounts": [{"id": "one", "accountName": "local",
                          "quota": {"shortPercent": 0, "shortResetAt": now + 5400,
                                    "weeklyPercent": 35, "resetCredits": 1}}]}
            if command == [hub.DEFAULT_OCX, "account", "reset-credits", "one", "--json"]:
                return {"available_count": 1, "credits": [
                    {"granted_at": "2026-11-01T00:00:00Z", "expires_at": expires}]}
            raise AssertionError("unexpected CLI command")

        with mock.patch.object(hub, "run_json", side_effect=cli), \
                mock.patch.object(hub, "selector_map", return_value={"one": "p1"}), \
                mock.patch.object(hub, "read_json", return_value={"codexAccounts": [
                    {"id": "one", "email": "owner@example.com"}]}):
            report = hub.HubClient(now=lambda: now).quota_text()
        self.assertIn("*owner*", report)
        self.assertIn("초기화권 1장 · 개별 만료", report)
        self.assertIn("1일 2시간", report)
        self.assertIn("1시간 30분", report)
        self.assertNotIn("@example.com", report)
        self.assertEqual(commands, [
            ([hub.DEFAULT_OCX, "account", "refresh", "openai", "--json"], 20),
            ([hub.DEFAULT_OCX, "account", "reset-credits", "one", "--json"], 8)])
        self.assertFalse(any("--consume" in command or "--yes" in command
                             for command, _ in commands))

    def test_quota_text_credit_lookup_failure_preserves_usage(self):
        now = 1793767981
        def cli(command, timeout=35):
            if "reset-credits" in command:
                raise WatchError("hub_error")
            return {"accounts": [{"id": "one", "quota": {
                "shortPercent": 60, "shortResetAt": now + 3600,
                "resetCredits": 2}}]}
        with mock.patch.object(hub, "run_json", side_effect=cli), \
                mock.patch.object(hub, "selector_map", return_value={"one": "p1"}), \
                mock.patch.object(hub, "read_json", return_value={"codexAccounts": []}):
            report = hub.HubClient(now=lambda: now).quota_text()
        self.assertIn("60%", report)
        self.assertIn("1시간 0분", report)
        self.assertIn("초기화권 2장 · 개별 만료 미확인", report)

    def root(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name) / hub.ROOT_NAME
        root.mkdir(mode=0o700)
        return root

    def test_two_dormant_observations_send_exactly_once_and_then_arm_started_cycle(self):
        root = self.root()
        identity = "a" * 64
        first = account("p1", identity, 1000)
        second = account("p1", identity, 1120)
        fresh = account("p1", identity, 1121)
        started = account("p1", identity, 1240, used=0, deadline=fresh["sample"]["deadline"])
        client = FakeClient([[first], [second], [fresh], [started]])
        state = hub.initial_state()

        with mock.patch.object(hub, "ntp_synchronized", return_value=True):
            hub.run_pass(root, state, client, 1000, True, False)
            self.assertEqual(client.sent, [])
            self.assertEqual(state["accounts"]["p1"]["status"], "confirming_dormant")

            hub.run_pass(root, state, client, 1120, True, False)
            self.assertEqual(client.sent, ["p1"])
            self.assertEqual(state["accounts"]["p1"]["status"], "awaiting_window")
            self.assertTrue(state["accounts"]["p1"]["attempt"]["result"] == "completed")
            self.assertEqual(len(state["notifications"]), 1)

            hub.run_pass(root, state, client, 1240, True, False)
            self.assertEqual(client.sent, ["p1"])
            self.assertEqual(state["accounts"]["p1"]["status"], "cycle_started")
            self.assertNotIn("attempt", state["accounts"]["p1"])

    def test_fresh_usage_change_suppresses_send(self):
        root = self.root()
        identity = "b" * 64
        first = account("p2", identity, 1000)
        second = account("p2", identity, 1120)
        changed = account("p2", identity, 1121, used=1, deadline=1121 + WEEK - 300)
        client = FakeClient([[first], [second], [changed]])
        state = hub.initial_state()

        with mock.patch.object(hub, "ntp_synchronized", return_value=True):
            hub.run_pass(root, state, client, 1000, True, False)
            hub.run_pass(root, state, client, 1120, True, False)

        self.assertEqual(client.sent, [])
        events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["outcome"], "suppressed")
        self.assertEqual(len(state["notifications"]), 1)
        notification = next(iter(state["notifications"].values()))
        self.assertIn("spent no model tokens", notification["message"])

    def test_ambiguous_send_is_not_retried(self):
        root = self.root()
        identity = "c" * 64
        first = account("p3", identity, 1000)
        second = account("p3", identity, 1120)
        fresh = account("p3", identity, 1121)
        still_dormant = account("p3", identity, 1240)
        client = FakeClient(
            [[first], [second], [fresh], [still_dormant]],
            send_error=WatchError("send_outcome_unknown"),
        )
        state = hub.initial_state()

        with mock.patch.object(hub, "ntp_synchronized", return_value=True):
            hub.run_pass(root, state, client, 1000, True, False)
            hub.run_pass(root, state, client, 1120, True, False)
            self.assertEqual(client.sent, ["p3"])
            self.assertEqual(state["accounts"]["p3"]["status"], "send_outcome_unknown")
            hub.run_pass(root, state, client, 1240, True, False)

        self.assertEqual(client.sent, ["p3"])
        self.assertIn("attempt", state["accounts"]["p3"])

    def test_identity_status_hashes_account_ids_and_preserves_only_safe_routing_state(self):
        client = hub.HubClient(now=lambda: 1000)
        payload = {
            "accounts": [
                {
                    "id": "team-one",
                    "plan": "team",
                    "active": True,
                    "paused": False,
                    "needsReauth": False,
                    "selectionExcludedReason": "plan_excluded",
                },
                {
                    "id": "plus-one",
                    "plan": "plus",
                    "active": False,
                    "paused": True,
                    "needsReauth": False,
                },
            ]
        }
        with mock.patch.object(hub, "run_json", return_value=payload), \
             mock.patch.object(hub, "selector_map", return_value={"team-one": "pteam", "plus-one": "pplus"}):
            rows = client.identity_status()
        self.assertEqual([row["selector"] for row in rows], ["pplus", "pteam"])
        team = next(row for row in rows if row["selector"] == "pteam")
        plus = next(row for row in rows if row["selector"] == "pplus")
        self.assertEqual(team["identityHash"], hub.account_identity("team-one"))
        self.assertTrue(team["active"])
        self.assertEqual(team["selectionExcludedReason"], "plan_excluded")
        self.assertEqual(plus["blockReason"], "paused")
        serialized = json.dumps(rows)
        self.assertNotIn("team-one", serialized)
        self.assertNotIn("plus-one", serialized)

    def test_free_monthly_quota_is_mapped_to_monthly_window(self):
        client = hub.HubClient(now=lambda: 1000)
        payload = {
            "accounts": [
                {"id": "free-one", "plan": "free",
                 "quota": {"monthlyPercent": 0, "monthlyResetAt": 1000 + MONTH}}
            ]
        }
        with mock.patch.object(hub, "run_json", return_value=payload), \
             mock.patch.object(hub, "selector_map", return_value={"free-one": "pfree"}):
            rows = client.refresh_accounts()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["window"], "monthly")
        self.assertEqual(rows[0]["sample"]["windowSeconds"], MONTH)

    def test_plan_exclusion_does_not_block_explicit_initializer(self):
        client = hub.HubClient(now=lambda: 1000)
        payload = {
            "accounts": [
                {
                    "id": "team-one",
                    "plan": "team",
                    "selectionExcludedReason": "plan_excluded",
                    "needsReauth": False,
                    "paused": False,
                    "quota": {"weeklyPercent": 0, "weeklyResetAt": 1000 + WEEK},
                }
            ]
        }
        with mock.patch.object(hub, "run_json", return_value=payload),              mock.patch.object(hub, "selector_map", return_value={"team-one": "pteam"}):
            rows = client.refresh_accounts()
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["sample"]["allowed"])
        self.assertEqual(rows[0]["selectionExcludedReason"], "plan_excluded")
        self.assertIsNone(rows[0]["blockReason"])

    def test_pause_preserves_normal_block_but_only_reauth_blocks_initializer(self):
        for key in ("paused", "needsReauth"):
            client = hub.HubClient(now=lambda: 1000)
            payload = {
                "accounts": [
                    {
                        "id": "team-one",
                        "plan": "team",
                        "paused": key == "paused",
                        "needsReauth": key == "needsReauth",
                        "quota": {"shortPercent": 0, "weeklyPercent": 0, "weeklyResetAt": 1000 + WEEK},
                    }
                ]
            }
            with self.subTest(key=key),                  mock.patch.object(hub, "run_json", return_value=payload),                  mock.patch.object(hub, "selector_map", return_value={"team-one": "pteam"}):
                rows = client.refresh_accounts()
                self.assertEqual(rows[0]["sample"]["allowed"], key == "paused")
                self.assertEqual(rows[0]["paused"], key == "paused")
                self.assertEqual(rows[0]["initializationBlockReason"], None if key == "paused" else "needs_reauth")
                self.assertEqual(rows[0]["blockReason"], "paused" if key == "paused" else "needs_reauth")

    def test_monthly_moving_full_window_initializes_once(self):
        root = self.root()
        identity = "e" * 64
        first = account("pfree", identity, 1000, plan="free", window="monthly")
        second = account("pfree", identity, 1120, plan="free", window="monthly")
        fresh = account("pfree", identity, 1121, plan="free", window="monthly")
        started = account(
            "pfree", identity, 1240, used=0, deadline=fresh["sample"]["deadline"],
            plan="free", window="monthly")
        client = FakeClient([[first], [second], [fresh], [started]])
        state = hub.initial_state()

        with mock.patch.object(hub, "ntp_synchronized", return_value=True):
            hub.run_pass(root, state, client, 1000, True, False)
            hub.run_pass(root, state, client, 1120, True, False)
            self.assertEqual(client.sent, ["pfree"])
            self.assertEqual(state["accounts"]["pfree"]["window"], "monthly")
            notification = next(iter(state["notifications"].values()))
            self.assertIn("dormant monthly window", notification["message"])
            hub.run_pass(root, state, client, 1240, True, False)

        self.assertEqual(client.sent, ["pfree"])
        self.assertEqual(state["accounts"]["pfree"]["status"], "cycle_started")

    def test_monthly_fixed_window_never_initializes(self):
        root = self.root()
        identity = "f" * 64
        deadline = 1000 + MONTH
        first = account("pfree", identity, 1000, deadline=deadline, plan="free", window="monthly")
        second = account("pfree", identity, 1120, deadline=deadline, plan="free", window="monthly")
        client = FakeClient([[first], [second]])
        state = hub.initial_state()

        with mock.patch.object(hub, "ntp_synchronized", return_value=True):
            hub.run_pass(root, state, client, 1000, True, False)
            hub.run_pass(root, state, client, 1120, True, False)

        self.assertEqual(client.sent, [])
        self.assertEqual(state["notifications"], {})

    def test_start_cycle_uses_exact_account_qualified_luna_and_bounded_payload(self):
        captured = {}

        def opener(request, timeout):
            captured["url"] = request.full_url
            captured["body"] = json.loads(request.data)
            captured["timeout"] = timeout
            return FakeResponse({"status": "completed"})

        client = hub.HubClient(opener=opener)
        row = account("pabc123", "d" * 64, 1000)
        client.start_cycle(row)
        body = captured["body"]
        self.assertEqual(captured["url"], hub.DATA_URL)
        self.assertEqual(body["model"], "pabc123/gpt-5.6-luna")
        self.assertEqual(body["input"][0]["content"][0]["text"], "1")
        self.assertEqual(body["reasoning"], {"effort": "none"})
        self.assertEqual(body["max_output_tokens"], 16)
        self.assertFalse(body["store"])
        self.assertFalse(body["stream"])
        self.assertNotIn("tools", body)

    def test_status_summary_exposes_hashed_identity_and_active_state_without_raw_account_id(self):
        root = self.root()
        identity = "9" * 64
        row = account("pobs", identity, 1000, active=True)
        state = hub.initial_state()
        client = FakeClient([[row]])

        with mock.patch.object(hub, "ntp_synchronized", return_value=True):
            hub.run_pass(root, state, client, 1000, False, False)

        summary = hub.status_summary(state)
        self.assertEqual(len(summary["accounts"]), 1)
        observed = summary["accounts"][0]
        self.assertEqual(observed["identityHash"], identity)
        self.assertTrue(observed["active"])
        self.assertNotIn("private-" + identity[:8], json.dumps(summary))

    def test_slack_delivery_is_retryable_without_model_retry(self):
        root = self.root()
        state = hub.initial_state()
        hub.queue_notification(state, "cycle:test:success", "ok", 1000)
        cfg = {
            "schemaVersion": 1,
            "transport": "aicc_slack_bot",
            "teamId": "T123456789",
            "recipientUserId": "U123456789",
            "botUserId": "U987654321",
            "botId": "B123456789",
        }
        calls = []

        def good_opener(request, timeout):
            calls.append(json.loads(request.data))
            return FakeResponse({"ok": True})

        changed = hub.deliver_notifications(root, state, cfg, "xoxb-" + "a" * 24, 1000, good_opener)
        self.assertTrue(changed)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["text"], "ok")
        self.assertIsNotNone(state["notifications"]["cycle:test:success"]["sentAt"])

    def test_unknown_upstream_clock_blocks_run(self):
        root = self.root()
        state = hub.initial_state()
        client = FakeClient([])
        with mock.patch.object(hub, "ntp_synchronized", return_value=False):
            with self.assertRaisesRegex(WatchError, "clock_unsynchronized"):
                hub.run_pass(root, state, client, 1000, True, False)


if __name__ == "__main__":
    unittest.main()

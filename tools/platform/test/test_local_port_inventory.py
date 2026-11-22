from __future__ import annotations

import importlib.util
import tempfile
import unittest
from unittest import mock
from pathlib import Path


TOOL = Path(__file__).resolve().parents[1] / "inspect" / "local_port_inventory.py"
SPEC = importlib.util.spec_from_file_location("local_port_inventory", TOOL)
assert SPEC and SPEC.loader
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class LocalPortInventoryTest(unittest.TestCase):
    def registry(self, text: str) -> Path:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        path = root / "ports.toml"
        path.write_text(text, encoding="utf-8")
        return path

    def test_lsof_fields_are_parsed(self) -> None:
        result = inventory.parse_lsof_fields("p12\ncnode\nn127.0.0.1:3000\np13\ncserver\nn*:8080\n")
        self.assertEqual(result[0], {"pid": 12, "process": "node", "address": "127.0.0.1", "port": 3000})
        self.assertEqual(result[1]["port"], 8080)

    def test_powershell_listener_json_is_parsed_and_redacted(self) -> None:
        output = (
            '[{"LocalAddress":"127.0.0.1","LocalPort":9225,"OwningProcess":42,'
            '"ProcessName":"chrome.exe","CommandLine":"chrome.exe --token=secret --port 9225"},'
            '{"LocalAddress":"::","LocalPort":8080,"OwningProcess":7,'
            '"ProcessName":"node.exe","CommandLine":"node.exe API_KEY=hidden"}]'
        )
        result = inventory.parse_powershell_listeners(output)
        self.assertEqual(result[0]["pid"], 42)
        self.assertEqual(result[0]["port"], 9225)
        self.assertEqual(result[0]["exposure"], "loopback")
        self.assertNotIn("secret", result[0]["command"])
        self.assertEqual(result[1]["exposure"], "non_loopback")
        self.assertNotIn("hidden", result[1]["command"])

    def test_current_listeners_dispatches_by_platform(self) -> None:
        with mock.patch.object(inventory.platform, "system", return_value="Windows"), mock.patch.object(
            inventory, "_windows_listeners", return_value=[{"port": 1}]
        ) as windows:
            self.assertEqual(inventory.current_listeners(), [{"port": 1}])
            windows.assert_called_once_with()
        with mock.patch.object(inventory.platform, "system", return_value="Darwin"), mock.patch.object(
            inventory, "_macos_listeners", return_value=[{"port": 2}]
        ) as macos:
            self.assertEqual(inventory.current_listeners(), [{"port": 2}])
            macos.assert_called_once_with()

    def test_registered_identity_match_and_conflict(self) -> None:
        path = self.registry(
            '[[services]]\nport=9225\nname="naver"\npurpose="draft"\nexpected_process_contains=["Chrome", "9225/UserData"]\n'
        )
        good = [{"pid": 1, "process": "Google Chrome", "address": "127.0.0.1", "port": 9225,
                 "command": "Chrome --user-data-dir=/profiles/9225/UserData", "exposure": "loopback"}]
        report = inventory.build_report(path, good)
        self.assertTrue(report["ok"])
        self.assertEqual(report["services"][0]["state"], "occupied_expected")
        bad = [{**good[0], "command": "Whale --remote-debugging-port=9225", "process": "Whale"}]
        report = inventory.build_report(path, bad)
        self.assertFalse(report["ok"])
        self.assertEqual(report["services"][0]["state"], "occupied_conflict")

    def test_unregistered_listener_is_observation(self) -> None:
        path = self.registry('[[services]]\nport=17841\nname="web-gpt"\npurpose="bridge"\n')
        listeners = [{"pid": 7, "process": "java", "address": "127.0.0.1", "port": 50909,
                      "command": "GradleDaemon", "exposure": "loopback"}]
        report = inventory.build_report(path, listeners)
        self.assertTrue(report["ok"])
        self.assertEqual(report["unregistered_current"][0]["port"], 50909)

    def test_secret_arguments_are_redacted(self) -> None:
        self.assertNotIn("secret-value", inventory.sanitize_command("tool --token secret-value --port 1"))
        self.assertNotIn("secret-value", inventory.sanitize_command("tool --token=secret-value --port 1"))
        self.assertNotIn("https://user:pass@example.test", inventory.sanitize_command("curl https://user:pass@example.test"))

    def test_host_name_is_portable(self) -> None:
        path = self.registry('[[services]]\nport=1\nname="one"\n')
        with mock.patch.object(inventory.platform, "node", return_value="portable-host"):
            self.assertEqual(inventory.build_report(path, [])['host'], "portable-host")


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "site_ops.py"
SPEC = importlib.util.spec_from_file_location("site_ops", SCRIPT)
assert SPEC and SPEC.loader
site_ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(site_ops)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SiteOpsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "guidance"
        self.project = self.root / "project"
        self.config.mkdir()
        self.project.mkdir()
        self.settings = {
            "schema_version": 1,
            "registry_path": "website-projects.json",
            "project_profile_path": ".openai/website-profile.json",
            "workspace_root": str(self.root / "workspace"),
            "allowed_root_domains": ["example.com"],
            "default_hosting_provider": "cloudflare-pages",
        }
        (self.config / "website-maker.json").write_text(
            json.dumps(self.settings), encoding="utf-8"
        )
        self.registry_path = self.config / "website-projects.json"
        self.registry_path.write_text(
            json.dumps({"schema_version": 1, "updated_at": None, "projects": []}),
            encoding="utf-8",
        )
        self.receipt_path = self.root / "receipt.json"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def record_args(self, **changes: object) -> argparse.Namespace:
        values: dict[str, object] = {
            "config_root": str(self.config),
            "project": str(self.project),
            "project_key": "sample-site",
            "title": "Sample Site",
            "primary_domain": "sample.example.com",
            "alias": None,
            "provider": "cloudflare-pages",
            "provider_project": "sample-pages",
            "deployment_mode": "direct-upload",
            "source_repository": "owner/sample",
            "source_hash": "abc1234",
            "source_visibility": "private",
            "dns_provider": "cloudflare",
            "data_mode": "static",
            "brand_source": None,
            "data_source": None,
            "critical_path": ["/"],
            "verified_at": None,
            "status": "active",
            "check": ["I typed that everything passed"],
            "receipt": str(self.receipt_path),
            "receipt_sha256": None,
            "max_receipt_age": 3600.0,
            "dry_run": False,
        }
        values.update(changes)
        return argparse.Namespace(**values)

    def valid_receipt(self) -> dict[str, object]:
        receipt: dict[str, object] = {
            "schema_version": site_ops.RECEIPT_SCHEMA_VERSION,
            "receipt_type": site_ops.RECEIPT_TYPE,
            "status": "passed",
            "target": {
                "url": "https://sample.example.com/",
                "hostname": "sample.example.com",
            },
            "site": {
                "project_key": "sample-site",
                "primary_domain": "sample.example.com",
            },
            "provider": {"name": "cloudflare-pages", "project": "sample-pages"},
            "source": {"id": "owner/sample", "hash": "abc1234"},
            "verified_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "checks": {
                "dns": {
                    "ok": True,
                    "public_recursive": {"ok": True},
                    "authoritative": {"ok": True},
                    "system": {"ok": True},
                },
                "tls": {"ok": True},
                "https": [{"url": "https://sample.example.com/", "ok": True, "status": 200}],
            },
        }
        receipt["receipt_sha256"] = site_ops.receipt_hash(receipt)
        return receipt

    def write_receipt(self, receipt: dict[str, object]) -> str:
        self.receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        return str(receipt["receipt_sha256"])

    def test_active_record_rejects_user_check_without_receipt_and_writes_nothing(self) -> None:
        before = sha256(self.registry_path)
        args = self.record_args(receipt=None, receipt_sha256=None)
        with self.assertRaisesRegex(SystemExit, "requires --receipt"):
            site_ops.cmd_record(args)
        self.assertEqual(before, sha256(self.registry_path))
        self.assertFalse((self.project / ".openai" / "website-profile.json").exists())

    def test_active_record_rejects_every_receipt_identity_mismatch(self) -> None:
        cases = {
            "target": lambda value: value.update(
                {"target": {"url": "https://other.example.com/", "hostname": "other.example.com"}}
            ),
            "site": lambda value: value.update(
                {"site": {"project_key": "other", "primary_domain": "sample.example.com"}}
            ),
            "provider": lambda value: value.update(
                {"provider": {"name": "cloudflare-worker", "project": "sample-pages"}}
            ),
            "source": lambda value: value.update(
                {"source": {"id": "owner/other", "hash": "abc1234"}}
            ),
        }
        baseline = sha256(self.registry_path)
        for field, mutate in cases.items():
            with self.subTest(field=field):
                receipt = copy.deepcopy(self.valid_receipt())
                mutate(receipt)
                receipt["receipt_sha256"] = site_ops.receipt_hash(receipt)
                receipt_hash = self.write_receipt(receipt)
                with self.assertRaisesRegex(SystemExit, field):
                    site_ops.cmd_record(self.record_args(receipt_sha256=receipt_hash, dry_run=True))
                self.assertEqual(baseline, sha256(self.registry_path))

        receipt = self.valid_receipt()
        receipt_hash = self.write_receipt(receipt)
        other_time = (dt.datetime.now().astimezone() - dt.timedelta(seconds=1)).isoformat(timespec="seconds")
        with self.assertRaisesRegex(SystemExit, "timestamp"):
            site_ops.cmd_record(
                self.record_args(
                    receipt_sha256=receipt_hash,
                    verified_at=other_time,
                    dry_run=True,
                )
            )
        with self.assertRaisesRegex(SystemExit, "hash"):
            site_ops.cmd_record(self.record_args(receipt_sha256="0" * 64, dry_run=True))
        self.assertEqual(baseline, sha256(self.registry_path))

    def test_valid_receipt_dry_run_has_zero_mutations(self) -> None:
        receipt = self.valid_receipt()
        receipt_hash = self.write_receipt(receipt)
        before = sha256(self.registry_path)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = site_ops.cmd_record(
                self.record_args(receipt_sha256=receipt_hash, dry_run=True)
            )
        report = json.loads(output.getvalue())
        self.assertEqual(0, result)
        self.assertEqual("would-record", report["status"])
        self.assertEqual([], report["mutations"])
        self.assertEqual(before, sha256(self.registry_path))
        self.assertFalse((self.project / ".openai" / "website-profile.json").exists())

    def test_valid_receipt_records_active_with_receipt_evidence(self) -> None:
        receipt = self.valid_receipt()
        receipt_hash = self.write_receipt(receipt)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(
                0,
                site_ops.cmd_record(self.record_args(receipt_sha256=receipt_hash)),
            )
        registry = json.loads(self.registry_path.read_text(encoding="utf-8"))
        entry = registry["projects"][0]
        self.assertEqual("active", entry["status"])
        self.assertEqual(receipt_hash, entry["verification_receipt_sha256"])
        self.assertEqual(
            ["dns.public_recursive", "dns.authoritative", "tls", "https"],
            entry["checks"],
        )
        self.assertNotEqual(entry["notes"], entry["checks"])

    def verify_args(self, **changes: object) -> argparse.Namespace:
        values: dict[str, object] = {
            "url": "https://sample.example.com/",
            "site": "sample-site",
            "provider": "cloudflare-pages",
            "provider_project": "sample-pages",
            "source": "owner/sample",
            "source_hash": "abc1234",
            "endpoint": ["/"],
            "expect": ["hello"],
            "reject": ["secret"],
            "timeout": 1.0,
            "verified_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "public_resolver": "cloudflare",
            "receipt_out": str(self.receipt_path),
            "dry_run": False,
        }
        values.update(changes)
        return argparse.Namespace(**values)

    def test_verify_writes_structured_receipt_with_bound_hash(self) -> None:
        dns = {
            "ok": True,
            "public_recursive": {"ok": True, "transport": "doh/https"},
            "authoritative": {"ok": True, "transport": "udp/53"},
            "system": {"ok": True},
        }
        tls = {"ok": True, "certificate_sha256": "f" * 64}
        with (
            mock.patch.object(site_ops, "collect_dns_evidence", return_value=dns),
            mock.patch.object(site_ops, "collect_tls_evidence", return_value=tls),
            mock.patch.object(
                site_ops,
                "fetch",
                return_value=(200, "hello", "https://sample.example.com/", {"server": "cloudflare"}),
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(0, site_ops.cmd_verify(self.verify_args()))
        receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(site_ops.RECEIPT_TYPE, receipt["receipt_type"])
        self.assertEqual("doh/https", receipt["checks"]["dns"]["public_recursive"]["transport"])
        self.assertEqual("udp/53", receipt["checks"]["dns"]["authoritative"]["transport"])
        self.assertEqual(receipt["receipt_sha256"], site_ops.receipt_hash(receipt))

    def test_verify_dry_run_does_not_write_receipt(self) -> None:
        dns = {
            "ok": True,
            "public_recursive": {"ok": True},
            "authoritative": {"ok": True},
            "system": {"ok": True},
        }
        output = io.StringIO()
        with (
            mock.patch.object(site_ops, "collect_dns_evidence", return_value=dns),
            mock.patch.object(site_ops, "collect_tls_evidence", return_value={"ok": True}),
            mock.patch.object(
                site_ops,
                "fetch",
                return_value=(200, "hello", "https://sample.example.com/", {}),
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(0, site_ops.cmd_verify(self.verify_args(dry_run=True)))
        self.assertFalse(self.receipt_path.exists())
        report = json.loads(output.getvalue())
        self.assertEqual(report["receipt_sha256"], site_ops.receipt_hash(report))

    def test_public_dns_falls_back_to_named_public_udp_resolver(self) -> None:
        recursive_result = {
            "name": "sample.example.com",
            "record_type": "A",
            "status": 0,
            "transport": "udp/53",
            "server": "1.1.1.1",
            "ok": True,
            "answers": [
                {
                    "name": "sample.example.com",
                    "type": site_ops.DNS_TYPES["A"],
                    "ttl": 300,
                    "data": "192.0.2.1",
                }
            ],
        }
        with (
            mock.patch.object(
                site_ops.urllib.request,
                "urlopen",
                side_effect=site_ops.urllib.error.URLError("untrusted proxy certificate"),
            ),
            mock.patch.object(
                site_ops,
                "recursive_dns_query",
                return_value=recursive_result,
            ) as recursive,
        ):
            result = site_ops.public_dns_query(
                "sample.example.com", "A", 1.0, "cloudflare"
            )
        recursive.assert_called_once_with("1.1.1.1", "sample.example.com", "A", 1.0)
        self.assertTrue(result["ok"])
        self.assertEqual("udp/53", result["transport"])
        self.assertIn("untrusted proxy certificate", result["doh_error"])

    def test_reconcile_reports_drift_and_never_mutates_inputs(self) -> None:
        registry = {
            "schema_version": 1,
            "projects": [
                {
                    "project_key": "sample-site",
                    "title": "Sample Site",
                    "project_root": str(self.root / "workspace" / "apps" / "sample"),
                    "primary_domain": "sample.example.com",
                    "hosting_provider": "cloudflare-pages",
                    "provider_project": "wrong-project",
                    "source_repository": "owner/sample",
                    "source_visibility": "private",
                    "data_mode": "static",
                    "status": "active",
                }
            ],
        }
        self.registry_path.write_text(json.dumps(registry), encoding="utf-8")
        workspace_path = self.root / "website-workspace.json"
        workspace = {
            "schema_version": 1,
            "workspace_root": str(self.root / "workspace"),
            "services": [
                {
                    "key": "sample-site",
                    "title": "Sample Site",
                    "hostname": "sample.example.com",
                    "canonical_path": "apps/sample",
                    "hosting_provider": "cloudflare-pages",
                    "provider_project": "sample-pages",
                    "source_repository": "owner/sample",
                    "source_visibility": "private",
                    "data_mode": "static",
                    "domain_status": "active",
                },
                {"key": "workspace-only", "title": "Workspace Only"},
            ],
            "development_projects": [],
        }
        workspace_path.write_text(json.dumps(workspace), encoding="utf-8")
        registry_before = sha256(self.registry_path)
        workspace_before = sha256(workspace_path)
        output = io.StringIO()
        args = argparse.Namespace(
            config_root=str(self.config),
            workspace=str(workspace_path),
            dry_run=True,
            fail_on_drift=False,
        )
        with contextlib.redirect_stdout(output):
            self.assertEqual(0, site_ops.cmd_reconcile(args))
        report = json.loads(output.getvalue())
        self.assertTrue(report["summary"]["has_drift"])
        self.assertTrue(report["dry_run"])
        self.assertEqual(1, report["summary"]["field_drifts"])
        self.assertEqual(["workspace-only"], report["only_in_workspace"])
        self.assertEqual(0, report["summary"]["mutations"])
        self.assertEqual(registry_before, sha256(self.registry_path))
        self.assertEqual(workspace_before, sha256(workspace_path))

    def test_help_and_init_profile_dry_run_do_not_mutate(self) -> None:
        before = sha256(self.registry_path)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(0, result.returncode)
        args = self.record_args(dry_run=True, force=False)
        args.receipt = None
        args.receipt_sha256 = None
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, site_ops.cmd_init_profile(args))
        self.assertEqual(before, sha256(self.registry_path))
        self.assertFalse((self.project / ".openai" / "website-profile.json").exists())


if __name__ == "__main__":
    unittest.main()

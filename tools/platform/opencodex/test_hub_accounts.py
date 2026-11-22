import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest import mock

spec = importlib.util.spec_from_file_location('hub_accounts', Path(__file__).with_name('hub-accounts.py'))
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


class HubAccountsTests(unittest.TestCase):
    def setUp(self):
        self.config = {'codexAccountNamespaces': {'main': '@main', 'p-test': 'private-id'}}
        self.identity = hub.hashlib.sha256(b'private-id').hexdigest()

    def test_projection_hides_unregistered_main_identity_and_secrets(self):
        payload = {'accounts': [
            {'id': 'private-id', 'email': 'private@example.test', 'accessToken': 'secret',
             'paused': True, 'plan': 'team', 'quota': {'weeklyPercent': 0, 'secret': 'x'}},
            {'id': '@main', 'email': 'native@example.test'},
        ]}
        rows = hub.project_accounts(payload, self.config)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['identityHash'], self.identity)
        encoded = hub.json.dumps(rows)
        for private in ('private-id', 'example.test', 'secret', '@main'):
            self.assertNotIn(private, encoded)

    @mock.patch.object(hub, 'native_cli')
    def test_status_requests_quota_without_forcing_refresh(self, cli):
        hub.read_account_inventory('status')
        cli.assert_called_once_with('account', 'list', 'openai', '--quota', '--json')
        cli.reset_mock()
        hub.read_account_inventory('refresh')
        cli.assert_called_once_with('account', 'refresh', 'openai', '--json')

    def test_missing_quota_is_unknown_and_zero_is_known(self):
        for quota, known in [(None, False), ({}, False), ({'shortPercent': 0}, False),
                             ({'weeklyPercent': 0}, True), ({'weeklyPercent': 100}, True),
                             ({'weeklyPercent': False}, False), ({'weeklyPercent': -1}, False)]:
            row = hub.project_accounts({'accounts': [{'id': 'private-id', 'quota': quota}]}, self.config)[0]
            self.assertEqual(row['quotaKnown'], known)
            self.assertEqual(row['quotaFreshness'], 'unreported')

    def test_tray_projection_never_promises_admission_from_cached_headroom(self):
        policy={'strictAdmission':True}
        below=hub.project_admission({'quota':{'shortPercent':0,'weeklyPercent':10}},policy)
        self.assertIsNone(below['eligible'])
        self.assertEqual(below['state'],'conditional')
        for quota in ({'shortPercent':95,'weeklyPercent':10},{'shortPercent':0,'weeklyPercent':98}):
            blocked=hub.project_admission({'quota':quota},policy)
            self.assertEqual(blocked['eligible'],False)
            self.assertEqual(blocked['state'],'blocked')
        unknown=hub.project_admission({'quota':{}},policy)
        self.assertEqual(unknown['state'],'unverified')

    @mock.patch.object(hub, 'run_json')
    def test_identity_mismatch_and_main_refused_before_io(self, run):
        for selector, identity in [('main', self.identity), ('p-test', '0' * 64), ('bad/selector', self.identity)]:
            with self.assertRaises(RuntimeError):
                hub.change_pause(self.config, selector, identity, False, True)
        run.assert_not_called()

    def test_identity_projection_is_order_independent_and_hides_email(self):
        self.config['codexAccountNamespaces']['p-other'] = 'second-id'
        payload = {'accounts': [
            {'id': 'second-id', 'email': 'Other@Example.test', 'active': True},
            {'id': 'private-id', 'email': ' FIRST@example.test ', 'active': False},
        ]}
        rows = {r['selector']: r for r in hub.project_identities(payload, self.config)}
        self.assertEqual(rows['p-test']['accountName'], 'first')
        self.assertEqual(rows['p-test']['emailHash'], hub.hashlib.sha256(b'first@example.test').hexdigest())
        self.assertEqual(rows['p-other']['accountName'], 'other')
        self.assertTrue(rows['p-other']['active'])
        self.assertTrue(all(r['accountNumber'] is None for r in rows.values()))
        self.assertNotIn('@', hub.json.dumps(rows))

    def test_masked_cli_email_uses_only_exact_registered_metadata(self):
        self.config['codexAccounts'] = [{'id': 'private-id', 'email': 'actual@example.test'}]
        rows = hub.project_identities({'accounts': [{'id': 'private-id', 'email': 'a***@example.test'}]}, self.config)
        self.assertEqual(rows[0]['accountName'], 'actual')
        self.config['codexAccounts'] = [{'id': 'different-id', 'email': 'wrong@example.test'}]
        row = hub.project_identities({'accounts': [{'id': 'private-id', 'email': 'a***@example.test'}]}, self.config)[0]
        self.assertIsNone(row['emailHash'])
        self.assertIsNone(row['accountName'])

    @mock.patch.object(hub, 'run_json')
    def test_preview_never_sends(self, run):
        result = hub.change_pause(self.config, 'p-test', self.identity, False, False)
        self.assertEqual(result['terminal'], 'DRY_RUN')
        run.assert_not_called()

    @mock.patch.object(hub, 'run_json')
    def test_mutation_requires_independent_readback(self, run):
        run.side_effect = [
            {'http': 200, 'ok': True, 'paused': False},
            {'accounts': [{'id': 'private-id', 'paused': True}]},
        ]
        with self.assertRaisesRegex(RuntimeError, 'readback_unconfirmed_do_not_retry'):
            hub.change_pause(self.config, 'p-test', self.identity, False, True)
        self.assertEqual(run.call_count, 2)

    @mock.patch.object(hub, 'run_json')
    def test_unknown_mutation_is_not_retried(self, run):
        run.return_value = {'http': 504}
        with self.assertRaisesRegex(RuntimeError, 'mutation_unconfirmed_do_not_retry'):
            hub.change_pause(self.config, 'p-test', self.identity, False, True)
        self.assertEqual(run.call_count, 1)

    def test_recovery_healthy_stock_child_is_noop_and_foreign_owner_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            unit = home / '.config/systemd/user/opencodex-proxy.service'
            unit.parent.mkdir(parents=True)
            unit.write_text(f'ExecStart={home / '.bun/bin/ocx'} start --port 10100\nEnvironment=OPENCODEX_HOME={hub.CONFIG.parent}\n')
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = b'{"service":"opencodex","status":"ready","pid":102,"port":10100,"version":"2.76.0"}'
            with mock.patch.object(hub.Path, 'home', return_value=home), mock.patch.object(hub.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='101')), mock.patch.object(hub.urllib.request, 'urlopen', return_value=response), mock.patch.object(hub, 'owns_runtime_pid', return_value=True):
                self.assertEqual(hub.recover_hub(True)['changed'], False)
            with mock.patch.object(hub.Path, 'home', return_value=home), mock.patch.object(hub.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='101')), mock.patch.object(hub.urllib.request, 'urlopen', return_value=response), mock.patch.object(hub, 'owns_runtime_pid', return_value=False):
                with self.assertRaisesRegex(RuntimeError, 'hub_live_owner_unknown'):
                    hub.recover_hub(True)

    def test_recovery_live_unready_owner_is_never_restarted(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            unit = home / '.config/systemd/user/opencodex-proxy.service'
            unit.parent.mkdir(parents=True)
            unit.write_text(f'ExecStart={home / '.bun/bin/ocx'} start\nEnvironment=OPENCODEX_HOME={hub.CONFIG.parent}\n')
            with mock.patch.object(hub.Path, 'home', return_value=home), mock.patch.object(hub.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='101')) as run, mock.patch.object(hub.urllib.request, 'urlopen', side_effect=OSError):
                with self.assertRaisesRegex(RuntimeError, 'hub_live_or_starting'):
                    hub.recover_hub(True)
                self.assertEqual(run.call_count, 1)

    def test_recovery_refuses_raced_unit_before_start(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            unit = home / '.config/systemd/user/opencodex-proxy.service'
            unit.parent.mkdir(parents=True)
            original = f'ExecStart={home / '.bun/bin/ocx'} start\nEnvironment=OPENCODEX_HOME={hub.CONFIG.parent}\n'
            unit.write_text(original)
            connection = mock.MagicMock()
            connection.__enter__.return_value.connect_ex.return_value = 111
            def race(_):
                unit.write_text(original + '# changed\n')
            with mock.patch.object(hub.Path, 'home', return_value=home), mock.patch.object(hub.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='0')) as run, mock.patch.object(hub.urllib.request, 'urlopen', side_effect=OSError), mock.patch.object(hub.socket, 'socket', return_value=connection), mock.patch.object(hub.time, 'sleep', side_effect=race):
                with self.assertRaisesRegex(RuntimeError, 'hub_preimage_changed'):
                    hub.recover_hub(True)
                self.assertEqual(run.call_count, 2)


if __name__ == '__main__':
    unittest.main()

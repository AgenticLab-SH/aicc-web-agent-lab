import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).parent
for name, filename in [('native_versions', 'native-versions.py'), ('hub_accounts', 'hub-accounts.py'), ('hub_update', 'hub-update.py')]:
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
update = sys.modules['hub_update']


class UpdateSafetyTests(unittest.TestCase):
    def test_exact_idle_gate_rejects_off_busy_unknown_or_mixed_versions(self):
        state = {'version': '2.76.0', 'runtimeVersion': '2.76.0', 'running': True, 'activeTurns': 0, 'draining': False}
        update.assert_idle(state, '2.76.0')
        for key, value in [('running', False), ('activeTurns', None), ('activeTurns', 1), ('draining', True), ('runtimeVersion', '2.74.0')]:
            with self.assertRaises(RuntimeError):
                update.assert_idle({**state, key: value}, '2.76.0')

    @mock.patch.object(update, 'status', return_value={'running': False})
    @mock.patch.object(update.versions, 'snapshot')
    def test_off_owner_never_snapshots_starts_or_updates(self, snapshot, status):
        with self.assertRaises(RuntimeError):
            update.update('2.76.0', '2.77.0')
        snapshot.assert_not_called()

    @mock.patch.object(update.hub, 'native_cli')
    @mock.patch.object(update.hub, 'recover_hub', return_value={'terminal': 'DRY_RUN'})
    @mock.patch.object(update.versions, 'validate_root', return_value=(ROOT, '2.76.0'))
    def test_status_off_does_not_start_or_query_active_model(self, validate, recover, cli):
        result = update.status()
        self.assertFalse(result['running'])
        recover.assert_called_once_with(False)
        cli.assert_not_called()

    def test_failed_update_rolls_back_only_offline_exact_owner_and_software(self):
        with tempfile.TemporaryDirectory() as temporary:
            unit = Path(temporary) / 'unit'
            config = Path(temporary) / 'config.json'
            unit.write_text('owned service')
            config.write_text('{}')
            state = {'version': '2.76.0', 'runtimeVersion': '2.76.0', 'running': True, 'activeTurns': 0, 'draining': False}
            for service_pid in ['0', '123']:
                with mock.patch.object(update, 'UNIT', unit), mock.patch.object(update.hub, 'CONFIG', config), mock.patch.object(update, 'STORE', Path(temporary) / 'versions'), mock.patch.object(update, 'status', return_value=state), mock.patch.object(update.versions, 'snapshot', return_value={'snapshot': '2.76.0-' + 'a'*16}), mock.patch.object(update.versions, 'digest_tree', return_value='b'*64), mock.patch.object(update.versions, 'restore') as restore, mock.patch.object(update.hub, 'recover_hub', return_value={'terminal': 'PASS', 'version': '2.76.0'}) as recover, mock.patch.object(update.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0, stdout=service_pid)]):
                    if service_pid == '0':
                        result = update.update('2.76.0', '2.77.0')
                        self.assertEqual(result['terminal'], 'ROLLED_BACK')
                        self.assertFalse(result['accountStateRestored'])
                        restore.assert_called_once_with(update.ROOT, update.STORE, '2.76.0-' + 'a'*16, 'b'*64, 10100, True)
                        recover.assert_called_once_with(True)
                    else:
                        with self.assertRaises(RuntimeError):
                            update.update('2.76.0', '2.77.0')
                        restore.assert_not_called()
                        recover.assert_not_called()


if __name__ == '__main__':
    unittest.main()

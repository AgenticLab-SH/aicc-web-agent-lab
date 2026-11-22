import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('versions', Path(__file__).with_name('native-versions.py'))
versions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(versions)


class VersionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / '.bun/install/global'
        self.package = self.root / 'node_modules/@bitkyc08/opencodex'
        (self.package / 'bin').mkdir(parents=True)
        (self.package / 'bin/ocx.mjs').write_text('original')
        (self.package / 'package.json').write_text(json.dumps({'version': '2.74.0'}))
        (self.root / 'package.json').write_text(json.dumps({'dependencies': {'@bitkyc08/opencodex': '2.74.0'}}))
        self.store = self.base / 'snapshots'
        self.auth = self.base / '.opencodex/auth.json'
        self.auth.parent.mkdir()
        self.auth.write_text('current credentials')

    def test_restore_preserves_current_credentials_and_preimage(self):
        snap = versions.snapshot(self.root, self.store)
        (self.package / 'package.json').write_text(json.dumps({'version': '2.76.0'}))
        current = versions.digest_tree(self.root)
        with patch.object(versions, 'assert_offline'):
            result = versions.restore(self.root, self.store, snap['snapshot'], current, 10100, True)
        self.assertEqual(result['terminal'], 'RESTORED_OFFLINE')
        self.assertEqual(self.auth.read_text(), 'current credentials')
        self.assertEqual(json.loads((self.package / 'package.json').read_text())['version'], '2.74.0')
        self.assertTrue(Path(result['previousSoftware']).exists())

    def test_corrupt_snapshot_is_refused_before_change(self):
        snap = versions.snapshot(self.root, self.store)
        (self.store / snap['snapshot'] / 'global/node_modules/@bitkyc08/opencodex/bin/ocx.mjs').write_text('tampered')
        with self.assertRaisesRegex(RuntimeError, 'snapshot_corrupt'):
            versions.restore(self.root, self.store, snap['snapshot'], versions.digest_tree(self.root), 10100, True)
        self.assertEqual((self.package / 'bin/ocx.mjs').read_text(), 'original')

    def test_changed_preimage_and_wrong_root_are_refused(self):
        snap = versions.snapshot(self.root, self.store)
        with self.assertRaisesRegex(RuntimeError, 'current_package_changed'):
            versions.restore(self.root, self.store, snap['snapshot'], '0' * 64, 10100, True)
        with self.assertRaisesRegex(RuntimeError, 'exact_bun_global_root_required'):
            versions.snapshot(self.auth.parent, self.store)

    def test_windows_offline_uses_exact_kernel_listener_table(self):
        safe='TCP 127.0.0.1:10100 127.0.0.1:5050 TIME_WAIT 0\nTCP 0.0.0.0:445 0.0.0.0:0 LISTENING 4'
        versions.assert_windows_listener_table(0, safe, 10100)
        for code, output in [(1,safe), (0,''), (0,'TCP malformed'),
                (0,safe+'\nTCP [::]:10100 [::]:0 LISTENING 123'),
                (0,safe+'\nTCP 127.0.0.1:10100 0.0.0.0:0 UNKNOWN 0')]:
            with self.assertRaisesRegex(RuntimeError,'runtime_live_or_unknown'):
                versions.assert_windows_listener_table(code, output, 10100)


if __name__ == '__main__':
    unittest.main()

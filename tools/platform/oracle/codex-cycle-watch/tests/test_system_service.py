from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import system_service as service


class SystemServiceTests(unittest.TestCase):
    def test_nonroot_execution_and_filesystem_protection(self):
        result = service.render(Path('/demo/owner/aicc-codex-cycle-watch'), 'ubuntu')
        unit = result[service.UNIT + '.service'].decode()
        for line in ('User=ubuntu', 'Group=ubuntu', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=read-only'):
            self.assertIn(line, unit)
        self.assertNotIn('User=root', unit)
        self.assertIn('OnUnitInactiveSec=120s', result[service.UNIT + '.timer'].decode())

    def test_exact_root_and_user(self):
        for root, user in [('/demo/owner/aicc-codex-cycle-watch', 'ubuntu'), ('/tmp/aicc-codex-cycle-watch', 'ubuntu'), ('/demo/owner/aicc-codex-cycle-watch', 'ubuntu\nUser=root')]:
            with self.assertRaises(ValueError):
                service.render(Path(root), user)

    def test_read_only_plan_binds_user_program_and_preimage(self):
        with patch.object(Path, 'read_bytes', return_value=b'synthetic'), patch.object(Path, 'exists', return_value=False), patch.object(Path, 'is_symlink', return_value=False):
            first, _ = service.plan(Path('/demo/owner/aicc-codex-cycle-watch'), 'ubuntu')
            second, _ = service.plan(Path('/demo/owner/aicc-codex-cycle-watch'), 'ubuntu')
        self.assertEqual(first['confirmation'], second['confirmation'])
        self.assertEqual(len(first['preexisting']), 3)

    def test_foreign_receipt_refused_before_unit_access(self):
        with self.assertRaises(ValueError):
            service.verify_receipt({'unit':'other'}, Path('/demo/owner/aicc-codex-cycle-watch'), 'ubuntu')

    def test_resume_requires_server_local_device_auth_for_every_alias(self):
        identities = {'team-one': 'a' * 64, 'team-two': 'b' * 64, 'plus': 'c' * 64}
        state = {'version': 1, 'accounts': {
            alias: {'identity': identity, 'status': 'watching'}
            for alias, identity in identities.items()
        }}
        provenance = {'version': 1, 'accounts': {
            alias: {'method': 'server_device_auth', 'identity': identity, 'verifiedAt': 1800000000}
            for alias, identity in identities.items()
        }}
        self.assertTrue(service.auth_provenance_ready(state, provenance))
        missing = {'version': 1, 'accounts': dict(provenance['accounts'])}
        del missing['accounts']['plus']
        self.assertFalse(service.auth_provenance_ready(state, missing))
        cloned = {'version': 1, 'accounts': dict(provenance['accounts'])}
        cloned['accounts']['team-one'] = {
            'method': 'cloned', 'identity': identities['team-one'], 'verifiedAt': 1800000000
        }
        self.assertFalse(service.auth_provenance_ready(state, cloned))


if __name__ == '__main__':
    unittest.main()

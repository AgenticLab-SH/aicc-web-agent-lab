import importlib.util
from pathlib import Path
import unittest
import hashlib
import json
import tempfile
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('window_policy',Path(__file__).with_name('build-window-policy.py'))
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
hub_spec=importlib.util.spec_from_file_location('hub_window_policy',Path(__file__).with_name('hub-window-policy.py'))
hub=importlib.util.module_from_spec(hub_spec);hub_spec.loader.exec_module(hub)

class PolicyBuildSafety(unittest.TestCase):
    def test_refuses_an_unreviewed_upstream_preimage(self):
        with self.assertRaisesRegex(RuntimeError,'upstream_source_pin_changed'):policy.patch(b'unreviewed source')
    def test_refuses_output_inside_source(self):
        with self.assertRaisesRegex(RuntimeError,'fresh_separate_output_required'):
            policy.build(Path('/fixture/.bun/install/global'),Path('/fixture/.bun/install/global/candidate'))
    def test_refuses_unreviewed_update_handler(self):
        with self.assertRaisesRegex(RuntimeError,'update_source_pin_changed'):policy.patch_update(b'unreviewed updater')

    def test_update_guard_is_attested_before_service_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);root=base/'versions/candidate';package=root/'node_modules/@bitkyc08/opencodex'
            math=package/'src/codex/routing/cooldown-math.ts';math.parent.mkdir(parents=True);math.write_bytes(b'policy')
            update=package/'src/server/management/config-routes.ts';update.parent.mkdir(parents=True);update.write_bytes(b'guard')
            (package/'package.json').write_text(json.dumps({'version':'2.76.0-aicc.windows.2'}))
            drop=base/'service.conf';drop.write_bytes(b'owned')
            registry={'root':str(root),'dropSha256':hashlib.sha256(b'owned').hexdigest()}
            with patch.object(hub,'BASE',base),patch.object(hub,'DROP',drop),patch.object(hub,'HASH',hashlib.sha256(b'policy').hexdigest()):
                with self.assertRaisesRegex(RuntimeError,'update_guard_source_changed'):hub.checked(registry)
                registry['updateSourceSha256']=hashlib.sha256(b'guard').hexdigest()
                self.assertEqual(hub.checked(registry),package)
                update.write_bytes(b'changed updater')
                with self.assertRaisesRegex(RuntimeError,'update_guard_source_changed'):hub.checked(registry)
                (package/'package.json').write_text(json.dumps({'version':'2.76.0-aicc.windows.1'}))
                self.assertEqual(hub.checked(registry),package)

    def test_strict_admission_sources_must_be_attested(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);root=base/'versions/candidate';package=root/'node_modules/@bitkyc08/opencodex'
            for relative,content in [('src/codex/routing/cooldown-math.ts',b'policy'),('src/server/management/config-routes.ts',b'guard'),('src/codex/routing/aicc-window-admission.ts',b'admission')]:
                target=package/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
            (package/'package.json').write_text(json.dumps({'version':'2.76.0-aicc.windows.3'}))
            drop=base/'service.conf';drop.write_bytes(b'owned')
            registry={'root':str(root),'dropSha256':hashlib.sha256(b'owned').hexdigest(),'updateSourceSha256':hashlib.sha256(b'guard').hexdigest()}
            hashes={'src/codex/routing/aicc-window-admission.ts':hashlib.sha256(b'admission').hexdigest()}
            with patch.object(hub,'BASE',base),patch.object(hub,'DROP',drop),patch.object(hub,'HASH',hashlib.sha256(b'policy').hexdigest()),patch.object(hub,'ADMISSION_HASHES',hashes):
                with self.assertRaisesRegex(RuntimeError,'admission_registry_changed'):hub.checked(registry)
                registry['admissionSourceSha256']=hashes
                self.assertEqual(hub.checked(registry),package)
                (package/'src/codex/routing/aicc-window-admission.ts').write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError,'admission_source_changed'):hub.checked(registry)

if __name__=='__main__':unittest.main()

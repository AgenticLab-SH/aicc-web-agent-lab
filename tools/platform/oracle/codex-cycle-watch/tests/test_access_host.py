import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if os.name == "posix":
    import access_host


@unittest.skipUnless(os.name == "posix", "POSIX SSH storage")
class HostTests(unittest.TestCase):
    def test_add_idempotent_revoke_preserves_previous_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "authorized_keys"
            path.write_bytes(b"synthetic previous key\n")
            path.chmod(0o600)
            key = "ssh-rsa c3ludGhldGlj fixture"
            self.assertEqual(access_host.enroll(root, key)["status"], "enrolled")
            self.assertEqual(access_host.enroll(root, key)["status"], "already_enrolled")
            self.assertEqual(access_host.revoke(root, key)["status"], "revoked")
            self.assertEqual(path.read_bytes(), b"synthetic previous key\n")

    def test_unsafe_storage_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "authorized_keys").write_bytes(b"previous\n")
            (root / "authorized_keys").chmod(0o644)
            with self.assertRaises(ValueError):
                access_host.enroll(root, "ssh-rsa c3ludGhldGlj fixture")


if __name__ == "__main__":
    unittest.main()

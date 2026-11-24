import tempfile
import unittest
from pathlib import Path
from stage_windows_landmarker import stage


class WindowsModelStagingTests(unittest.TestCase):
    def test_rejects_wrong_wheel_before_creating_destination(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            wheel = root / "bad.whl"
            wheel.write_bytes(b"not an upstream wheel")
            destination = root / "bundle"
            with self.assertRaisesRegex(RuntimeError, "pinned SHA-256"):
                stage(wheel, root / "missing.task", destination)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import windows_ambient_owner_overlay as tool


class OverlayTests(unittest.TestCase):
    def setup_notices(self, root):
        target = root / tool.NOTICES
        target.mkdir(parents=True)
        for name in ("MODEL-ATTRIBUTION.txt", "THIRD-PARTY-NOTICES.txt"):
            (target / name).write_text("Synthetic notice; not licensed package evidence.", encoding="utf-8")

    def test_maps_only_expected_resources_into_distinct_machine_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.setup_notices(root)
            required = ["libmediapipe.dll", "hand_landmarker.task", "MEDIAPIPE-LICENSE.txt"]
            admitted = {"result": "offline-resource-pins-verified-not-release-approval", "files": dict.fromkeys(required)}
            with patch.object(tool, "inspect", return_value=admitted) as verify:
                result = tool.overlay(root, root / "synthetic-wheel")
            verify.assert_called_once_with(root / tool.STAGED, root / "synthetic-wheel")
            self.assertEqual(result["identifier"], "com.kgamazing44.aerift.cameratester")
            self.assertEqual(result["bundle"]["windows"]["nsis"]["installMode"], "perMachine")
            self.assertNotIn("app", result)
            self.assertEqual(result["bundle"]["resources"]["ambient-private-input/native/libmediapipe.dll"],
                             "ambient-camera-model/libmediapipe.dll")
            self.assertEqual(len(result["bundle"]["resources"]), 5)

    def test_unreviewed_resource_name_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.setup_notices(root)
            admitted = {"result": "offline-resource-pins-verified-not-release-approval",
                        "files": {"extra.dll": ""}}
            with patch.object(tool, "inspect", return_value=admitted):
                with self.assertRaisesRegex(RuntimeError, "Unexpected model resource inventory"):
                    tool.overlay(root, root / "synthetic-wheel")

    def test_missing_notice_or_model_admission_refuses_overlay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(tool, "inspect", return_value={"result": "not verified"}):
                with self.assertRaisesRegex(RuntimeError, "Missing offline model admission"):
                    tool.overlay(root, root / "synthetic-wheel")
            with patch.object(tool, "inspect", return_value={"result": "offline-resource-pins-verified-not-release-approval"}):
                with self.assertRaises(FileNotFoundError):
                    tool.overlay(root, root / "synthetic-wheel")


if __name__ == "__main__":
    unittest.main()

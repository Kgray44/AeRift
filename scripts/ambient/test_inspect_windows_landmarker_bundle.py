import hashlib
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import inspect_windows_landmarker_bundle as mod


def pe(machine=0x8664):
    header = bytearray(88)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 0x3C, 64)
    header[64:68] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", header, 68, machine, 1, 0, 0, 0, 0, 0x2000)
    return header


class Inspection(unittest.TestCase):
    def test_wrong_architecture_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            dll = Path(td) / "wrong.dll"
            dll.write_bytes(pe(0x14C))
            with self.assertRaisesRegex(RuntimeError, "x64"):
                mod.require_x64_dll(dll)

    def test_allowlist_and_upstream_hash_and_notice(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td).resolve()
            root = base / "bundle"
            root.mkdir()
            wheel = base / "wheel.zip"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(mod.WHEEL_NOTICE, b"fixture notice")
            inputs = {"libmediapipe.dll": pe(), "hand_landmarker.task": b"fixture model",
                      "MEDIAPIPE-LICENSE.txt": b"fixture notice"}
            for name, body in inputs.items():
                (root / name).write_bytes(body)
            with patch.multiple(mod, WHEEL=hashlib.sha256(wheel.read_bytes()).hexdigest(),
                                DLL=hashlib.sha256(inputs["libmediapipe.dll"]).hexdigest(),
                                MODEL=hashlib.sha256(inputs["hand_landmarker.task"]).hexdigest()):
                self.assertEqual(mod.inspect(root, wheel)["result"],
                                 "offline-resource-pins-verified-not-release-approval")
                notice = root / "MEDIAPIPE-LICENSE.txt"
                notice.write_bytes(b"different notice")
                with self.assertRaisesRegex(RuntimeError, "drifted"):
                    mod.inspect(root, wheel)
                notice.write_bytes(inputs[notice.name])
                (root / "unapproved.dll").touch()
                with self.assertRaisesRegex(RuntimeError, "bundle member"):
                    mod.inspect(root, wheel)

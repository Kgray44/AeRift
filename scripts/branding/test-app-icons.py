"""Validate deterministic derivatives without a platform SDK."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from xml.etree import ElementTree
import zlib

spec = importlib.util.spec_from_file_location("icons", Path(__file__).with_name("app-icons.py"))
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)


def raster(path):
    data = path.read_bytes()
    assert data.startswith(icons.PNG)
    w, h, depth, color, _, _, _ = struct.unpack_from(">IIBBBBB", data, 16)
    channels = {2: 3, 6: 4}[color]
    assert depth == 8
    compressed = []
    pos = 8
    while pos + 12 <= len(data):
        size, tag = struct.unpack_from(">I4s", data, pos)
        if tag == b"IDAT":
            compressed.append(data[pos+8:pos+8+size])
        pos += size + 12
    decoded = zlib.decompress(b"".join(compressed))
    step = 1 + w * channels
    rows = []
    for pos in range(0, len(decoded), step):
        assert decoded[pos] == 1
        line = bytearray(decoded[pos+1:pos+step])
        for i in range(channels, len(line)):
            line[i] = (line[i] + line[i-channels]) & 255
        rows.append(bytes(line))
    return w, h, channels, rows


class IconTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = icons.source_pixels()
        cls.output = tempfile.TemporaryDirectory()
        cls.root = Path(cls.output.name)
        icons.ios(cls.source, cls.root / "apple" / "AppIcon.appiconset")
        icons.android(cls.source, cls.root / "android")

    @classmethod
    def tearDownClass(cls):
        cls.output.cleanup()

    def test_windows_staged_files_exact_and_small_variants_are_uncompressed(self):
        root = icons.ROOT / "apps/aerift/src-tauri/icons"
        icons.windows(self.source, root, True)
        data = (root / "icon.ico").read_bytes()
        self.assertEqual(struct.unpack_from("<HHH", data), (0, 1, 5))
        for index, size in enumerate([32, 16, 24, 48, 256]):
            w, h, _, _, _, bits, length, offset = struct.unpack_from("<BBBBHHII", data, 6 + index * 16)
            self.assertEqual((w or 256, h or 256, bits), (size, size, 32))
            self.assertLessEqual(offset + length, len(data))
            if size < 256:
                self.assertEqual(struct.unpack_from("<Iii", data, offset), (40, size, size * 2))
            else:
                self.assertTrue(data[offset:].startswith(icons.PNG))

    def test_ios_compiler_input_is_opaque_and_exact_catalog(self):
        catalog = self.root / "apple" / "AppIcon.appiconset"
        asset = json.loads((catalog / "Contents.json").read_text())["images"][0]
        self.assertEqual((asset["size"], asset["idiom"], asset["platform"]), ("1024x1024", "universal", "ios"))
        w, h, channels, rows = raster(catalog / asset["filename"])
        self.assertEqual((w, h, channels), (1024, 1024, 3))
        self.assertEqual(rows, icons.resize(self.source, 1024))

    def test_android_adaptive_inset_and_legacy_art(self):
        root = self.root / "android"
        xml = ElementTree.parse(root / "mipmap-anydpi-v26/aerift_launcher.xml")
        ns = "{http://schemas.android.com/apk/res/android}"
        self.assertEqual(xml.find("foreground").get(ns + "drawable"), "@mipmap/aerift_launcher_foreground")
        for dens, scale in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
            lane = root / ("mipmap-" + dens)
            legacy = int(48 * scale)
            w, h, channels, rows = raster(lane / "aerift_launcher.png")
            self.assertEqual((w, h, channels), (legacy, legacy, 3))
            self.assertEqual(rows, icons.resize(self.source, legacy))
            w, h, channels, rows = raster(lane / "aerift_launcher_foreground.png")
            self.assertEqual((w, h, channels), (int(108 * scale), int(108 * scale), 4))
            self.assertEqual(rows[0], bytes(w * 4))
            for y, row in enumerate(rows):
                for x in range(w):
                    if max(row[x*4:x*4+3]) > 100:
                        self.assertLessEqual((x + .5 - w/2)**2 + (y + .5 - h/2)**2, (33 * scale)**2)


if __name__ == "__main__":
    unittest.main()

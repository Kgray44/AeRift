"""Host staging checks (no SDK, tool downloads or device needed)."""
import tempfile
import unittest
from pathlib import Path
from runpy import run_path
from xml.etree import ElementTree as ET

stage = run_path(str(Path(__file__).with_name("stage-host.py")))["stage"]
ANDROID = "{http://schemas.android.com/apk/res/android}"


class HostStaging(unittest.TestCase):
    def test_repeat_preserves_activities_reconciles_permissions_and_copies_overlay(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            main = root / "project/app/src/main"
            main.mkdir(parents=True)
            manifest = main / "AndroidManifest.xml"
            manifest.write_text("""<manifest xmlns:android="http://schemas.android.com/apk/res/android">
                <uses-permission android:name="android.permission.INTERNET" />
                <application android:usesCleartextTraffic="${usesCleartextTraffic}">
                    <activity android:name=".MainActivity" android:exported="true" />
                </application>
            </manifest>""")
            overlay = root / "overlay"
            (overlay / "kotlin").mkdir(parents=True)
            (overlay / "kotlin/Example.kt").write_text("class Example")
            (overlay / "AndroidManifest.xml").write_text("""<manifest xmlns:android="http://schemas.android.com/apk/res/android">
                <uses-permission android:name="android.permission.CAMERA" />
                <application><provider android:name="androidx.core.content.FileProvider"
                    android:exported="false" /></application>
            </manifest>""")
            stage(root / "project", overlay)
            before = manifest.read_bytes()
            stage(root / "project", overlay)
            self.assertEqual(manifest.read_bytes(), before)
            xml = ET.parse(manifest).getroot()
            self.assertEqual({node.get(ANDROID + "name") for node in xml.findall("uses-permission")},
                             {"android.permission.INTERNET", "android.permission.CAMERA"})
            self.assertEqual(xml.find("application/activity").get(ANDROID + "name"), ".MainActivity")
            self.assertEqual(xml.find("application/provider").get(ANDROID + "exported"), "false")
            self.assertEqual((main / "kotlin/Example.kt").read_text(), "class Example")


if __name__ == "__main__":
    unittest.main()

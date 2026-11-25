import unittest
from xml.etree import ElementTree as ET
from photo_picker_ui import find_target

def ui(*nodes):
    return ET.fromstring("<hierarchy>" + "".join(nodes) + "</hierarchy>")

def item(desc, package="com.google.android.providers.media.module", bounds="[4,6][104,206]"):
    return f'<node package="{package}" content-desc="{desc}" bounds="{bounds}" enabled="true" clickable="true"/>'

class PickerSelectionTests(unittest.TestCase):
    def test_pixel_is_only_a_trusted_accessible_photopicker_item(self):
        self.assertEqual(find_target(ui(item("Photo taken on Today")), "photo"), (54,106))
        self.assertIsNone(find_target(ui(item("Photo taken on Today", "com.kgamazing44.aerift")), "photo"))
        self.assertIsNone(find_target(ui(item("Choose photos")), "photo"))
        self.assertIsNone(find_target(ui(item("Photo taken on Today"), item("Photo taken on yesterday", bounds="[0,0][90,90]")), "photo"))

    def test_commit_requires_an_explicit_trusted_control(self):
        self.assertEqual(find_target(ui(item("Add (1)")), "commit"), (54,106))
        self.assertEqual(find_target(ui(item("Done")), "commit"), (54,106))
        self.assertIsNone(find_target(ui(item("Add (2)")), "commit"))

if __name__ == "__main__":
    unittest.main()

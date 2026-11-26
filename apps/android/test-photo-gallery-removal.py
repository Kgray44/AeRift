import contextlib
import io
import unittest
from xml.etree import ElementTree as ET

from photo_gallery_ui import find

OWNER = "com.kgamazing44.aerift"
CONFIRM = "Confirm remove imported copy"
REMOVE = "Remove imported copy"

def node(label, kind="android.widget.Button", owner=OWNER, clickable="true",
         enabled="true", bounds="[70,150][170,210]"):
    return (f'<node package="{owner}" class="{kind}" content-desc="{label}" '
            f'clickable="{clickable}" enabled="{enabled}" bounds="{bounds}"/>')

def observe(action, *nodes):
    xml = ET.fromstring(f'<hierarchy><node package="{OWNER}" bounds="[0,0][300,500]"/>'
                        + ''.join(nodes) + '</hierarchy>')
    result = io.StringIO()
    with contextlib.redirect_stdout(result):
        return find(xml, OWNER, action), result.getvalue().strip()

class Removal(unittest.TestCase):
    def test_same_label_group_before_exact_action(self):
        group = node(CONFIRM, kind="android.view.View", clickable="false",
                     bounds="[30,100][250,300]")
        self.assertEqual(observe("confirm-remove", group, node(CONFIRM)), (True, "120 180"))

    def test_refuses_untrusted_unusable_and_duplicate_actions(self):
        for nodes in [
            [node(CONFIRM, owner="another.app")], [node(CONFIRM, enabled="false")],
            [node(CONFIRM, clickable="false")], [node(CONFIRM, kind="android.view.View")],
            [node(CONFIRM), node(CONFIRM, bounds="[180,150][270,210]")],
            [node(CONFIRM + " now")],
        ]:
            self.assertEqual(observe("confirm-remove", *nodes), (False, ""))

    def test_clicks_only_exact_remove_button_in_first_phase(self):
        self.assertEqual(observe("remove", node(CONFIRM), node(REMOVE)), (True, "120 180"))
        self.assertEqual(observe("remove", node(CONFIRM)), (False, ""))

if __name__ == "__main__":
    unittest.main()

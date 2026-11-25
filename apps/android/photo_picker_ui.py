"""Locate a unique visible action inside the SDK emulator's system Photo Picker."""

import re
import sys
from xml.etree import ElementTree as ET

PACKAGES = {
    "com.android.providers.media.module",
    "com.google.android.providers.media.module",
    "com.android.photopicker",
    "com.google.android.photopicker",
}
PHOTO_DESC = re.compile(r"Photo taken on .+", re.ASCII)
BOUNDS = re.compile(r"\[(\d+),(\d+)]\[(\d+),(\d+)]")

def find_target(root, action):
    targets = set()
    for node in root.iter("node"):
        if node.get("package") not in PACKAGES or node.get("enabled") != "true":
            continue
        labels = (node.get("text", ""), node.get("content-desc", ""))
        if action == "photo":
            allowed = any(PHOTO_DESC.fullmatch(label) for label in labels)
        elif action == "commit":
            allowed = any(label in ("Add (1)", "Done") for label in labels)
        else:
            return None
        box = BOUNDS.fullmatch(node.get("bounds", ""))
        if not allowed or not box:
            continue
        left, top, right, bottom = map(int, box.groups())
        if right > left and bottom > top:
            targets.add(((left + right) // 2, (top + bottom) // 2))
    return next(iter(targets)) if len(targets) == 1 else None

if __name__ == "__main__":
    try:
        target = find_target(ET.parse(sys.argv[1]), sys.argv[2])
    except (ET.ParseError, OSError):
        target = None
    if target is None:
        raise SystemExit(1)
    print(*target)

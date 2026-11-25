"""Find the owned app's Photos controls; never print unknown AX text."""
import re
import sys
from xml.etree import ElementTree as ET

EXPECTED = (
    "Choose from your photo library",
    "Back to Workspace",
    "Imported photos and videos",
    "Photo gallery",
    "Recents",
    "Import photos and videos",
    "Retry loading imports",
    "Loading imports…",
)


def labels(node):
    return (node.get("text", ""), node.get("content-desc", ""))


def bounds(node):
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    if not match:
        return None
    left, top, right, bottom = map(int, match.groups())
    if right > left and bottom > top:
        return left, top, right, bottom
    return None


def find(root, owner, action):
    views = [
        node for node in root.iter("node")
        if node.get("class") == "android.webkit.WebView" and node.get("package") == owner and bounds(node)
    ]
    if len(views) != 1:
        if action == "report":
            print("Owned Photos WebView unavailable or ambiguous.")
        return False
    view = views[0]
    nodes = [node for node in view.iter("node") if node.get("package") == owner]
    left, top, right, bottom = bounds(view)
    if action == "report":
        for label in EXPECTED:
            matches = [node for node in nodes if label in labels(node)]
            if matches:
                print("Owned Photos AX:", label, "count", len(matches),
                      "enabled", sum(node.get("enabled") == "true" for node in matches))
        return True
    if action == "confirm":
        return any(EXPECTED[0] in labels(node) and bounds(node) for node in nodes)
    if action == "target":
        matches = [
            node for node in nodes if "Import photos and videos" in labels(node)
            and node.get("enabled") == "true" and node.get("clickable") == "true" and bounds(node)
        ]
        if len(matches) != 1:
            return False
        l, t, r, b = bounds(matches[0])
        if not (left <= l < r <= right and top <= t < b <= bottom):
            return False
        print((l + r) // 2, (t + b) // 2)
        return True
    if action == "scroll" and bottom - top >= 200:
        x = (left + right) // 2
        height = bottom - top
        print(x, top + height * 75 // 100, x, top + height * 36 // 100)
        return True
    return False


if __name__ == "__main__":
    try:
        path, package, operation = sys.argv[1:]
        ok = find(ET.parse(path), package, operation)
    except (ValueError, OSError, ET.ParseError):
        ok = False
    sys.exit(0 if ok else 1)

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


def imported_names(fixture_id):
    if not re.fullmatch(r"[0-9]{1,19}", fixture_id or ""):
        return {}
    return {"original": "AeRift-Android-photo-smoke.png", "picker": f"{fixture_id}.png"}


def find(root, owner, action, fixture_id=None, admitted=None):
    # UiAutomator may flatten WebView ancestry or provide multiple provider
    # nodes. Ownership is instead checked by the caller immediately before
    # this dump and input, and independently by each node's package.
    nodes = [node for node in root.iter("node") if node.get("package") == owner]
    if action == "report":
        print("Owned Photos AX node count:", len(nodes))
        for cls in ("android.webkit.WebView", "android.widget.FrameLayout",
                    "android.view.View", "android.widget.Button", "android.widget.TextView"):
            print("Owned Photos AX class:", cls,
                  sum(node.get("class") == cls for node in nodes))
        for label in EXPECTED:
            matches = [node for node in nodes if label in labels(node)]
            if matches:
                print("Owned Photos AX:", label, "count", len(matches),
                      "enabled", sum(node.get("enabled") == "true" for node in matches),
                      "clickable", sum(node.get("clickable") == "true" for node in matches))
        print("Owned Photos AX imported-action count:",
              sum(any(label.startswith("Open ") for label in labels(node)) for node in nodes))
        return True
    # The largest owned rectangle can be reported more than once (e.g. a
    # decor wrapper and a WebView). Refuse conflicting full-size rectangles.
    rectangles = {area for node in nodes if (area := bounds(node))}
    def area_size(rect):
        return (rect[2] - rect[0]) * (rect[3] - rect[1])
    largest = max((area_size(rect) for rect in rectangles), default=0)
    frames = [rect for rect in rectangles if area_size(rect) == largest]
    if len(frames) != 1:
        return False
    left, top, right, bottom = frames[0]
    if action == "confirm":
        return any(EXPECTED[0] in labels(node) and bounds(node) for node in nodes)
    if action == "imported":
        allowed = imported_names(fixture_id)
        if admitted is not None:
            allowed = {mode: name for mode, name in allowed.items() if mode == admitted}
        matches = [(mode, node) for node in nodes for mode, name in allowed.items()
                   if f"Open {name}" in labels(node) and node.get("enabled") == "true"
                   and node.get("clickable") == "true" and bounds(node)]
        if len(matches) != 1:
            return False
        mode, node = matches[0]
        l, t, r, b = bounds(node)
        if not (left <= l < r <= right and top <= t < b <= bottom):
            return False
        print((l + r) // 2, (t + b) // 2, mode)
        return True
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
        path, package, operation, *extra = sys.argv[1:]
        ok = find(ET.parse(path), package, operation, *extra[:2])
    except (ValueError, OSError, ET.ParseError):
        ok = False
    sys.exit(0 if ok else 1)

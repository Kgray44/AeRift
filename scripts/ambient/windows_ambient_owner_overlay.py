#!/usr/bin/env python3
"""Generate narrowly scoped Tauri resource overlay, not a signed installer."""
import argparse
import json
from pathlib import Path

from inspect_windows_landmarker_bundle import inspect, plain

RESOURCE_ROOT = "ambient-camera-model"
STAGED = Path("ambient-private-input/native")
NOTICES = Path("ambient-private-input/notices")


def require_input(root: Path, relative: Path):
    # Contract uses fixed relative paths, relative to the base src-tauri dir.
    path = root / relative
    parents = (root, *root.parents, *(root / Path(*relative.parts[:i]) for i in range(1, len(relative.parts))))
    for parent in parents:
        plain(parent, expect_directory=True)
    plain(path)
    return path


def overlay(root: Path, wheel: Path) -> dict:
    root = root.absolute()
    admitted = inspect(root / STAGED, wheel)
    if admitted.get("result") != "offline-resource-pins-verified-not-release-approval":
        raise RuntimeError("Missing offline model admission")
    notice_names = ("MODEL-ATTRIBUTION.txt", "THIRD-PARTY-NOTICES.txt")
    for name in notice_names:
        path = require_input(root, NOTICES / name)
        if not 0 < path.stat().st_size <= 256 * 1024:
            raise RuntimeError("Missing bounded, reviewed notice")
    resources = {str(STAGED / name).replace("\\", "/"): f"{RESOURCE_ROOT}/{name}"
                 for name in sorted(admitted["files"])}
    resources.update({str(NOTICES / name).replace("\\", "/"): f"licenses/ambient/{name}"
                      for name in notice_names})
    if set(resources.values()) != {
        f"{RESOURCE_ROOT}/libmediapipe.dll", f"{RESOURCE_ROOT}/hand_landmarker.task",
        f"{RESOURCE_ROOT}/MEDIAPIPE-LICENSE.txt", *(f"licenses/ambient/{name}" for name in notice_names),
    }:
        raise RuntimeError("Unexpected model resource inventory")
    return {
        "productName": "AeRift Camera Tester",
        "identifier": "com.kgamazing44.aerift.cameratester",
        "bundle": {"resources": resources, "windows": {"nsis": {"installMode": "perMachine"}}},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src-tauri", required=True, type=Path)
    parser.add_argument("--wheel", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(overlay(args.src_tauri, args.wheel), sort_keys=True, indent=2))

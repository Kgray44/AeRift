#!/usr/bin/env python3
"""Build an offline Windows x64 qualification bundle from exact upstream assets."""
import argparse
import hashlib
from pathlib import Path
import tempfile
import zipfile

WHEEL = "438d98977a4e1b0f88070ad16537a328912f847ce9debf236da047b0b483cbfd"
MODEL = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
DLL = "6dbb21a391cf79bead3d82efb00d02b3638435340c950545042b83194a5b87e7"


def check(path, digest, maximum):
    if not path.is_file() or path.stat().st_size > maximum:
        raise RuntimeError("Pinned input is missing or exceeds its size limit")
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
            raise RuntimeError("Qualification input does not match its pinned SHA-256")


def stage(wheel, model, destination):
    check(wheel, WHEEL, 12 * 1024 * 1024)
    check(model, MODEL, 8 * 1024 * 1024)
    if destination.exists():
        raise RuntimeError("Choose an empty, new qualification bundle path")
    with zipfile.ZipFile(wheel) as archive:
        dll = archive.read("mediapipe/tasks/c/libmediapipe.dll")
        notice = archive.read("mediapipe-0.10.32.dist-info/licenses/LICENSE")
    if hashlib.sha256(dll).hexdigest() != DLL:
        raise RuntimeError("Extracted DLL does not match its pinned SHA-256")
    # All content is verified before committing its destination. No arbitrary
    # zip members are extracted. Keep this operation on a single filesystem.
    with tempfile.TemporaryDirectory(prefix="aerift-qualify-", dir=destination.parent) as temp:
        staged = Path(temp) / "bundle"
        staged.mkdir()
        (staged / "libmediapipe.dll").write_bytes(dll)
        (staged / "MEDIAPIPE-LICENSE.txt").write_bytes(notice)
        model_data = model.read_bytes()
        if hashlib.sha256(model_data).hexdigest() != MODEL:
            raise RuntimeError("Model changed after initial pinned SHA-256 verification")
        (staged / "hand_landmarker.task").write_bytes(model_data)
        staged.rename(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    stage(args.wheel, args.model, args.output)
    print("Verified offline Windows x64 qualification bundle staged.")

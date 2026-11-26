#!/usr/bin/env python3
"""Offline resource admission evidence; never loads a DLL or grants camera access."""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import struct
import zipfile

from stage_windows_landmarker import DLL, MODEL, WHEEL, check

NAMES = frozenset({"libmediapipe.dll", "hand_landmarker.task", "MEDIAPIPE-LICENSE.txt"})
WHEEL_NOTICE = "mediapipe-0.10.32.dist-info/licenses/LICENSE"


def plain(path: Path, expect_directory=False):
    """Reject Windows reparse points, symlinks, and all unexpected file types."""
    info = path.lstat()
    valid = stat.S_ISDIR(info.st_mode) if expect_directory else stat.S_ISREG(info.st_mode)
    reparse = getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if not valid or reparse:
        raise RuntimeError("Expected ordinary resource with no links/reparse points")


def file_digest(path: Path, maximum: int) -> str:
    plain(path)
    total = 0
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(64 * 1024):
            total += len(chunk)
            if total > maximum:
                raise RuntimeError("Resource exceeds its byte bound")
            digest.update(chunk)
    return digest.hexdigest()


def require_x64_dll(path: Path):
    with path.open("rb") as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise RuntimeError("Resource is not a PE DLL")
        offset = struct.unpack_from("<I", header, 0x3C)[0]
        if not 64 <= offset <= 1024 * 1024:
            raise RuntimeError("Resource PE header offset is invalid")
        stream.seek(offset)
        coff = stream.read(24)
    if len(coff) != 24 or coff[:4] != b"PE\0\0":
        raise RuntimeError("Resource PE signature is invalid")
    machine, _, _, _, _, _, flags = struct.unpack_from("<HHIIIHH", coff, 4)
    if machine != 0x8664 or flags & 0x2000 == 0:
        raise RuntimeError("Resource is not a Windows x64 DLL")


def inspect(root: Path, wheel: Path) -> dict:
    """Use same upstream pins as staging, on a packaging-owned offline directory."""
    root = root.absolute()
    for ancestor in (root, *root.parents):
        plain(ancestor, expect_directory=True)
    if {entry.name for entry in root.iterdir()} != NAMES:
        raise RuntimeError("Unexpected or missing resource bundle member")
    plain(wheel)
    check(wheel, WHEEL, 12 * 1024 * 1024)
    with zipfile.ZipFile(wheel) as archive:
        info = archive.getinfo(WHEEL_NOTICE)
        if not 0 < info.file_size <= 64 * 1024:
            raise RuntimeError("Unexpected upstream notice length")
        notice = archive.read(info)
    hashes = {name: file_digest(root / name, cap) for name, cap in [
        ("libmediapipe.dll", 29 * 1024 * 1024),
        ("hand_landmarker.task", 8 * 1024 * 1024),
        ("MEDIAPIPE-LICENSE.txt", 64 * 1024),
    ]}
    if hashes != {
        "libmediapipe.dll": DLL,
        "hand_landmarker.task": MODEL,
        "MEDIAPIPE-LICENSE.txt": hashlib.sha256(notice).hexdigest(),
    }:
        raise RuntimeError("Offline resources drifted from their pinned upstream content")
    require_x64_dll(root / "libmediapipe.dll")
    return {"schema": 1, "result": "offline-resource-pins-verified-not-release-approval",
            "wheelSha256": WHEEL, "files": hashes}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--wheel", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(inspect(args.root, args.wheel), sort_keys=True))

#!/usr/bin/env python3
"""Offline qualification of AeRift's existing pinned hand model through MediaPipe C.

Inputs must be exact upstream 0.10.32 assets and upstream test photo, not user images.
Does not open a camera, run pip, install Python modules, contact a service, or report
landmarks. Python/ctypes is a test harness, not a proposed bundled runtime.
"""
import argparse
import ctypes as c
import hashlib
import os
from pathlib import Path
import platform
import tempfile
import zipfile

MODEL = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
HAND_FIXTURE = "5d673c081ab13b8a1812269ff57047066f9c33c07db5f4178089e8cb3fdc0291"
TARGETS = {
    "Windows": (
        "mediapipe/tasks/c/libmediapipe.dll",
        "438d98977a4e1b0f88070ad16537a328912f847ce9debf236da047b0b483cbfd",
        "6dbb21a391cf79bead3d82efb00d02b3638435340c950545042b83194a5b87e7",
    ),
    "Linux": (
        "mediapipe/tasks/c/libmediapipe.so",
        "4b0941fbbbce41862f13cb1850c4878c13dbc62cd5e81e74880051b7a20ce3b6",
        "97c19aa3e4c9da5d4e6a28d90d0a9a388cfcbc293c4ab599cb353b5d5d3a04d9",
    ),
}


def check_digest(path, expected):
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise RuntimeError("Qualification input did not match its pinned digest")


class BaseOptions(c.Structure):
    _fields_ = [
        ("model_asset_buffer", c.c_void_p),
        ("model_asset_buffer_count", c.c_uint),
        ("model_asset_path", c.c_char_p),
        ("delegate", c.c_int),
    ]


class HandOptions(c.Structure):
    _fields_ = [
        ("base_options", BaseOptions),
        ("running_mode", c.c_int),
        ("num_hands", c.c_int),
        ("min_hand_detection_confidence", c.c_float),
        ("min_hand_presence_confidence", c.c_float),
        ("min_tracking_confidence", c.c_float),
        ("callback", c.c_void_p),
    ]


class LandmarkCollection(c.Structure):
    _fields_ = [("data", c.c_void_p), ("count", c.c_uint32)]


class HandResult(c.Structure):
    _fields_ = [
        ("handedness", c.c_void_p),
        ("handedness_count", c.c_uint32),
        ("landmarks", c.POINTER(LandmarkCollection)),
        ("landmarks_count", c.c_uint32),
        ("world", c.c_void_p),
        ("world_count", c.c_uint32),
    ]


def detect(library, model, fixture, decoded_rgb):
    # Argument contracts pinned to the v0.10.32 MediaPipe C headers.
    def api(name, result, *args):
        fun = getattr(library, name)
        fun.restype = result
        fun.argtypes = args
        return fun

    pointer = c.c_void_p
    pointer_out = c.POINTER(pointer)
    create = api("MpHandLandmarkerCreate", c.c_int, c.POINTER(HandOptions), pointer_out, pointer)
    close = api("MpHandLandmarkerClose", c.c_int, pointer, pointer)
    release_result = api("MpHandLandmarkerCloseResult", None, c.POINTER(HandResult))
    detect_image = api("MpHandLandmarkerDetectImage", c.c_int, pointer, pointer, pointer, c.POINTER(HandResult), pointer)
    load_fixture = api("MpImageCreateFromFile", c.c_int, c.c_char_p, pointer_out, pointer)
    create_rgb = api("MpImageCreateFromUint8Data", c.c_int, c.c_int, c.c_int, c.c_int, pointer, c.c_int, pointer_out, pointer)
    release_image = api("MpImageFree", None, pointer)

    model_bytes = c.create_string_buffer(model.read_bytes())
    options = HandOptions(BaseOptions(c.cast(model_bytes, pointer), len(model_bytes) - 1, None, 0),
                          1, 2, .5, .5, .5, None)
    handle = pointer()
    if create(c.byref(options), c.byref(handle), None) or not handle:
        raise RuntimeError("Native CPU hand landmarker initialization failed")
    try:
        blank_label = "synthetic MF decode to RGB" if decoded_rgb is not None else "blank synthetic RGB"
        for label, expected_count in [(blank_label, 0), ("pinned upstream hand fixture", 1)]:
            image = pointer()
            if expected_count:
                result = load_fixture(os.fsencode(fixture), c.byref(image), None)
            else:
                expected_size = 256 * 256 * 3
                black = (c.c_ubyte * expected_size)()
                if decoded_rgb is not None:
                    with decoded_rgb.open("rb") as source:
                        data = source.read(expected_size + 1)
                    if data != bytes(expected_size):
                        raise RuntimeError("Decoded fixture must match the known generated blank RGB")
                    black = type(black).from_buffer_copy(data)
                result = create_rgb(1, 256, 256, black, len(black), c.byref(image), None)
            if result or not image:
                raise RuntimeError("Native input construction failed")
            try:
                detection = HandResult()
                if detect_image(handle, image, None, c.byref(detection), None):
                    raise RuntimeError("Native CPU inference failed")
                try:
                    if detection.landmarks_count != expected_count or (
                        expected_count and (not detection.landmarks or detection.landmarks[0].count != 21)
                    ):
                        raise RuntimeError(f"Unexpected detection for {label}")
                    print(f"{label}: expected {expected_count} hand(s); "
                          f"{21 * expected_count} landmark(s)", flush=True)
                finally:
                    release_result(c.byref(detection))
            finally:
                release_image(image)
    finally:
        if close(handle, None):
            raise RuntimeError("Native landmarker shutdown failed")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--wheel", required=True, type=Path)
    p.add_argument("--model", required=True, type=Path)
    p.add_argument("--fixture", required=True, type=Path)
    p.add_argument("--decoded-rgb", type=Path, help="optional synthetic blank fixture from ambient_blank_frame")
    args = p.parse_args()
    host = platform.system()
    if host not in TARGETS or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise RuntimeError("Qualification harness pins Win x64 and Linux x64 upstream binaries")
    member, wheel_sha, binary_sha = TARGETS[host]
    check_digest(args.wheel, wheel_sha)
    check_digest(args.model, MODEL)
    check_digest(args.fixture, HAND_FIXTURE)
    with tempfile.TemporaryDirectory(prefix="aerift-landmark-proof-") as temp:
        output = Path(temp) / Path(member).name
        with zipfile.ZipFile(args.wheel) as wheel:
            output.write_bytes(wheel.read(member))
        check_digest(output, binary_sha)
        library = c.CDLL(str(output))
        try:
            detect(library, args.model, args.fixture.resolve(), args.decoded_rgb)
        finally:
            # A loaded DLL cannot be unlinked on Windows; unload after releasing all
            # C objects. This qualification process performs only one load.
            if host == "Windows":
                import _ctypes
                _ctypes.FreeLibrary(library._handle)
    print("Pinned native CPU inference only; no camera acquisition was attempted.", flush=True)


if __name__ == "__main__":
    main()

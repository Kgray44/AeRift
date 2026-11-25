#!/usr/bin/env python3
"""Derive native icons from the exact approved AeRift artwork."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets/branding/aerift-logo.png"
SHA256 = "2aa3948cead24d7afeb23d9b417943ef869bcaf776f2e5182eeb97161fe7476f"
NATIVE_SOURCE = ROOT / "assets/branding/aerift-mark-transparent.png"
NATIVE_SHA256 = "3472bb0e7f7fa5911509f499fbe27a1ae8a2dc70767c48a64d69273799d388f3"
PNG = b"\x89PNG\r\n\x1a\n"
DARK = (4, 4, 11)


def source_pixels(native=False):
    data = (NATIVE_SOURCE if native else SOURCE).read_bytes()
    expected = NATIVE_SHA256 if native else SHA256
    if hashlib.sha256(data).hexdigest() != expected or not data.startswith(PNG):
        raise ValueError("Unexpected approved AeRift artwork")
    pos, encoded = 8, []
    while pos < len(data):
        length, tag = struct.unpack_from(">I4s", data, pos)
        payload = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, color, comp, filt, interlace = struct.unpack(">IIBBBBB", payload)
            if (w, h, depth, color, comp, filt, interlace) != (1254, 1254, 8, 6, 0, 0, 0):
                raise ValueError("Unexpected source PNG layout")
        if tag == b"IDAT":
            encoded.append(payload)
        pos += length + 12
    pixels = zlib.decompress(b"".join(encoded))
    stride, prior, rows = w * 4, bytes(w * 4), []
    for y in range(h):
        pos = y * (stride + 1)
        mode, row = pixels[pos], bytearray(pixels[pos + 1:pos + 1 + stride])
        for i in range(stride):
            a = row[i - 4] if i >= 4 else 0
            b = prior[i]
            c = prior[i - 4] if i >= 4 else 0
            if mode == 0:
                continue
            if mode == 1:
                f = a
            elif mode == 2:
                f = b
            elif mode == 3:
                f = (a + b) // 2
            elif mode == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                f = a if pa <= pb and pa <= pc else b if pb <= pc else c
            else:
                raise ValueError("Unexpected source PNG filter")
            row[i] = (row[i] + f) & 255
        if not native and any(a != 255 for a in row[3::4]):
            raise ValueError("Approved artwork is expected to be opaque")
        rows.append(row)
        prior = row
    return rows


def resize(source, size):
    """Integer pixel-area box resampling over the full, uncropped approved frame."""
    n = len(source)
    if not 1 <= size <= n:
        raise ValueError("Invalid icon size")
    axes = []
    for i in range(size):
        left, right = i * n, (i + 1) * n
        axes.append([(q, min(right, (q + 1) * size) - max(left, q * size))
                     for q in range(left // size, (right - 1) // size + 1)])
    horiz = []
    for row in source:
        horiz.append([sum(row[q * 4 + c] * overlap for q, overlap in span)
                      for span in axes for c in range(3)])
    return [bytes((sum(horiz[q][x] * overlap for q, overlap in span) + n * n // 2) // (n * n)
                  for x in range(size * 3)) for span in axes]


def resize_alpha(source, size):
    """Area resampling with alpha-weighted colors and no contribution from hidden RGB."""
    n = len(source)
    if not 1 <= size <= n:
        raise ValueError("Invalid icon size")
    axes = []
    for i in range(size):
        left, right = i * n, (i + 1) * n
        axes.append([(q, min(right, (q + 1) * size) - max(left, q * size))
                     for q in range(left // size, (right - 1) // size + 1)])
    horiz = []
    for row in source:
        prem = [(row[i] * row[i + 3], row[i + 1] * row[i + 3],
                 row[i + 2] * row[i + 3], row[i + 3]) for i in range(0, len(row), 4)]
        horiz.append([sum(prem[q][c] * overlap for q, overlap in span)
                      for span in axes for c in range(4)])
    result = []
    for span in axes:
        row = bytearray()
        for x in range(size):
            i = x * 4
            weighted_alpha = sum(horiz[q][i + 3] * overlap for q, overlap in span)
            alpha = (weighted_alpha + n * n // 2) // (n * n)
            if not alpha:
                row.extend(bytes(4))
                continue
            row.extend((sum(horiz[q][i + c] * overlap for q, overlap in span)
                        + weighted_alpha // 2) // weighted_alpha for c in range(3))
            row.append(alpha)
        result.append(bytes(row))
    return result


def composite(rows, color):
    return [bytes((row[i + c] * row[i + 3] + color[c] * (255 - row[i + 3]) + 127) // 255
                  for i in range(0, len(row), 4) for c in range(3)) for row in rows]


def png(rows, channels):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    size = len(rows)
    filtered = b"".join(b"\x01" + bytes((p - row[i - channels]) & 255 if i >= channels else p
                                       for i, p in enumerate(row)) for row in rows)
    return (PNG + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2 if channels == 3 else 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(filtered, 9)) + chunk(b"IEND", b""))


def rgba(rows):
    return [b"".join(row[i:i + 3] + b"\xff" for i in range(0, len(row), 3)) for row in rows]


def windows(source, destination, check):
    sizes = (32, 16, 24, 48, 256)
    offset = 6 + len(sizes) * 16
    directory, frames = [], []
    for size in sizes:
        rows = resize_alpha(source, size)
        if size == 256:
            frame = png(rows, 4)
        else:
            image = b"".join(b"".join(row[i:i + 3][::-1] + row[i + 3:i + 4]
                                        for i in range(0, len(row), 4)) for row in reversed(rows))
            stride = ((size + 31) // 32) * 4
            mask = bytearray(stride * size)
            for y, row in enumerate(reversed(rows)):
                for x, alpha in enumerate(row[3::4]):
                    if alpha == 0:
                        mask[y * stride + x // 8] |= 0x80 >> (x % 8)
            frame = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, len(image), 0, 0, 0, 0) + image + mask
        dim = size & 255
        directory.append(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(frame), offset))
        frames.append(frame)
        offset += len(frame)
    output = {"icon.ico": struct.pack("<HHH", 0, 1, len(sizes)) + b"".join(directory + frames),
              "icon.png": png(resize_alpha(source, 32), 4)}
    for name, content in output.items():
        path = destination / name
        if check:
            if path.read_bytes() != content:
                raise ValueError(f"{path} does not match the approved source")
        else:
            path.write_bytes(content)


def ios(source, destination):
    # Xcode 14+ universal iOS icon; minimum shipping system is iOS 15.
    destination.mkdir(parents=True, exist_ok=True)
    # The system supplies its own rounded mask. Keep the artwork clear
    # of the icon edge, using solid RGB rather than uploaded PNG alpha.
    mark = composite(resize_alpha(source, 896), DARK)
    border = bytes(DARK) * 64
    blank = bytes(DARK) * 1024
    rows = [blank] * 64 + [border + row + border for row in mark] + [blank] * 64
    (destination / "AeRift-AppIcon.png").write_bytes(png(rows, 3))
    payload = {"images": [{"filename": "AeRift-AppIcon.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
               "info": {"author": "xcode", "version": 1}}
    (destination / "Contents.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def android(source, destination):
    for density, scale in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
        mipmap = destination / f"mipmap-{density}"
        mipmap.mkdir(parents=True, exist_ok=True)
        legacy, area, art = (round(dp * scale) for dp in (48, 108, 72))
        (mipmap / "aerift_launcher.png").write_bytes(png(resize(source, legacy), 3))
        # Adaptive foreground protection: keep the approved artwork at the
        # center, with transparent padding for the launcher mask and parallax.
        inset = (area - art) // 2
        transparent = bytes(inset * 4)
        empty = bytes(area * 4)
        foreground = [empty] * inset + [transparent + row + transparent for row in rgba(resize(source, art))] + [empty] * inset
        (mipmap / "aerift_launcher_foreground.png").write_bytes(png(foreground, 4))
    adaptive = destination / "mipmap-anydpi-v26"
    adaptive.mkdir(parents=True, exist_ok=True)
    (adaptive / "aerift_launcher.xml").write_text(
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/aerift_launcher_backdrop" />\n'
        '    <foreground android:drawable="@mipmap/aerift_launcher_foreground" />\n'
        '</adaptive-icon>\n', encoding="utf-8")
    values = destination / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "aerift_launcher_colors.xml").write_text(
        f'<resources><color name="aerift_launcher_backdrop">#{bytes(DARK).hex()}</color></resources>\n', encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("platform", choices=["windows", "ios", "android"])
    parser.add_argument("destination", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check and args.platform != "windows":
        parser.error("--check applies only to committed Windows resources")
    source = source_pixels(native=args.platform != "android")
    if args.platform == "windows":
        windows(source, args.destination, args.check)
    elif args.platform == "ios":
        ios(source, args.destination)
    else:
        android(source, args.destination)

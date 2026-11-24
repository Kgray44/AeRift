"""One-shot subprocess qualification. Uses neither a browser nor a local port."""
import json
import struct
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from browser_host_manifest import manifest


ID = "a" * 32
ORIGIN = f"chrome-extension://{ID}/"


def transact(path, origin, data):
    done = subprocess.run(
        [path, origin], input=data, capture_output=True, timeout=5, check=True,
    )
    assert not done.stderr
    actual_len, = struct.unpack("@I", done.stdout[:4])
    assert actual_len == len(done.stdout[4:])
    return json.loads(done.stdout[4:])


def main(path):
    payload = b'{"version":1,"kind":"selection","value":"synthetic fixture"}'
    request = struct.pack("@I", len(payload)) + payload
    assert transact(path, ORIGIN, request) == {"version": 1, "status": "captured"}
    assert transact(path, "chrome-extension://*/", request) == {"version": 1, "status": "refused"}
    assert transact(path, ORIGIN, request[:-1]) == {"version": 1, "status": "refused"}
    assert transact(path, ORIGIN, struct.pack("@I", 0xFFFFFFFF)) == {"version": 1, "status": "refused"}
    assert manifest(path, ID)["allowed_origins"] == [ORIGIN]
    for bad_id in ["*", "b" * 31, "z" * 32, ID + "/"]:
        try:
            manifest(path, bad_id)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted invalid extension ID")
    with TemporaryDirectory() as scratch:
        try:
            manifest(Path(scratch) / "missing.exe", ID)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted a nonexistent executable")
    print("Native stdio fixture: framing, origin refusal and no content echo verified")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(strict=True))

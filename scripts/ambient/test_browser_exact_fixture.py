"""Exercise the test-only host over stdio, without browser or registry changes."""

import json
import subprocess
import sys

EXPECTED = "AeRift exact synthetic selection."
ID = "a" * 32


def invoke(kind, value, extension_id=ID):
    request = json.dumps({"version": 1, "kind": kind, "value": value}).encode()
    proc = subprocess.run(
        [sys.argv[1], f"chrome-extension://{extension_id}/"],
        input=len(request).to_bytes(4, sys.byteorder) + request,
        capture_output=True,
        timeout=5,
        check=True,
    )
    assert not proc.stderr
    size = int.from_bytes(proc.stdout[:4], sys.byteorder)
    assert size == len(proc.stdout[4:])
    assert EXPECTED.encode() not in proc.stdout
    return json.loads(proc.stdout[4:])


assert invoke("selection", EXPECTED) == {"version": 1, "status": "captured"}
assert invoke("selection", EXPECTED + " decoy") == {"version": 1, "status": "refused"}
assert invoke("selection", EXPECTED, "b" * 32) == {"version": 1, "status": "refused"}
assert invoke("page", "https://example.test/") == {"version": 1, "status": "refused"}
print("Exact synthetic selection verified; other origin, value, and kind refused.")

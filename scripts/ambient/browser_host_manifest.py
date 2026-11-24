"""Generate a Chromium host manifest for an operator's deliberate qualification.
Never registers a host, starts a process, or opens/reads browser data.
"""
import argparse
import json
from pathlib import Path
import re

HOST = "com.aerift.ambient_browser"


def manifest(path: Path, extension_id: str) -> dict:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("Use an absolute path to the isolated native host executable")
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("Expected exactly one 32-letter Chromium extension ID")
    return {
        "name": HOST,
        "description": "AeRift Browser Pickup qualification host",
        "path": str(path),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--extension-id", required=True)
    args = parser.parse_args()
    print(json.dumps(manifest(args.host, args.extension_id), indent=2))


if __name__ == "__main__":
    main()

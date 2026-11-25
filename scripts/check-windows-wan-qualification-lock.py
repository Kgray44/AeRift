#!/usr/bin/env python3
"""Offline lock delta guard. Usage: python script <before.lock> <after.lock>."""
import argparse
import hashlib
import json
import tomllib
from pathlib import Path

REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
LOCAL_WAN = ("aerift-remote-wan", "0.1.0", None, None)


def identity(package):
    return (package["name"], package["version"], package.get("source"), package.get("checksum"))


def load(path):
    data = path.read_bytes()
    packages = tomllib.loads(data.decode("utf-8"))["package"]
    index = {identity(package): package for package in packages}
    if len(index) != len(packages):
        raise ValueError("Duplicate lock package identity")
    by_name = {}
    for key in index:
        by_name.setdefault(key[0], []).append(key)

    def resolve(text):
        name, *fields = text.split()
        matches = [
            key for key in by_name.get(name, ())
            if (not fields or key[1] == fields[0])
            and (len(fields) < 2 or key[2] == fields[1].strip("()"))
        ]
        if len(matches) != 1:
            raise ValueError(f"Ambiguous lock dependency {text}")
        return matches[0]

    return (
        {key: {resolve(dep) for dep in package.get("dependencies", ())}
         for key, package in index.items()},
        hashlib.sha256(data).hexdigest(),
    )


def verify(before, after):
    old, old_hash = load(before)
    new, new_hash = load(after)
    if not old.keys() <= new.keys():
        raise ValueError("Existing package identity removed or replaced")
    if any(not old[key] <= new[key] for key in old):
        raise ValueError("An existing dependency edge was removed")
    added = new.keys() - old.keys()
    if len(added) != 134 or LOCAL_WAN not in added:
        raise ValueError("Delta no longer matches the reviewed qualification inventory")
    for key in added - {LOCAL_WAN}:
        source, checksum = key[2:]
        if source != REGISTRY or not checksum or len(checksum) != 64:
            raise ValueError("New dependency lacks the expected registry/checksum")
        if any(char not in "0123456789abcdef" for char in checksum):
            raise ValueError("New dependency checksum is not canonical")
    return {
        "base_sha256": old_hash,
        "candidate_sha256": new_hash,
        "base_packages": len(old),
        "candidate_packages": len(new),
        "added": [list(key) for key in sorted(added)],
        "added_edges_to_existing_nodes": [
            [list(key[:2]), [list(dep[:2]) for dep in sorted(new[key] - old[key])]]
            for key in sorted(old) if new[key] != old[key]
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.baseline, args.candidate), indent=2))

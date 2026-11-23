#!/usr/bin/env bash
set -euo pipefail

ios_dir="$(cd "$(dirname "$0")" && pwd)"
host_dir="$(cd "${1:-apps/aerift}" && pwd)"
cd "$host_dir"
npm ci

case "$(uname -m)" in
  arm64) target=aarch64-sim ;;
  x86_64) target=x86_64 ;;
  *) echo 'Unsupported macOS architecture' >&2; exit 1 ;;
esac

bash "$ios_dir/prepare-apple.sh" "$host_dir"
npm run tauri -- ios build --ci --debug --target "$target" -- --locked

app="$(find src-tauri/gen/apple/build -type d -name 'AeRift.app' -print -quit)"
if [[ -z "$app" ]]; then
  echo 'Tauri finished without producing AeRift.app' >&2
  exit 1
fi

python3 - "$app/Info.plist" "$app/PrivacyInfo.xcprivacy" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as bundle_info:
    info = plistlib.load(bundle_info)

assert info["CFBundleIdentifier"] == "com.kgamazing44.aerift"
assert info["NSCameraUsageDescription"]
assert info["NSLocalNetworkUsageDescription"]
assert info["NSBonjourServices"] == ["_aerift._tcp"]
assert info["UIFileSharingEnabled"] is True
assert info["LSSupportsOpeningDocumentsInPlace"] is True
assert not info.get("UIBackgroundModes")
with open(sys.argv[2], "rb") as bundle_privacy:
    privacy = plistlib.load(bundle_privacy)
assert {
    "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryDiskSpace",
    "NSPrivacyAccessedAPITypeReasons": ["E174.1"],
} in privacy["NSPrivacyAccessedAPITypes"]
print("AeRift bundle privacy settings verified")
PY

device="$(xcrun simctl list devices available -j | python3 -c '
import json
import sys

runtimes = json.load(sys.stdin)["devices"]
for runtime, entries in reversed(list(runtimes.items())):
    if ".iOS-" not in runtime:
        continue
    for entry in entries:
        if entry["name"].startswith("iPhone") and entry["isAvailable"]:
            print(entry["udid"])
            sys.exit(0)
sys.exit("No available iPhone simulator")
')"
if ! xcrun simctl list devices booted | grep -F "$device" > /dev/null; then
  xcrun simctl boot "$device"
fi
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$app"
launch="$(xcrun simctl launch --terminate-running-process "$device" com.kgamazing44.aerift)"
echo "$launch"
pid="${launch##*: }"
sleep 5
xcrun simctl spawn "$device" launchctl list | awk -v pid="$pid" \
  '$1 == pid && $3 ~ /com[.]kgamazing44[.]aerift/ { found=1 } END { exit !found }'
echo "AeRift remained running on iPhone simulator $device"

verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/aerift-workspace.XXXXXX")"
trap 'rm -f "$verification_dir/verify-workspace" "$verification_dir/launch.png"; rmdir "$verification_dir"' EXIT
swiftc "$ios_dir/tests/VerifyWorkspace.swift" -o "$verification_dir/verify-workspace"

deadline=$((SECONDS + 60))
workspace_visible=0
while (( SECONDS < deadline )); do
  if xcrun simctl io "$device" screenshot "$verification_dir/launch.png" &&
     "$verification_dir/verify-workspace" "$verification_dir/launch.png"; then
    workspace_visible=1
    break
  fi
  sleep 3
done

if [[ -n "${IOS_EVIDENCE_DIR:-}" ]]; then
  mkdir -p "$IOS_EVIDENCE_DIR"
  if [[ -f "$verification_dir/launch.png" ]]; then
    cp "$verification_dir/launch.png" "$IOS_EVIDENCE_DIR/launch.png"
  fi
fi
if (( ! workspace_visible )); then
  if [[ -n "${IOS_EVIDENCE_DIR:-}" ]]; then
    xcrun simctl spawn "$device" log show --last 3m --style compact --info \
      --predicate 'process == "aerift" OR process == "AeRift" OR subsystem BEGINSWITH "com.apple.WebKit"' \
      2>&1 | tail -n 250 > "$IOS_EVIDENCE_DIR/workspace-launch.log" || true
  fi
  echo 'The iPhone workspace did not become visible after launch.' >&2
  exit 1
fi

if [[ -n "${IOS_EVIDENCE_DIR:-}" ]]; then
  python3 - "$IOS_EVIDENCE_DIR/receipt.json" "$app/Info.plist" "$device" <<'PY'
import json
import os
import plistlib
import subprocess
import sys

output, info_path, device_id = sys.argv[1:]
with open(info_path, "rb") as source:
    info = plistlib.load(source)

def command(*args):
    return subprocess.check_output(args, text=True).strip()

devices = json.loads(command("xcrun", "simctl", "list", "devices", "booted", "-j"))["devices"]
runtime, model = next(
    (runtime, device["name"])
    for runtime, entries in devices.items()
    for device in entries
    if device["udid"] == device_id
)
receipt = {
    "validation": "hosted iOS simulator",
    "appSourceCommit": os.environ.get("IOS_APP_SOURCE_COMMIT"),
    "checkedOutAppCommit": command("git", "rev-parse", "HEAD"),
    "xcode": command("xcodebuild", "-version"),
    "simulatorRuntime": runtime,
    "simulatorModel": model,
    "bundleId": info["CFBundleIdentifier"],
    "appVersion": info["CFBundleShortVersionString"],
    "installed": True,
    "launchSmokePassed": True,
    "workspaceVisible": True,
    "physicalDeviceValidated": False,
}
with open(output, "w", encoding="utf-8") as destination:
    json.dump(receipt, destination, indent=2)
    destination.write("\n")
PY
fi

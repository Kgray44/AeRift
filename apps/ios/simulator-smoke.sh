#!/usr/bin/env bash
set -euo pipefail

host_dir="$(cd "${1:-apps/aerift}" && pwd)"
cd "$host_dir"
if [[ -f package-lock.json ]]; then
  npm ci
elif node -e 'const manifest = require("../../package.json"); process.exit(manifest.workspaces?.includes("apps/aerift") ? 0 : 1)'; then
  (cd ../.. && npm ci)
else
  # The initial standalone host revision has no npm lockfile.
  npm install --no-audit --no-fund --package-lock=false
fi

case "$(uname -m)" in
  arm64) target=aarch64-sim ;;
  x86_64) target=x86_64 ;;
  *) echo 'Unsupported macOS architecture' >&2; exit 1 ;;
esac

if [[ ! -d src-tauri/gen/apple ]]; then
  npm run tauri -- ios init --ci --skip-targets-install
fi
npm run tauri -- ios build --ci --debug --target "$target"

app="$(find src-tauri/gen/apple/build -type d -name 'AeRift.app' -print -quit)"
if [[ -z "$app" ]]; then
  echo 'Tauri finished without producing AeRift.app' >&2
  exit 1
fi

python3 - "$app/Info.plist" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as bundle_info:
    info = plistlib.load(bundle_info)

assert info["CFBundleIdentifier"] == "com.aerift.app"
assert info["NSCameraUsageDescription"]
assert info["NSLocalNetworkUsageDescription"]
assert info["NSBonjourServices"] == ["_aerift._tcp"]
assert info["UIFileSharingEnabled"] is True
assert info["LSSupportsOpeningDocumentsInPlace"] is True
assert not info.get("UIBackgroundModes")
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
launch="$(xcrun simctl launch --terminate-running-process "$device" com.aerift.app)"
echo "$launch"
pid="${launch##*: }"
sleep 5
xcrun simctl spawn "$device" launchctl list | awk -v pid="$pid" \
  '$1 == pid && $3 ~ /com[.]aerift[.]app/ { found=1 } END { exit !found }'
echo "AeRift remained running on iPhone simulator $device"

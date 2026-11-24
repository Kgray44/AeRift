#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

# This script deliberately launches only its own ephemeral SDK emulator on an
# otherwise idle adb server; it never targets a phone or an existing tablet.
apk="${1:?Usage: emulator-smoke.sh DEBUG_APK}"
cpu_image="system-images;android-36;google_apis;x86_64"
avd=aerift_ci_api36
serial=emulator-5580
identity=com.kgamazing44.aerift
fixture_name=AeRift-Android-smoke.txt
tmp="$(mktemp -d)"
pid=
cleanup() {
  if [[ -n "$pid" ]]; then
    adb -s "$serial" emu kill >/dev/null 2>&1 || true
    kill "$pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'printf "Android emulator smoke failed at line %s.\n" "$LINENO" >&2' ERR

if adb devices | tail -n +2 | grep -q '[[:alnum:]]'; then
  echo 'Refusing emulator smoke: an Android device is already attached.' >&2
  exit 1
fi

avdmanager="${ANDROID_HOME:?}/cmdline-tools/latest/bin/avdmanager"
if [[ ! -x "$avdmanager" ]]; then avdmanager="$(command -v avdmanager)"; fi
emulator="$ANDROID_HOME/emulator/emulator"
export ANDROID_AVD_HOME="$tmp/avd"
mkdir -p "$ANDROID_AVD_HOME"
printf 'no\n' | "$avdmanager" create avd --force --name "$avd" --package "$cpu_image" --device pixel_6
"$emulator" -avd "$avd" -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -accel on -camera-front none -camera-back none >"$tmp/emulator.log" 2>&1 &
pid=$!
deadline=$((SECONDS + 220))
while (( SECONDS < deadline )); do
  kill -0 "$pid"
  [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null || true)" == 1 ]] && break
  sleep 2
done
[[ "$(adb -s "$serial" shell getprop sys.boot_completed)" == 1 ]]
[[ "$(adb -s "$serial" shell getprop ro.kernel.qemu)" == 1 ]]
adb -s "$serial" shell input keyevent 82
adb -s "$serial" shell settings put system screen_off_timeout 600000
adb -s "$serial" install --no-streaming "$apk"
adb -s "$serial" shell mkdir -p /sdcard/Download
printf 'AeRift Android CI: synthetic local-only selection fixture.\n' >"$tmp/$fixture_name"
adb -s "$serial" push "$tmp/$fixture_name" "/sdcard/Download/$fixture_name"
component="$(adb -s "$serial" shell cmd package resolve-activity --brief "$identity" | tail -n1)"
[[ "$component" == "$identity/"* ]]
launch="$(adb -s "$serial" shell am start -W -n "$component" | tr -d '\r')"
grep -Fx 'Status: ok' <<<"$launch"

dump_ui() {
  timeout 12s adb -s "$serial" shell uiautomator dump /sdcard/aerift-ci-window.xml >/dev/null 2>&1 &&
    adb -s "$serial" exec-out cat /sdcard/aerift-ci-window.xml > "$tmp/ui.xml"
}
locate() {
  python3 - "$tmp/ui.xml" "$1" <<'PY'
import re, sys
from xml.etree import ElementTree as ET
path, label = sys.argv[1:]
try:
    root = ET.parse(path)
except (ET.ParseError, OSError):
    raise SystemExit(1)
for node in root.iter("node"):
    if label in (node.get("text"), node.get("content-desc")):
        points = [int(part) for part in re.findall(r"\d+", node.get("bounds", ""))]
        if len(points) == 4 and points[2] > points[0] and points[3] > points[1]:
            print((points[0] + points[2]) // 2, (points[1] + points[3]) // 2)
            sys.exit(0)
raise SystemExit(1)
PY
}
await_ui() {
  local label="$1" tries="${2:-12}" coordinates i
  for ((i = 0; i < tries; i++)); do
    if dump_ui && coordinates="$(locate "$label")"; then printf '%s\n' "$coordinates"; return 0; fi
    sleep 1
  done
  echo "Android UI did not show: $label" >&2
  return 1
}
tap_label() {
  local hit x y
  hit="$(await_ui "$1" "${2:-12}")"
  read -r x y <<<"$hit"
  adb -s "$serial" shell input tap "$x" "$y"
}

# No pairing, permission overrides, real devices, camera or file offer here.
# These assertions use public accessibility labels on the production WebView.
await_ui 'Your portable workspace' >/dev/null
tap_label 'Open Workspace'
tap_label 'Choose for Rift'
if ! await_ui "$fixture_name" 2 >/dev/null; then
  if ! tap_label 'Show roots' 2; then tap_label 'Open navigation drawer' 2; fi
  tap_label 'Downloads' 5
fi
tap_label "$fixture_name"
await_ui 'Ready for Rift' >/dev/null
await_ui "$fixture_name" >/dev/null
adb -s "$serial" shell pidof "$identity" >/dev/null
printf 'Android API %s: production workspace launched; system Files picker staged synthetic fixture; no send issued.\n' \
  "$(adb -s "$serial" shell getprop ro.build.version.sdk)"

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
# Use the supported direct software backend; swiftshader_indirect is deprecated.
gpu=swiftshader
assert_emulator_alive() {
  local phase="$1" status
  if status="$(ps -o stat= -p "$pid" 2>/dev/null)" &&
    [[ "$status" =~ ^[[:space:]]*[^ZX[:space:]] ]]; then
    return 0
  fi
  printf 'Android emulator process stopped during %s (PID %s, GPU %s).\n' "$phase" "$pid" "$gpu" >&2
  if [[ -s "$tmp/emulator.log" ]]; then
    echo '--- final Android emulator output ---' >&2
    tail -n 40 "$tmp/emulator.log" >&2
  fi
  return 1
}
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
if [[ -w /dev/kvm ]]; then accel=on; else accel=off; fi
# SDK metadata is informational. The non-headless -version command loads
# desktop audio libraries that the actual headless runner does not need.
release="$(sed -n 's/^Pkg\.Revision[[:space:]]*=[[:space:]]*//p' "$(dirname "$emulator")/source.properties" 2>/dev/null | head -n 1 || true)"
printf 'Android SDK emulator revision: %s.\n' "${release:-unknown}"
printf 'Android emulator: GPU %s, VM acceleration %s.\n' "$gpu" "$accel"
"$emulator" -avd "$avd" -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu "$gpu" -accel "$accel" -camera-front none -camera-back none >"$tmp/emulator.log" 2>&1 &
pid=$!
boot_budget=220
[[ "$accel" == on ]] || boot_budget=650
deadline=$((SECONDS + boot_budget))
while (( SECONDS < deadline )); do
  assert_emulator_alive "boot"
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
perf="${AERIFT_PERF_OBSERVE:-0}"
monotonic_ms() { python3 -c 'import time; print(time.monotonic_ns() // 1_000_000)'; }
if [[ "$perf" == 1 ]]; then
  observe_started="$(monotonic_ms)"
fi
launch="$(adb -s "$serial" shell am start -W -n "$component" | tr -d '\r')"
grep -Fx 'Status: ok' <<<"$launch"
if [[ "$perf" == 1 ]]; then
  activity_time="$(awk '/^TotalTime: [0-9]+$/ { print $2 }' <<<"$launch")"
  if [[ "$activity_time" =~ ^[0-9]+$ ]]; then
    printf 'AERIFT_PERF startup.android.activity-manager-total=%s\n' "$activity_time"
  fi
fi

dump_ui() {
  timeout 12s adb -s "$serial" shell uiautomator dump /sdcard/aerift-ci-window.xml >/dev/null 2>&1 &&
    adb -s "$serial" exec-out cat /sdcard/aerift-ci-window.xml > "$tmp/ui.xml"
}
locate() {
  python3 - "$tmp/ui.xml" "$1" "${2:-}" <<'PY'
import re, sys
from xml.etree import ElementTree as ET
path, label, package = sys.argv[1:]
try:
    root = ET.parse(path)
except (ET.ParseError, OSError):
    raise SystemExit(1)
for node in root.iter("node"):
    if package and node.get("package") != package:
        continue
    if label in (node.get("text"), node.get("content-desc")):
        points = [int(part) for part in re.findall(r"\d+", node.get("bounds", ""))]
        if len(points) == 4 and points[2] > points[0] and points[3] > points[1]:
            print((points[0] + points[2]) // 2, (points[1] + points[3]) // 2)
            sys.exit(0)
raise SystemExit(1)
PY
}
await_ui() {
  local label="$1" tries="${2:-12}" package="${3:-}" coordinates i
  for ((i = 0; i < tries; i++)); do
    assert_emulator_alive "waiting for $label" || return 1
    if dump_ui && coordinates="$(locate "$label" "$package")"; then
      assert_emulator_alive "confirming $label" || return 1
      printf '%s\n' "$coordinates"
      return 0
    fi
    assert_emulator_alive "waiting for $label" || return 1
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

# UIAutomator can report an in-viewport WebView node whose center is behind
# the fixed glass dock. Derive a conservative tap window from the *app's*
# current accessibility tree, rather than assuming a particular emulator DPI.
app_tap_window() {
  python3 - "$tmp/ui.xml" "$identity" <<'PYWINDOW'
import re
import sys
from xml.etree import ElementTree as ET

path, package = sys.argv[1:]
root = ET.parse(path)
frames = []
for node in root.iter("node"):
    if node.get("package") != package:
        continue
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    if match:
        left, top, right, bottom = map(int, match.groups())
        if right > left and bottom > top:
            frames.append((left, top, right, bottom))
if not frames:
    raise SystemExit("Android UI hierarchy is not in the AeRift app")
left, top, right, bottom = max(frames, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
height = bottom - top
print(left, top, right, top + 3 * height // 4, (left + right) // 2, top + height // 2)
PYWINDOW
}

tap_workspace_category() {
  local label="$1" hit x y left top right safe_bottom swipe_x swipe_end scroll
  for scroll in 0 1 2; do
    hit="$(await_ui "$label" 12 "$identity")" || return 1
    read -r x y <<<"$hit"
    read -r left top right safe_bottom swipe_x swipe_end <<<"$(app_tap_window)" || return 1
    if (( x >= left && x < right && y >= top && y < safe_bottom )); then
      adb -s "$serial" shell input tap "$x" "$y"
      return
    fi
    (( scroll < 2 && x >= left && x < right && y >= safe_bottom )) || break
    printf 'Android workspace category center below safe tap window (%s >= %s); scrolling.\n' "$y" "$safe_bottom"
    adb -s "$serial" shell input swipe "$swipe_x" "$safe_bottom" "$swipe_x" "$swipe_end" 320 || return 1
  done
  printf 'Android workspace category not tappable above dock: %s (center %s,%s; safe bottom %s).\n' \
    "$label" "$x" "$y" "$safe_bottom" >&2
  return 1
}

# No pairing, permission overrides, real devices, camera or file offer here.
# These assertions use public accessibility labels on the production WebView.
await_ui 'Your portable workspace' >/dev/null
if [[ "$perf" == 1 ]]; then
  printf 'AERIFT_PERF startup.android.workspace-observed=%d\n' "$(( $(monotonic_ms) - observe_started ))"
fi
tap_label 'Open Workspace'
tap_workspace_category 'File Browser'
await_ui 'Choose a file' 12 "$identity" >/dev/null
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

if [[ "$perf" == 1 ]]; then
  # Our own verified SDK emulator only. Forced app exit is not graceful
  # teardown or evidence of camera, WebView, listener, or process pairs.
  exit_started="$(monotonic_ms)"
  if timeout 5s adb -s "$serial" shell am force-stop "$identity" &&
    [[ "$(timeout 5s adb -s "$serial" shell "pidof $identity || echo absent")" == absent ]]; then
    printf 'AERIFT_PERF teardown.android.force-stopped-app-exit-observed=%d\n' "$(( $(monotonic_ms) - exit_started ))"
  fi
fi

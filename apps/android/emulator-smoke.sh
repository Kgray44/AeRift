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
photos="${AERIFT_SMOKE_PHOTOS:-0}"
[[ "$photos" == 0 || ( "$photos" == 1 && "${RUNNER_ENVIRONMENT:-}" == github-hosted ) ]] ||
  { echo 'Photos smoke requires an explicitly opted-in GitHub-hosted runner.' >&2; exit 1; }
photo_forward=
photo_uri=
tmp="$(mktemp -d)"
pid=
cleanup() {
  if [[ -n "$pid" ]]; then
    if [[ "$photo_forward" =~ ^[0-9]+$ ]]; then adb -s "$serial" forward --remove "tcp:$photo_forward" >/dev/null 2>&1 || true; fi
    if [[ "$photo_uri" =~ ^content://media/external_primary/images/media/[0-9]+$ ]]; then
      adb -s "$serial" shell content delete --uri "$photo_uri" >/dev/null 2>&1 || true
    fi
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
"$emulator" -avd "$avd" -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -accel "$accel" -camera-front none -camera-back none >"$tmp/emulator.log" 2>&1 &
pid=$!
boot_budget=220
[[ "$accel" == on ]] || boot_budget=650
deadline=$((SECONDS + boot_budget))
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
if [[ "$perf" == 1 ]]; then
  printf 'AERIFT_PERF startup.android.workspace-observed=%d\n' "$(( $(monotonic_ms) - observe_started ))"
fi
tap_label 'Open Workspace'
tap_label 'File Browser'
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

if [[ "$photos" == 1 ]]; then
  stage=starting
  photo_stage() {
    stage="$1"
    printf 'Android Photos smoke: %s.\n' "$stage"
  }
  trap 'printf "Android Photos smoke failed in %s (line %s).\n" "$stage" "$LINENO" >&2' ERR
  photo_stage 'verify disposable API 36 and disable radios'
  # A second synthetic-only journey on the same owned emulator. Seed the
  # system MediaStore as shell; no generic URI/path is passed to AeRift.
  [[ "$(adb -s "$serial" shell getprop ro.build.version.sdk)" == 36 ]]
  adb -s "$serial" shell svc wifi disable
  adb -s "$serial" shell svc data disable
  photo_name=AeRift-Android-photo-smoke.png
  collection=content://media/external_primary/images/media
  python3 - "$tmp/$photo_name" <<'PY_PNG'
import struct, sys, zlib
def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
width, height = 512, 320
rows = b"".join(b"\x00" + bytes((30, 105, 227) if y < height // 2 else (232, 100, 56)) * width for y in range(height))
with open(sys.argv[1], "wb") as image:
    image.write(b"\x89PNG\x0D\x0A\x1A\x0A" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
PY_PNG
  # The API 36 image's content CLI does not accept --extra for query.
  # MediaStore.setIncludePending() appends this URI parameter, which AOSP's
  # MediaProvider translates to MATCH_INCLUDE. This stays fixture-only.
  # https://android.googlesource.com/platform/packages/providers/MediaProvider/+/57c15117b/apex/framework/java/android/provider/MediaStore.java
  # https://android.googlesource.com/platform/packages/providers/MediaProvider/+/f24cf9963/src/com/android/providers/media/MediaProvider.java
  pending_collection="${collection}?includePending=1"
  lookup_photos() {
    local output error="$tmp/media-query.err" status=0
    output="$(adb -s "$serial" shell content query --uri "'$1'" --projection '_id:_display_name:is_pending' \
       2>"$error" | tr -d '\r')" || status=$?
    # AOSP content can report parser/provider failures without a nonzero exit
    # status. Classify only: never print raw media rows or provider output.
    local kind=unrecognized
    if grep -Eq 'SecurityException|Permission Denial' "$error" - <<<"$output"; then
      kind=permission-denied
    elif grep -Eq 'Unsupported argument|Unsupported operation|^usage:' "$error" - <<<"$output"; then
      kind=unsupported-cli
    elif grep -Eq 'IllegalArgumentException|Exception|Error while accessing provider' "$error" - <<<"$output"; then
      kind=provider-error
    elif (( status != 0 )) || [[ -s "$error" ]]; then
      kind=adb-or-provider-error
    elif [[ "$output" == 'No result found.' ]]; then
      printf '%s\n' "$output"; return 0
    elif [[ "$output" =~ ^Row:[[:space:]] ]]; then
      printf '%s\n' "$output"; return 0
    elif [[ -z "$output" ]]; then
      kind=no-output
    fi
    printf 'Android Photos smoke: MediaStore query failed (%s).\n' "$kind" >&2
    return 1
  }
  photo_stage 'confirm visible MediaStore image inventory is empty'
  if ! row="$(lookup_photos "$collection")"; then exit 1; fi
  if [[ "$row" != 'No result found.' ]]; then
    echo 'Refusing Photos smoke: the fresh MediaStore already has visible images.' >&2
    exit 1
  fi
  photo_stage 'confirm MediaStore image inventory including pending is empty'
  if ! row="$(lookup_photos "$pending_collection")"; then exit 1; fi
  if [[ "$row" != 'No result found.' ]]; then
    echo 'Refusing Photos smoke: the fresh MediaStore already has pending images.' >&2
    exit 1
  fi
  photo_stage 'insert exactly one synthetic pending image'
  adb -s "$serial" shell content insert --uri "$collection" \
    --bind "_display_name:s:$photo_name" --bind mime_type:s:image/png \
    --bind relative_path:s:Pictures/AeRift-CI/ --bind is_pending:i:1 >"$tmp/media-insert.out" 2>"$tmp/media-insert.err"
  if ! row="$(lookup_photos "$pending_collection")"; then exit 1; fi
  if ! [[ "$row" =~ ^Row:[[:space:]]0[[:space:]]_id=([0-9]+),[[:space:]]_display_name=AeRift-Android-photo-smoke\.png,[[:space:]]is_pending=1$ ]]; then
    echo 'Refusing Photos smoke: insert did not yield exactly the owned synthetic fixture.' >&2
    exit 1
  fi
  photo_id="${BASH_REMATCH[1]}"
  photo_uri="$collection/$photo_id"
  # Prove the pending URI changed what the provider exposed, not merely that
  # it accepted an ignored query parameter. No picker opens on discrepancy.
  if ! row="$(lookup_photos "$collection")"; then exit 1; fi
  if [[ "$row" != 'No result found.' ]]; then
    echo 'Refusing Photos smoke: a pending fixture became visible before publication.' >&2
    exit 1
  fi
  photo_stage 'publish and verify fixture bytes'
  adb -s "$serial" shell -T content write --uri "$photo_uri" < "$tmp/$photo_name"
  adb -s "$serial" shell content update --uri "$photo_uri" --bind is_pending:i:0
  if ! row="$(lookup_photos "$collection")"; then exit 1; fi
  if [[ "$row" != "Row: 0 _id=$photo_id, _display_name=$photo_name, is_pending=0" ]]; then
    echo 'Refusing Photos smoke: the owned synthetic fixture is not the sole published image.' >&2
    exit 1
  fi
  adb -s "$serial" exec-out content read --uri "$photo_uri" > "$tmp/source-before.png"
  cmp "$tmp/$photo_name" "$tmp/source-before.png"

  photo_stage 'open Photos through AeRift Workspace'
  tap_label 'Workspace'
  tap_label 'Images & Videos'
  tap_label 'Import photos and videos'
  tap_photo_picker() {
    local action="$1" i hit x y
    for ((i = 0; i < 12; i++)); do
      if dump_ui && hit="$(python3 apps/android/photo_picker_ui.py "$tmp/ui.xml" "$action")"; then
        read -r x y <<< "$hit"
        adb -s "$serial" shell input tap "$x" "$y"
        return 0
      fi
      sleep 1
    done
    echo "System Photos picker did not expose a unique $action action." >&2; return 1
  }
  photo_stage 'select fixture and explicitly commit through system picker'
  tap_photo_picker photo
  tap_photo_picker commit
  photo_stage 'verify exact imported fixture and close its preview'
  tap_label "Open $photo_name"
  await_ui 'Close photo' >/dev/null
  tap_label 'Close photo'

  # WebView debugging on the existing debug build is observation only. An
  # app-process-owned local socket is forwarded briefly; no remote network.
  photo_stage 'verify bounded native thumbnail in app WebView'
  process="$(adb -s "$serial" shell pidof "$identity" | tr -d '\r')"
  [[ "$process" =~ ^[0-9]+$ ]]
  package_dump="$(adb -s "$serial" shell dumpsys package "$identity")"
  grep -Eq 'pkgFlags=\[[^]]*[[:space:]]DEBUGGABLE([[:space:]]|])' <<<"$package_dump"
  photo_forward="$(adb -s "$serial" forward tcp:0 "localabstract:webview_devtools_remote_$process" | tr -d '\r')"
  [[ "$photo_forward" =~ ^[0-9]+$ ]]
  node apps/android/emulator-photo-observer.mjs "$photo_forward" imported

  tap_label "Open $photo_name"
  photo_stage 'confirm removal then verify original MediaStore bytes'
  tap_label 'Remove imported copy'
  await_ui 'Confirm remove imported copy' >/dev/null
  tap_label 'Confirm remove imported copy'
  node apps/android/emulator-photo-observer.mjs "$photo_forward" removed
  adb -s "$serial" exec-out content read --uri "$photo_uri" > "$tmp/source-after.png"
  cmp "$tmp/$photo_name" "$tmp/source-after.png"
  trap 'printf "Android emulator smoke failed at line %s.\n" "$LINENO" >&2' ERR
  printf 'Android API 36: native Photo Picker imported synthetic PNG; bounded 256x160 thumbnail decoded; user-confirmed copy removal preserved original bytes.\n'
fi

if [[ "$perf" == 1 ]]; then
  # Our own verified SDK emulator only. Forced app exit is not graceful
  # teardown or evidence of camera, WebView, listener, or process pairs.
  exit_started="$(monotonic_ms)"
  if timeout 5s adb -s "$serial" shell am force-stop "$identity" &&
    [[ "$(timeout 5s adb -s "$serial" shell "pidof $identity || echo absent")" == absent ]]; then
    printf 'AERIFT_PERF teardown.android.force-stopped-app-exit-observed=%d\n' "$(( $(monotonic_ms) - exit_started ))"
  fi
fi

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

  photo_stage 'return from File Browser to the Workspace category library'
  # The Files smoke publicly selects a document without leaving File Browser.
  # Tapping the already-selected Workspace dock tab does not clear that category.
  tap_label 'Back to Workspace'
  await_ui 'Everything in its place.' >/dev/null
  photo_stage 'open Photos through AeRift Workspace'
  # Bind every AX capture and coordinate action to the actual app Activity
  # being resumed AND its window being focused. Require exact component
  # identity (normalize the short and full names Android can report).
  # AOSP android-16.0.0_r1 Task.dumpInner reports topResumedActivity=.
  # The separate "Resumed:" focused-area summary may fall back to pausing.
  gallery_focused() {
    local activity window
    activity="$(timeout 5s adb -s "$serial" shell dumpsys activity activities)" || return 1
    window="$(timeout 5s adb -s "$serial" shell dumpsys window displays)" || return 1
    awk -v expected="$component" '
      function full(value, parts) {
        if (split(value, parts, "/") != 2) return ""
        return parts[1] "/" (substr(parts[2], 1, 1) == "." ? parts[1] : "") parts[2]
      }
      /^[[:space:]]*topResumedActivity=ActivityRecord[{}[:space:]]/ {
        for (i = 1; i <= NF; i++) if ($i == "u0") {
          live++; if (full($(i+1)) == full(expected)) app++
        }
      }
      # API 36 may repeat display 0 with the same Window token. Accept
      # identical reports, not ambiguity: every section gets exactly one
      # consistent focus field and every non-null row must identify the
      # same primary-user app window. The input coordinates target display 0.
      /^[[:space:]]*Display: mDisplayId=[0-9]+([[:space:]]|$)/ {
        section++
        display = $2; sub(/^mDisplayId=/, "", display)
        if (display == "0") defaultDisplay[section] = 1
      }
      /^[[:space:]]*mCurrentFocus=/ {
        if (!section) { bad++; next }
        focusFields[section]++
        if ($0 ~ /^[[:space:]]*mCurrentFocus=null[[:space:]]*$/) next
        if ($1 !~ /^mCurrentFocus=Window[{][a-fA-F0-9]+$/) { bad++; next }
        matching = 0
        for (i = 1; i < NF; i++) if ($i == "u0") {
          value = $(i+1); sub(/}$/, "", value)
          if (full(value) == full(expected)) matching++
        }
        if (matching != 1) { bad++; next }
        if (token != "" && token != $1) bad++
        token = $1
        if (defaultDisplay[section]) ownedDefaults++
      }
      END {
        for (i = 1; i <= section; ++i) {
          if (focusFields[i] != 1) bad++
          if (defaultDisplay[i]) ++defaultDisplays
        }
        exit !(live == 1 && app == 1 && defaultDisplays >= 1 &&
               ownedDefaults == defaultDisplays && bad == 0)
      }
    ' <<<"$activity"$'\n'"$window"
  }
  gallery_ax() { python3 apps/android/photo_gallery_ui.py "$tmp/ui.xml" "$identity" "$@"; }
  gallery_capture() {
    rm -f "$tmp/ui.xml"
    gallery_focused && dump_ui && gallery_focused || { rm -f "$tmp/ui.xml"; return 1; }
  }
  gallery_report() {
    if ! gallery_focused; then
      echo 'Owned Photos Activity and focused window identity not jointly confirmed.' >&2
      # Evidence only: retain the exact owner guard. Do not print dump text,
      # identifiers, coordinates, package names, or labels from arbitrary windows.
      local activity_observation window_observation global_observation
      if activity_observation="$(timeout 5s adb -s "$serial" shell dumpsys activity activities)" &&
         window_observation="$(timeout 5s adb -s "$serial" shell dumpsys window displays)" &&
         global_observation="$(timeout 5s adb -s "$serial" shell dumpsys window)"; then
        awk '/^[[:space:]]*mTopFocusedDisplayId=/ { seen++; if ($0 ~ /=0[[:space:]]*$/) primary++ }
          END { printf "Photos global focus top-labels=%d default-top=%d\n", seen, primary }' <<<"$global_observation" >&2
        awk -v expected="$component" '
          function full(value, parts) {
            if (split(value, parts, "/") != 2) return ""
            return parts[1] "/" (substr(parts[2], 1, 1) == "." ? parts[1] : "") parts[2]
          }
          function count_owner(kind, i, value) {
            total[kind]++
            for (i = 1; i < NF; ++i) if ($i == "u0") {
              value = $(i+1); sub(/}$/, "", value)
              primary[kind]++
              if (full(value) == full(expected)) owned[kind]++
            }
          }
          /^[[:space:]]*ResumedActivity:[[:space:]]+ActivityRecord/ { count_owner("legacy") }
          /^[[:space:]]*Resumed:[[:space:]]+ActivityRecord/ { count_owner("summary") }
          /^[[:space:]]*topResumedActivity=ActivityRecord/ { count_owner("top") }
          /^[[:space:]]*Display: mDisplayId=[0-9]+([[:space:]]|$)/ {
            section = ($2 == "mDisplayId=0" ? "default" : "secondary")
            display_headers[section]++
          }
          /^[[:space:]]*mTopFocusedDisplayId=/ {
            top_labels++
            if ($0 ~ /mTopFocusedDisplayId=0[[:space:]]*$/) top_default++
          }
          /^[[:space:]]*mCurrentFocus=/ {
            bucket = section == "" ? "unrecognized" : section
            focus_fields[bucket]++
            if ($0 ~ /^[[:space:]]*mCurrentFocus=null[[:space:]]*$/) empty_fields[bucket]++
            if ($0 ~ /^[[:space:]]*mCurrentFocus=Window[{]/) {
              focus_windows[bucket]++
              value = $1; sub(/^mCurrentFocus=Window[{]/, "", value)
              if (value ~ /^[a-fA-F0-9]+$/) window_ids[value] = 1
            }
          }
          /^[[:space:]]*mCurrentFocus=Window/ { count_owner("window") }
          /^[[:space:]]*mFocusedApp=ActivityRecord/ { count_owner("app") }
          END {
            buckets[1]="default"; buckets[2]="secondary"; buckets[3]="unrecognized"
            for (i = 1; i <= 3; ++i) {
              b = buckets[i]
              printf "Photos focus shape %s sections=%d fields=%d windows=%d null=%d\n",
                b, display_headers[b], focus_fields[b], focus_windows[b], empty_fields[b]
            }
            for (id in window_ids) distinct++
            printf "Photos focus shape distinct-window-tokens=%d top-display-labels=%d default-top=%d\n",
              distinct, top_labels, top_default
            kinds[1] = "legacy"; kinds[2] = "summary"; kinds[3] = "top";
            kinds[4] = "window"; kinds[5] = "app";
            for (i = 1; i <= 5; ++i) {
              kind = kinds[i];
              printf "Photos guard diagnostic %s rows=%d primary-user=%d exact=%d\n",
                kind, total[kind], primary[kind], owned[kind]
            }
          }
        ' <<<"$activity_observation"$'\n'"$window_observation" >&2
      else
        echo 'Photos guard diagnostic: bounded dumpsys collection unavailable.' >&2
      fi
    else
      gallery_capture && gallery_ax report || true
    fi
  }
  category_opened=0
  for ((attempt = 0; attempt < 6; attempt++)); do
    if gallery_capture && hit="$(locate 'Images & Videos' "$identity")" && gallery_focused; then
      read -r x y <<<"$hit"
      adb -s "$serial" shell input tap "$x" "$y"
      category_opened=1
      break
    fi
    sleep 1
  done
  if [[ "$category_opened" != 1 ]]; then
    gallery_report
    echo 'Android Photos smoke refused an unowned or missing Photos category target.' >&2; exit 1
  fi
  confirmed=0
  for ((attempt = 0; attempt < 6; attempt++)); do
    if gallery_capture && gallery_ax confirm; then confirmed=1; break; fi
    sleep 1
  done
  if [[ "$confirmed" != 1 ]]; then
    gallery_report
    echo 'Android Photos smoke did not confirm the owned Photos category.' >&2; exit 1
  fi
  # The selected Rift object and system picker card precede the imported
  # gallery. Seek its real accessible action by scrolling the owned WebView.
  photo_stage 'seek the imported gallery action on the owned Photos category'
  found=0
  for ((attempt = 0; attempt < 7; attempt++)); do
    if gallery_capture; then
      if hit="$(gallery_ax target)" && gallery_focused; then
        read -r x y <<<"$hit"
        adb -s "$serial" shell input tap "$x" "$y"
        found=1
        break
      fi
      if (( attempt >= 1 && attempt < 6 )) && hit="$(gallery_ax scroll)" && gallery_focused; then
        read -r x1 y1 x2 y2 <<<"$hit"
        adb -s "$serial" shell input swipe "$x1" "$y1" "$x2" "$y2" 350
      fi
    fi
    sleep 1
  done
  if [[ "$found" != 1 ]]; then
    gallery_report
    echo 'Android Photos smoke did not find an enabled, unique, owned gallery import action.' >&2; exit 1
  fi
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
  # Android's Photo Picker may return the source display name or its AOSP
  # picker alias <selected local media ID>.<MIME extension>. The ID here
  # was verified above as the only local image, and the radios are off.
  # https://android.googlesource.com/platform/packages/providers/MediaProvider/+/0a212c65f2e4aef9cc7720161b339460b42696c2/src/com/android/providers/media/photopicker/data/PickerDbFacade.java
  tap_imported_fixture() {
    local i hit x y mode
    for ((i = 0; i < 12; i++)); do
      if gallery_capture && hit="$(gallery_ax imported "$photo_id" "$@")" && gallery_focused; then
        read -r x y mode <<<"$hit"
        [[ "$mode" == original || "$mode" == picker ]] || return 1
        adb -s "$serial" shell input tap "$x" "$y" || return 1
        photo_name_mode="$mode"
        return 0
      fi
      sleep 1
    done
    gallery_report
    echo 'Android Photos smoke did not find one enabled owned tile with an exact fixture name or exact picker alias.' >&2
    return 1
  }
  photo_stage 'verify exact imported fixture and close its preview'
  tap_imported_fixture
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
  node apps/android/emulator-photo-observer.mjs "$photo_forward" imported "$photo_id" "$photo_name_mode"

  tap_imported_fixture "$photo_name_mode"
  photo_stage 'confirm removal then verify original MediaStore bytes'
  tap_owned_removal_action() {
    local action="$1" i hit x y
    for ((i = 0; i < 6; i++)); do
      if gallery_capture && hit="$(gallery_ax "$action")" && gallery_focused; then
        read -r x y <<<"$hit"
        adb -s "$serial" shell input tap "$x" "$y"
        return
      fi
      sleep 1
    done
    gallery_report
    echo "Android Photos smoke could not locate one owned removal button ($action)." >&2
    return 1
  }
  photo_stage 'tap owned Remove imported copy button'
  tap_owned_removal_action remove
  photo_stage 'tap owned Confirm remove imported copy button'
  tap_owned_removal_action confirm-remove
  photo_stage 'verify removed Android import and unchanged original'
  node apps/android/emulator-photo-observer.mjs "$photo_forward" removed "$photo_id" "$photo_name_mode"
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

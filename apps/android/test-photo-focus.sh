#!/usr/bin/env bash
set -euo pipefail
# Exercise the exact adb-output guard used in the disposable SDK emulator smoke.
cd "$(dirname "$0")"
eval "$(sed -n '/^  gallery_focused() {$/,/^  }$/p' emulator-smoke.sh)"
component='com.example.aerift/.MainActivity'
serial='emulator-5580'
active='  topResumedActivity=ActivityRecord{123 u0 com.example.aerift/.MainActivity t1}'
own='    mCurrentFocus=Window{ab u0 com.example.aerift/com.example.aerift.MainActivity}'
foreign='    mCurrentFocus=Window{cd u0 com.example.foreign/.OtherActivity}'
base='  Display: mDisplayId=0'
secondary='  Display: mDisplayId=1 (organized)'
timeout() {
  case "${*: -2}" in
    'activity activities') printf '%s\n' "$activity_fixture";;
    'window displays') printf '%s\n' "$window_fixture";;
    *) return 3;;
  esac
}
check() {
  local want="$1" name="$2" activity_fixture="$3" window_fixture="$4" actual=reject
  if gallery_focused; then actual=allow; fi
  if [[ "$want" != "$actual" ]]; then
    printf 'FAIL %s: expected %s, got %s\n' "$name" "$want" "$actual" >&2
    return 1
  fi
  printf 'PASS %s\n' "$name"
}
check allow 'default display exact' "$active" "$base"$'\n'"$own"
check allow 'secondary display repeats owned focus' "$active" "$secondary"$'\n'"$own"$'\n'"$base"$'\n'"$own"
check reject 'secondary focus cannot substitute for default' "$active" "$base"$'\n    mCurrentFocus=null\n'"$secondary"$'\n'"$own"
check reject 'another focused component' "$active" "$base"$'\n'"$own"$'\n'"$secondary"$'\n'"$foreign"
check reject 'foreign default' "$active" "$base"$'\n'"$foreign"$'\n'"$secondary"$'\n'"$own"
check reject 'duplicate default display row' "$active" "$base"$'\n'"$own"$'\n'"$base"$'\n'"$own"
check reject 'unknown display ownership' "$active" "$own"
check reject 'nonprimary user on default' "$active" "$base"$'\n'"${own/u0/u10}"
check reject 'paused activity' "${active/topResumedActivity/PausedActivity}" "$base"$'\n'"$own"

#!/usr/bin/env bash
set -euo pipefail
tool_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "$tool_dir/../.." && pwd)"
mode="${1:-debug}"
case "$mode" in
  debug) targets=(x86_64); flags=(--debug --apk true --aab false);;
  release)
    targets=(aarch64 x86_64)
    flags=(--apk true --aab true)
    if [[ -n "${AERIFT_ANDROID_VERSION_CODE:-}" ]]; then
      [[ "$AERIFT_ANDROID_VERSION_CODE" =~ ^[1-9][0-9]{0,9}$ ]] &&
        (( AERIFT_ANDROID_VERSION_CODE <= 2100000000 )) || exit 2
      flags+=(--config "{\"bundle\":{\"android\":{\"versionCode\":$AERIFT_ANDROID_VERSION_CODE}}}")
    fi
    ;;
  *) echo 'Usage: build-android.sh [debug|release]' >&2; exit 2;;
esac
bash "$tool_dir/prepare-android.sh"
cd "$root/apps/aerift"
npm run tauri -- android build --ci --target "${targets[@]}" "${flags[@]}"

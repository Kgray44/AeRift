#!/usr/bin/env bash
set -euo pipefail
android_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$android_dir/../.." && pwd)"
host="$repo/apps/aerift"
project="$host/src-tauri/gen/android"

: "${ANDROID_HOME:?`ANDROID_HOME` must point at the Android SDK}"
: "${NDK_HOME:?`NDK_HOME` must point at the pinned Android NDK}"
grep -Eq '^[[:space:]]*Pkg.Revision[[:space:]]*=[[:space:]]*29[.]0[.]14206865[[:space:]]*$' "$NDK_HOME/source.properties" || {
  echo 'Expected Android NDK 29.0.14206865.' >&2; exit 1;
}
test -f "$ANDROID_HOME/platforms/android-36/android.jar"
test -x "$ANDROID_HOME/build-tools/36.0.0/apksigner"
node -e 'const cli = require(process.argv[1]); if(cli.version !== "2.9.0") process.exit(1)' "$repo/node_modules/@tauri-apps/cli/package.json"

cd "$host"
if [[ ! -f "$project/app/build.gradle.kts" ]]; then
  npm run tauri -- android init --ci --skip-targets-install
fi
test -f "$project/app/src/main/AndroidManifest.xml"
grep -Fq 'gradle-8.14.3-bin.zip' "$project/gradle/wrapper/gradle-wrapper.properties"
grep -Eq '^[[:space:]]*compileSdk[[:space:]]*=[[:space:]]*36[[:space:]]*$' "$project/app/build.gradle.kts"
grep -Eq '^[[:space:]]*targetSdk[[:space:]]*=[[:space:]]*36[[:space:]]*$' "$project/app/build.gradle.kts"

python3 "$android_dir/stage-host.py" "$project" "$android_dir/overlay"

# The native MediaPipe provider consumes the same bytes as the existing gesture
# runtime. Use an absolute cap, a pinned SHA-256 and atomic cache replacement.
node "$android_dir/stage-camera-assets.mjs" "$host"

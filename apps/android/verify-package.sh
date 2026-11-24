#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

apk="${1:?Usage: verify-package.sh APK [EXPECTED_VERSION_CODE]}"
expected_version_code="${2:-}"
expected_package='com.kgamazing44.aerift'
: "${ANDROID_HOME:?Android SDK required}"
: "${NDK_HOME:?Android NDK required}"
tools="$ANDROID_HOME/build-tools/36.0.0"
badging="$("$tools/aapt2" dump badging "$apk")"
grep -E "^package: name='$expected_package'" <<<"$badging"
grep -Fx "targetSdkVersion:'36'" <<<"$badging"
if [[ -n "$expected_version_code" ]]; then
  grep -F "versionCode='$expected_version_code'" <<<"$badging"
fi
# The selected application launch icon must come from the approved overlay,
# not merely coexist next to the generator's template resources.
resources="$("$tools/aapt2" dump resources "$apk")"
grep -Eq '[[:space:]]mipmap/aerift_launcher([[:space:]]|$)' <<<"$resources"
grep -Eq '[[:space:]]mipmap/aerift_launcher_foreground([[:space:]]|$)' <<<"$resources"
manifest="$("$tools/aapt2" dump xmltree --file AndroidManifest.xml "$apk")"
icon_id="$(awk '/ mipmap\/aerift_launcher([[:space:]]|$)/ { print $2; exit }' <<<"$resources")"
test -n "$icon_id"
grep -E "android:icon[^=]*=@${icon_id}" <<<"$manifest"
grep -E "android:roundIcon[^=]*=@${icon_id}" <<<"$manifest"
# Keep Android's system picker model: no broad device-wide storage permission.
permissions="$("$tools/aapt2" dump permissions "$apk")"
if grep -Eq 'android[.]permission[.](MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_MEDIA_IMAGES|READ_MEDIA_VIDEO)' <<<"$permissions"; then
  echo 'Unexpected broad Android file or media permission.' >&2
  exit 1
fi
# Verify the result, not just the presence of 16 KB-aware build tooling.
"$tools/zipalign" -c -P 16 4 "$apk"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unzip -q "$apk" 'lib/*/*.so' -d "$tmp"
objdump=("$NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-objdump)
test "${#objdump[@]}" -eq 1
test -x "${objdump[0]}"
find "$tmp/lib" -type f -name '*.so' -print > "$tmp/libraries"
test -s "$tmp/libraries"
while IFS= read -r lib; do
  "${objdump[0]}" -p "$lib" | python3 -c '
import re, sys
loads = re.findall(r"\bLOAD\b.*\balign 2\*\*(\d+)", sys.stdin.read())
if not loads or any(int(value) < 14 for value in loads):
    raise SystemExit("Missing or insufficient ELF load-segment alignment: " + sys.argv[1])
' "${lib#"$tmp/"}"
done < "$tmp/libraries"

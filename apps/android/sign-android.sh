#!/usr/bin/env bash
# Run only on an owner-controlled machine with a trusted checkout and SDK.
set -euo pipefail
set +x
umask 077
export LC_ALL=C

tools_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$tools_dir/../.." && pwd)"
: "${ANDROID_HOME:?Android SDK installation required}"
: "${NDK_HOME:?Android NDK installation required}"
: "${AERIFT_BUNDLETOOL_JAR:?Path to pinned Google bundletool-all-1.18.3.jar required}"
: "${AERIFT_ANDROID_KEYSTORE:?Path to owner-controlled PKCS12/JKS signing key required}"
: "${AERIFT_ANDROID_KEY_ALIAS:?Signing key alias required}"
: "${AERIFT_ANDROID_VERSION_CODE:?Explicit, monotonically increasing Play version code required}"
[[ "$AERIFT_ANDROID_VERSION_CODE" =~ ^[1-9][0-9]{0,9}$ ]] && (( AERIFT_ANDROID_VERSION_CODE <= 2100000000 )) || {
  echo 'Expected a version code from 1 to 2100000000.' >&2; exit 2;
}
[[ -f "$AERIFT_ANDROID_KEYSTORE" ]] || { echo 'Signing key not found.' >&2; exit 2; }
key_source="$(realpath -- "$AERIFT_ANDROID_KEYSTORE")"
case "$key_source" in "$repo"/*) echo 'The signing key must be stored outside the repository.' >&2; exit 2;; esac
output="${1:?Usage: sign-android.sh OWNER_ONLY_OUTPUT_DIRECTORY}"
mkdir -p -- "$output"
output="$(cd -- "$output" && pwd -P)"
case "$output" in "$repo"|"$repo"/*) echo 'The private output directory must be outside the repository.' >&2; exit 2;; esac
[[ -O "$output" && "$(stat -c %a "$output")" == 700 ]] || { echo "Output directory must belong to you and have mode 700." >&2; exit 2; }
for filename in AeRift-private.apk AeRift-internal.aab SHA256SUMS build-receipt.txt; do
  [[ ! -e "$output/$filename" ]] || { echo "Output already exists: $filename" >&2; exit 2; }
done

# Require an exact clean source revision before producing a distribution build.
[[ -z "$(git -C "$repo" status --porcelain --untracked-files=normal)" ]] || {
  echo 'Use an exact, clean source checkout to create signed artifacts.' >&2; exit 2;
}
revision="$(git -C "$repo" rev-parse HEAD)"
test -x "$ANDROID_HOME/build-tools/36.0.0/apksigner"
command -v jarsigner >/dev/null
env -u AERIFT_ANDROID_STORE_PASS -u AERIFT_ANDROID_KEY_PASS -u AERIFT_ANDROID_KEYSTORE -u AERIFT_ANDROID_KEY_ALIAS \
  bash "$tools_dir/build-android.sh" release
test "$(git -C "$repo" rev-parse HEAD)" = "$revision"
git -C "$repo" diff --exit-code --quiet

# Collect passwords only after dependency/build scripts have run; keep their
# values out of the command line, build output, and generated repository files.
if [[ -z "${AERIFT_ANDROID_STORE_PASS:-}" ]]; then
  read -r -s -p 'Android keystore password: ' AERIFT_ANDROID_STORE_PASS </dev/tty
  echo >&2
fi
if [[ -z "${AERIFT_ANDROID_KEY_PASS:-}" ]]; then
  read -r -s -p 'Android key password (Enter to reuse keystore password): ' AERIFT_ANDROID_KEY_PASS </dev/tty
  echo >&2
fi
AERIFT_ANDROID_KEY_PASS="${AERIFT_ANDROID_KEY_PASS:-$AERIFT_ANDROID_STORE_PASS}"
export AERIFT_ANDROID_STORE_PASS AERIFT_ANDROID_KEY_PASS
signer="$ANDROID_HOME/build-tools/36.0.0/apksigner"
zipalign="$ANDROID_HOME/build-tools/36.0.0/zipalign"
project="$repo/apps/aerift/src-tauri/gen/android/app/build/outputs"
mapfile -t apks < <(find "$project/apk" -type f -name '*-release-unsigned.apk' | sort)
mapfile -t aabs < <(find "$project/bundle" -type f -name '*-release.aab' | sort)
[[ "${#apks[@]}" -eq 1 && "${#aabs[@]}" -eq 1 ]] || {
  echo 'Expected one universal unsigned release APK and one release AAB.' >&2; exit 1;
}
work="$(mktemp -d "$output/.aerift-sign.XXXXXX")"
trap 'rm -rf "$work"' EXIT

cert="$(keytool -exportcert -keystore "$key_source" -alias "$AERIFT_ANDROID_KEY_ALIAS" \
  -storepass:env AERIFT_ANDROID_STORE_PASS | sha256sum | cut -d' ' -f1)"
"$zipalign" -P 16 -f 4 "${apks[0]}" "$work/aligned.apk"
"$signer" sign --ks "$key_source" --ks-key-alias "$AERIFT_ANDROID_KEY_ALIAS" \
  --ks-pass env:AERIFT_ANDROID_STORE_PASS --key-pass env:AERIFT_ANDROID_KEY_PASS \
  --out "$work/AeRift-private.apk" "$work/aligned.apk"
jarsigner -keystore "$key_source" -storepass:env AERIFT_ANDROID_STORE_PASS \
  -keypass:env AERIFT_ANDROID_KEY_PASS -sigalg SHA256withRSA -digestalg SHA-256 \
  -signedjar "$work/AeRift-internal.aab" "${aabs[0]}" "$AERIFT_ANDROID_KEY_ALIAS"
unset AERIFT_ANDROID_STORE_PASS AERIFT_ANDROID_KEY_PASS

apk_verify="$("$signer" verify --verbose --print-certs "$work/AeRift-private.apk")"
grep -Fqx 'Number of signers: 1' <<<"$apk_verify"
grep -Fiqx "Signer #1 certificate SHA-256 digest: $cert" <<<"$apk_verify"
jarsigner -verify "$work/AeRift-internal.aab" | grep -F 'jar verified.'
aab_cert="$(keytool -printcert -jarfile "$work/AeRift-internal.aab" | awk '/SHA256:/{gsub(":", "", $2); print tolower($2)}')"
[[ "$aab_cert" == "$cert" ]]
bash "$tools_dir/verify-package.sh" "$work/AeRift-private.apk" "$AERIFT_ANDROID_VERSION_CODE"
bash "$tools_dir/verify-bundle.sh" "$work/AeRift-internal.aab" "$AERIFT_ANDROID_VERSION_CODE"

(
  cd "$work"
  sha256sum AeRift-private.apk AeRift-internal.aab > SHA256SUMS
  printf 'source=%s\npackage=%s\nversion_code=%s\nsigner_sha256=%s\n' \
    "$revision" 'com.kgamazing44.aerift' "$AERIFT_ANDROID_VERSION_CODE" "$cert" > build-receipt.txt
)
for filename in AeRift-private.apk AeRift-internal.aab SHA256SUMS build-receipt.txt; do
  mv -- "$work/$filename" "$output/$filename"
done
printf 'Verified signed Android artifacts saved in owner-only directory: %s\n' "$output"

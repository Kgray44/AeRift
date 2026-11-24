#!/usr/bin/env bash
# Install a known Android workspace even when the runner image is minimal.
set -euo pipefail
: "${RUNNER_TEMP:?GitHub runner directory required}"
: "${GITHUB_ENV:?GitHub environment file required}"
: "${GITHUB_PATH:?GitHub path file required}"
: "${ANDROID_NDK_VERSION:?Expected pinned NDK version}"
: "${RUSTUP_TOOLCHAIN:?Expected pinned Rust toolchain}"
: "${JAVA_HOME:?A full JDK 17 is required}"
test -x "$JAVA_HOME/bin/javac"

sdk="$RUNNER_TEMP/aerift-sdk"
work="$(mktemp -d "$RUNNER_TEMP/aerift-sdk-bootstrap.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$sdk/cmdline-tools"
curl -fsSL --retry 3 https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o "$work/cmdline.zip"
echo "7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee  $work/cmdline.zip" | sha256sum -c -
unzip -q "$work/cmdline.zip" -d "$work"
mv "$work/cmdline-tools" "$sdk/cmdline-tools/latest"
export ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk"
sdkmanager="$sdk/cmdline-tools/latest/bin/sdkmanager"
# Ignore only yes(1)'s expected SIGPIPE, not the Android SDK license status.
set +o pipefail
yes | "$sdkmanager" --sdk_root="$sdk" --licenses >/dev/null
set -o pipefail
"$sdkmanager" --sdk_root="$sdk" --install platform-tools "platforms;android-36" "build-tools;36.0.0" "ndk;$ANDROID_NDK_VERSION"

export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v rustup >/dev/null; then
  rustup_url=https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init
  curl -fsSL --retry 3 "$rustup_url" -o "$work/rustup-init"
  curl -fsSL --retry 3 "$rustup_url.sha256" -o "$work/rustup-init.sha256"
  (cd "$work" && sha256sum -c rustup-init.sha256)
  chmod 700 "$work/rustup-init"
  "$work/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
fi
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --target x86_64-linux-android

printf 'ANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\nNDK_HOME=%s\nANDROID_NDK_HOME=%s\n' \
  "$sdk" "$sdk" "$sdk/ndk/$ANDROID_NDK_VERSION" "$sdk/ndk/$ANDROID_NDK_VERSION" >> "$GITHUB_ENV"
printf '%s\n' "$HOME/.cargo/bin" "$sdk/platform-tools" "$sdk/cmdline-tools/latest/bin" >> "$GITHUB_PATH"

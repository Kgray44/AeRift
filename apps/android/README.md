# AeRift Android owner and tester builds

AeRift uses the existing Tauri 2 application, shared React mobile workspace,
and Android-native adapters. Generate the disposable Gradle host; do not
check in `apps/aerift/src-tauri/gen/android/`, builds, or keys.

## Build and qualifier

On Linux, install Node 24, a **full** JDK 17, Python 3, the Android SDK command
line tools, API 36, Build Tools 36.0.0, and NDK **29.0.14206865**. Tauri CLI
**2.9.0** comes from the npm lock, generates Gradle **8.14.3** with AGP
**8.11.0**, and compiles/targets API 36. Use Rust 1.100.0 and targets
`aarch64-linux-android` and `x86_64-linux-android`. Point `ANDROID_HOME` at
your SDK and `NDK_HOME` and `ANDROID_NDK_HOME` to its pinned NDK directory.

```sh
rustup toolchain install 1.100.0 --profile minimal \
  --target aarch64-linux-android --target x86_64-linux-android
export RUSTUP_TOOLCHAIN=1.100.0
sdkmanager --install 'platforms;android-36' 'build-tools;36.0.0' 'ndk;29.0.14206865'
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export ANDROID_NDK_HOME="$NDK_HOME"
npm ci
bash apps/android/build-android.sh debug
```

The public GitHub workflow builds a debug-signed x86_64 emulator APK. It
checks the package, target API and native ZIP/ELF 16 KB compatibility, then
launches the actual WebView, opens Android Files and stages a synthetic
local file. It does not offer that file, transfer data, use a real device,
request camera access, upload app artifacts, or create a GitHub release.
An emulator job does not verify real camera, device permissions, local
network discovery or Android↔Windows/iPhone transfers. Keep these physical
checks separate. On an idle owner-controlled Linux machine with KVM, add
`system-images;android-36;google_apis;x86_64` and run
`bash apps/android/emulator-smoke.sh /absolute/path/to/debug.apk`; it refuses
an existing adb device.

## Sign on an owner-controlled machine

1. Check out a reviewed, clean commit. Keep an RSA PKCS12 or JKS file
   outside source control, with a separate encrypted backup. If creating a
   new test or upload key, use `keytool -genkeypair -storetype PKCS12
   -keystore /private/path/aerift.p12 -alias aerift -keyalg RSA -keysize 3072
   -validity 10000`. Existing Google Play apps must use their registered
   upload key instead. Keep the key and credentials with the owner, not in
   chat, Git history, workflow artifacts, or command arguments.
2. Download [Google bundletool 1.18.3](https://github.com/google/bundletool/releases/tag/1.18.3).
   The script checks the published digest, and validates the bundle
   manifest and 16 KB packager configuration.
3. Choose a new Play version code. Use a new empty directory outside the
   repo that belongs to you and has mode 700.

```sh
export AERIFT_ANDROID_KEYSTORE=/private/path/aerift.p12
export AERIFT_ANDROID_KEY_ALIAS=aerift
export AERIFT_ANDROID_VERSION_CODE=1001
export AERIFT_BUNDLETOOL_JAR=/private/tools/bundletool-all-1.18.3.jar
bash apps/android/sign-android.sh /private/output/aerift-1001
```

The signing script builds an ARM64/x86_64 universal release APK and AAB,
asks for passwords only when it is ready to sign, verifies both signatures
against the owner's key, checks package/version and Android compatibility,
and writes `AeRift-private.apk`, `AeRift-internal.aab`, `SHA256SUMS`, and a
commit and signing certificate receipt. It neither uploads nor releases
them. Verify SHA-256 on the receiving side. The certificate that signs
an APK determines whether it can upgrade an existing sideloaded install.
Play App Signing normally signs Play installations with a separate app
signing key, so a sideload signed with your upload key may not upgrade a
Play install or vice versa. Switching paths can require uninstalling first
and may erase local app data.

## Invite testers privately

- **Google Play Internal testing** is the TestFlight equivalent for
  Android. The owner creates the app in Play Console, configures Play App
  Signing and internal testers, uploads the signed AAB to the *Internal
  testing* track only, and shares its opt-in link with up to 100 approved
  testers. No production rollout is part of this workflow. New personal
  developer accounts' separate requirement of 12 opted-in closed testers
  for 14 continuous days is for production eligibility, not this internal
  test. [Google Play internal testing](https://support.google.com/googleplay/android-developer/answer/9845334)
- **Direct install**: share the signed APK privately with the named tester,
  along with its SHA-256. Do not use a public GitHub release or public
  Actions artifact. Follow Android's device and installer rules; never
  ask testers to disable Play Protect or bypass developer verification.
  An AAB is not directly installable.
- **iOS** continues to use TestFlight; it cannot distribute Android builds.

# AeRift on Windows

Use 64-bit Windows 11, Node.js 22.12 or later in the 22 release line, stable MSVC Rust, Visual Studio Build Tools with Desktop development with C++, and Microsoft Edge WebView2. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

From the repository root:

```powershell
npm ci
npm run build -w '@aerift/app'
npm run tauri -w '@aerift/app' -- dev
npm run tauri -w '@aerift/app' -- build --bundles nsis
```

Run development and installer builds separately. The first Windows frontend build stages the exact MediaPipe runtime, model, and Apache license from the checked asset manifest. The installer embeds these files and needs no model download at runtime. The Windows workflow uploads the unsigned x64 installer, WebView screenshot, and JSON launch receipt.

## Use the app

1. Open **Pair a device** on both apps. On either device, create an invitation and copy it to the other device. Connect, then approve the request on the invitation device.
2. Choose a file or drop one regular file into the window. Select the online paired device and click **Send file**. The receiver sees an offer it can accept or decline.
3. Use **Settings** to find the current receiving folder or choose one for the next app launch. The default is `Received` in AeRift's local app-data directory. Existing files keep their contents when a name conflicts.
4. With a file and online paired device selected, click **Use camera gesture**. Wait for permission and preview. Show an open hand, make a fist, then open the hand when instructed. The same send action handles gesture release and the button. Use **Cancel gesture**, move focus away, or change the selection to release the camera. Settings offer two in-app camera shortcuts and an Off option.

## Validate

Run the native adapter and DPAPI tests from the repository root:

```powershell
cargo test --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --lib
```

The adapter test supplies loopback endpoints for two Windows-native sessions, requires pairing and explicit receive approval, and compares the actual saved bytes in both directions. Run the [device acceptance gates](../../tests/README.md) separately to qualify real LAN discovery, Windows 11 camera, physical iPhone, and hash-matched file transfers on the exact release builds.

## Alpha limits

Windows currently uses IPv4 peer endpoints. Devices must share a LAN that allows discovery and direct connections. A receive folder change takes effect on the next launch. Camera gestures offer outgoing files. Incoming acceptance uses the visible button. The Windows package is unsigned.

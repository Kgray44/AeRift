# AeRift on Windows

Build with 64-bit Windows 11, the MSVC Rust toolchain, Visual Studio Build Tools with Desktop development with C++, Node.js 22.12 or later in the 22 release line, and Edge WebView2. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
Set-Location apps/aerift
npm install --workspaces=false
npm run typecheck
npm run tauri dev
npm run tauri build -- --bundles nsis
```

The installer is under `src-tauri/target/release/bundle/nsis/`. Install for the current user and launch AeRift from Start. The shell should open to Nearby devices with a Disconnected state. Close the window to exit. Record the commit, installer hash, Windows version, WebView2 version and any startup error. Use the [alpha acceptance gates](../../tests/README.md) for device and transfer validation.

The first slice contains the native host and its launch screen. Discovery, pairing, transfer, camera, and GLASS integration remain pending. The initial NSIS packaging uses unsigned development builds.

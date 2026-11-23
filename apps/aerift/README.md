# AeRift native host

The shared entry point lives here. The desktop binary and the mobile entry point both call `aerift_app::run`. The application identifier is `com.kgamazing44.aerift`. The Apple project and iOS adapters live under `src-tauri/gen/apple/` and `src-tauri/src/platform/ios/`.

Install dependencies from the repository root with `npm ci`. Run `npm run tauri -w '@aerift/app' -- dev` to develop the desktop host. The app uses the shared GLASS package and the v1 app contract. The Windows build embeds the shared gesture adapter and local recognition assets. The Vite server uses port 1420 and respects the native development host set by Tauri.

See the [Windows build and qualification guide](../windows/README.md) and the [iPhone guide](../ios/README.md).

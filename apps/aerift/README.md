# AeRift native host

The shared entry point lives here. The desktop binary and the mobile entry point both call `aerift_app::run`. The application identifier is `com.kgamazing44.aerift`. The Apple project and iOS adapters live under `src-tauri/gen/apple/` and `src-tauri/src/platform/ios/`.

From this directory, run `npm ci --workspaces=false`, then `npm run tauri dev` for desktop development. Run `npm run tauri ios init` on macOS to generate the Apple project, then follow the iOS workstream's launch instructions. The shared Vite server listens on port 1420. Use the iOS adapter's development host configuration if a physical device needs access to the server.

See the [Windows build and qualification guide](../windows/README.md).

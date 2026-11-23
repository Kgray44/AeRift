# Mission 3 Windows desktop validation

Mission 3 uses the production UI Overhaul shell, GLASS appearance, spatial scene, camera control and transfer choreography. Its base is the Orbit adaptation at `fcee979b77afcf7501b3353435b9219b76d11fc4`, which includes the shared contracts from #39, the UI Overhaul from #41 and production Orbit from #43. The Windows renderer keeps one `TransferWorkspace` mounted. Mobile retains the shared component's existing independent navigation and entry point.

## Windows behaviors

- Simplified is the default. Full Workspace adds independently configurable modules for files, photos and videos, links, notes, manual clipboard capture and collections. Switching modes preserves the active native subscription and the selected Rift file. A hidden module keeps its saved objects.
- Workspace objects are local, versioned records using the Mission 0 contracts. IndexedDB transactions store the records and their imported files. Media and file copies can be previewed or saved locally. Browser links open in the system browser. Clipboard capture requires opt-in and a separate user action. Collections reference saved objects and keep their order.
- The Rift uses the existing native selection registry and transfer port. Windows picker, drop, and optional **Stage in AeRift** Explorer context menu all stage one file. The user chooses a trusted peer and confirms each offer. Workspace records and collections remain local. Direct transfer of imported workspace copies or typed objects requires a shared staging/export contract.
- Ambient operation is opt-in and independent of mode. Closing the main window into the notification area keeps the native session live. The tray provides status, Rift and Activity shortcuts, a seven-second non-focusable transfer preview and an explicit Quit action. The preview uses the live native transfer data and the production Rift renderer. Incoming-offer toasts and a global Rift shortcut are optional. Toasts omit filenames and peer names. Sign-in launch and Explorer integration register only for the current Windows user.
- The settings gear opens the Settings destination. It contains the production Appearance picker, gesture and camera controls, receive storage, privacy, workspace mode and native settings. A Windows camera attempt runs only in the foreground Rift. AeRift releases the camera when the window loses focus, independently of other applications' permission requests.

## Automated checks

- `npm test`, `npm run test:ui`, `npm run test:gestures` and `npm run build --workspace @aerift/app`.
- `cargo test --locked --manifest-path apps/aerift/src-tauri/Cargo.toml` on Windows. The native adapter test pairs two local sessions over loopback and transfers real files in both directions. The native selection tests cover competing drop and picker operations. The Explorer argument test checks explicit single-file input.
- `node tests/desktop/browser-smoke.mjs` drives the Windows frontend against a simulated Tauri port. It checks keyboard Orbit and destination focus, conventional navigation, live-session continuity across mode switches, selected-file continuity, transfer progress and history filtering, native adapter calls, module visibility, photo preview, local links, manual clipboard capture against a simulated clipboard, contextual workspace actions, ordered collections, persistent notes on reload, and the compact transfer preview. The progress fixture reaches full bytes before it reports delivery.

To run the browser check, start the desktop frontend with `npm run dev --workspace @aerift/app`. The harness uses an installed Chrome by default, with `AERIFT_BROWSER_CHANNEL` available for a different Chromium channel. Make Playwright resolvable to Node or set `AERIFT_PLAYWRIGHT_MODULE` to its absolute `index.mjs` path. `AERIFT_DESKTOP_URL` overrides the default development URL. Set `AERIFT_DESKTOP_EVIDENCE` to a directory to capture screenshots.

## Visual evidence

- [Dark Simplified with Orbit open](evidence/desktop-workspace/dark-simplified-orbit.png)
- [Dark production Rift and native selection fixture](evidence/desktop-workspace/dark-production-rift.png)
- [Dark Full Workspace with a heterogeneous collection](evidence/desktop-workspace/dark-full-workspace.png)
- [Light Workspace at 500 px](evidence/desktop-workspace/light-compact-workspace.png)
- [Light compact Rift preview at 43%](evidence/desktop-workspace/light-ambient-preview.png)

## Integration and qualification still required

- On an installed Windows build, verify Windows Explorer menu registration and removal, launching a second instance with a file, tray close/reopen and Quit, global shortcut conflicts, sign-in registration, DPI positioning, toast delivery and live WebView2 camera recovery. The browser harness simulates those IPC calls. Native toast branding and delivery depend on installed Windows behavior and OS notification preferences. [Tauri notifications](https://v2.tauri.app/plugin/notification/)
- Repeat physical Windows and iPhone pairing and bidirectional integrity checks on the integrated revision, including ambient operation during a transfer. The native loopback test validates both local adapters and file bytes.
- Verify a physical camera through permission grant, denial, device switch and capture relinquishment. Camera release on focus loss is supported by the WebView lifecycle. Exclusive camera arbitration across applications is unqualified.
- Qualify a screen reader, Windows scaling, multiple monitors and reduced transparency on native hardware. The browser check covers keyboard focus, width and explicit Light and Dark appearance.
- Reconcile the Mission 2 render-prop composition when stacking #42. Retain one mounted transfer controller and the production Rift renderer across both forms. The scoped PR leaves the iOS host, wire contracts and macOS/Linux desktop adapter scope to their owners.

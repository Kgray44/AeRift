# AeRift for iPhone

The iPhone app uses the shared Tauri 2 host in `apps/aerift`. Pairing, encrypted transfer, file integrity and consent follow the [v1 protocol](../../contracts/v1/protocol.md). The iOS adapter owns system pickers, sandbox staging and Apple-specific configuration.

## Platform decisions

| Area | Alpha approach |
| --- | --- |
| Camera | Explicit opt-in from the shared UI. Prefer the shared detector in WKWebView if capture and inference qualify on a real iPhone. AVFoundation and Vision can supply an on-device landmark source if WKWebView fails qualification. Clear the intent when capture stops, tracking is lost, or the app leaves the active state. |
| LAN | Use the shared Rust TLS 1.3 engine on the local network and Keychain-backed device identity. Browse and advertise the fixed `_aerift._tcp` service through Apple's Bonjour APIs if the shared mDNS implementation needs raw multicast. |
| Permissions | Initiate local network and camera access from the foreground. The iPhone can deny or revoke either; keep manual controls available when camera access fails. Simulator runs cannot qualify local-network permission behavior. |
| Files and Photos | Choose one item through the Files or system Photos picker. Stage a private regular-file copy for the shared engine and expose only the native selection ID, display name and size to the UI. The Photos picker grants access to selected items and needs no broad library permission. |
| Received files | Keep incoming partial files private. Publish only after explicit receiver acceptance and byte-count and SHA-256 checks, using a collision-safe destination under Documents/Received for Files access. |
| Lifecycle | Alpha transfers require the app in the foreground. The v1 listener and Rust stream cannot use background URLSession as a drop-in lifecycle mechanism. |
| Signing | Build with macOS, Xcode, XcodeGen and Tauri's iOS Rust targets. Simulator builds are unsigned and separate from the signed device gate. |

Sources: [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [Apple local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), [Apple photo picker](https://developer.apple.com/documentation/photokit/selecting-photos-and-videos-in-ios), [Apple camera interruption](https://developer.apple.com/documentation/avfoundation/avcapturesession/interruptionreason/videodevicenotavailableinbackground), [Apple background networking](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api).

## Build and install

Use the shared host's locked npm and Cargo dependencies. After the shared host is present, install Xcode and select its command-line tools. Install XcodeGen and the matching targets with `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`. From the repository root, run `bash apps/ios/prepare-apple.sh` after installing the host dependencies. It generates the Tauri Xcode project and embeds the Apple privacy manifest. Tauri 2.9 merges `apps/aerift/src-tauri/Info.ios.plist` when packaging. From the repository root, `bash apps/ios/simulator-smoke.sh` generates the project, builds the app, verifies the bundled plist and launches the result on an available iPhone simulator.

For a physical iPhone, add an Apple account in Xcode, choose an authorized signing team for `com.aerift.app`, pair the device with the Mac and enable Developer Mode. Select the iPhone as the run destination. Keep team credentials in Xcode or the approved CI signing store. [Tauri iOS signing](https://v2.tauri.app/distribute/sign/ios/) · [Apple device installation](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).

## Validation

The native picker is implemented in `tauri-plugin-aerift-ios`. Register the plugin through the shared host and call its Rust-only `pick_file` API from the iOS AppPort adapter. Keep the returned selection alive while the transfer can read its staging file. The host drops it when cancelled, replaced, or successfully transferred and no reader still owns it. Failed copies are removed immediately. The next import after an interrupted process clears the previous session’s staging files. The aggregate staging budget is 512 MiB, and every copy leaves a 64 MiB margin against the free-space reading. The webview receives a selection ID and display metadata. Until the shared launch slice lands, hosted iOS CI builds the pinned Windows host revision `c5470a72e2ffda5149c6e94d2861503a7024542f` with the iOS privacy configuration from this branch. Follow the [repository acceptance gates](../../tests/README.md) and record the exact commit, Xcode/iOS versions and signing method. On a physical iPhone, test permission denial and recovery, import from Files and Photos, compare SHA-256 for accepted transfers in both directions, find a completed file in Files, and confirm that an intentional arm and release issues one offer. Repeat with the camera off and background or interrupt the camera mid-gesture to verify intent cancellation.

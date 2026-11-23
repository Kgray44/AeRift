# AeRift for iPhone

The iPhone app uses the shared Tauri 2 host in `apps/aerift`. Pairing, encrypted transfer, file integrity and consent follow the [v1 protocol](../../contracts/v1/protocol.md). The iOS adapter owns system pickers, sandbox staging and Apple-specific configuration.

## Platform decisions

| Area | Alpha approach |
| --- | --- |
| Camera | Explicit opt-in from the shared UI. The native AVFoundation and Vision source forwards only 21 normalized landmarks per observed hand, confidence and frame timing into the common gesture pipeline. This keeps camera capture and permission lifecycle in iOS and leaves intent decisions in the shared controller. Clear the intent when capture stops, tracking is lost, or the app leaves the active state. |
| LAN | The native Keychain adapter atomically inserts the device identity and stores peer trust snapshots under iOS device-only, when-unlocked protection. The shared Rust TLS 1.3 engine uses it through platform storage interfaces. The iOS adapter browses and advertises the fixed `_aerift._tcp` service through system Bonjour. Discovered labels and routes remain untrusted until the shared engine verifies the certificate. |
| Permissions | Initiate local network and camera access from the foreground. The iPhone can deny or revoke either; keep manual controls available when camera access fails. Simulator runs cannot qualify local-network permission behavior. |
| Files and Photos | Choose one item through the Files or system Photos picker. Stage a private regular-file copy for the shared engine and expose only the native selection ID, display name and size to the UI. The Photos picker grants access to selected items and needs no broad library permission. |
| Received files | Keep incoming partial files private. Publish only after explicit receiver acceptance and byte-count and SHA-256 checks, using a collision-safe destination under Documents/Received for Files access. |
| Lifecycle | Alpha transfers require the app in the foreground. The v1 listener and Rust stream cannot use background URLSession as a drop-in lifecycle mechanism. |
| Signing | Build with macOS, Xcode, XcodeGen and Tauri's iOS Rust targets. Simulator builds are unsigned and separate from the signed device gate. |

[Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [Apple local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), [Apple photo picker](https://developer.apple.com/documentation/photokit/selecting-photos-and-videos-in-ios), [Apple camera interruption](https://developer.apple.com/documentation/avfoundation/avcapturesession/interruptionreason/videodevicenotavailableinbackground), [Apple background networking](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api).

## Build and install

Use the shared host's locked npm and Cargo dependencies. After the shared host is present, install Xcode and select its command-line tools. Install XcodeGen and the matching targets with `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`. From the repository root, run `bash apps/ios/prepare-apple.sh` after installing the host dependencies. It generates the Tauri Xcode project and embeds the Apple privacy manifest. Tauri 2.9 merges `apps/aerift/src-tauri/Info.ios.plist` when packaging. From the repository root, `bash apps/ios/simulator-smoke.sh` generates the project, builds the app, verifies the bundled plist and launches the result on an available iPhone simulator.

For a physical iPhone, use the existing hosted App Store distribution route in the [AeRift TestFlight guide](../../docs/testflight.md).

## Internal TestFlight

VoyageWright distributed physical test builds after a hosted Mac built and exported a signed archive from an exact source revision. A protected signing job uploaded the beta, checked Apple processing and retained an evidence receipt. Use that process for AeRift after establishing the App Store Connect record for `com.kgamazing44.aerift`, the matching App Store provisioning profile, an authorized internal testing group and a protected environment with AeRift-scoped credentials. Keep signing separate from PR checks. Record the candidate SHA, signed bundle identifier and build number, distribution status and the exact build installed on the test iPhone. [VoyageWright signed upload](https://github.com/Kgray44/treasurehuntSoT/actions/runs/39521997164) · [Tauri App Store distribution](https://v2.tauri.app/distribute/app-store/).

## Validation

Hosted macOS uses the same evidence model as VoyageWright’s Landfall Device Lab. CI builds the native app against recorded revisions, launches it on an iPhone simulator and retains a screenshot and a receipt containing the app and host commits, Xcode version, simulator runtime and model. [VoyageWright hosted iOS run](https://github.com/Kgray44/treasurehuntSoT/actions/runs/41287441739).

Open Workspace → Files or Photos and videos, then choose one item for Rift or import a batch of up to 12 items. Workspace can preview a supported staged item or export a copy with the system share sheet. Open Rift to choose a trusted peer and send it. The native picker stages it privately and sends the app only an opaque selection ID, basename and byte count. The staging copy stays alive until all readers release it. Failed copies are removed immediately. A later import clears the previous session’s staging files. The aggregate import staging budget is 512 MiB and leaves a 64 MiB margin against the free-space reading.

Pairing and transfers use the shared Rust runtime. Keep both devices on the same LAN with IPv4 available. AeRift stops Bonjour when iOS enters the background, resumes discovery on return and requests cancellation of active transfers on backgrounding. Received files are verified and published to Files → On My iPhone → AeRift → Received after acceptance. Incomplete receives stay in private storage.

In **Control Center**, opt in to **Enable camera gestures**. The foreground workspace listens automatically when a file and paired destination are selected or an incoming offer is eligible. Choose an exact offer if prompted, then follow the open-hand, hold, and release instructions. The indicator shows when the camera is active. You can still send and respond to offers by touch. **Signal ready** advertises your availability to paired devices for 45 seconds. Each offer requires its own consent.

Hosted CI builds and launches the native target in an iPhone simulator. A signed physical run must test permission denial and recovery, import from Files and Photos, compare SHA-256 for accepted transfers in both directions, find the published file in Files, and confirm that an intentional gesture issues one offer. Repeat with the camera off and interrupt the camera mid-gesture to check intent cancellation. Record the exact app revision, Xcode and iOS versions, signing receipt, and observations using the [repository acceptance gates](../../tests/README.md).

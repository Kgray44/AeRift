# AeRift mobile workspace

The iPhone still uses the shared v1 pairing, consent and file transport. One subscription owns transfer and selection state as the user moves between Home, Workspace, Rift, Devices and Activity. Control Center opens separately and stores appearance, available modules and camera opt-in locally. The implementation uses the actual UI Overhaul from #41 and the Mission 0 contracts from #39.

| Area | Implemented in this change | Remaining |
| --- | --- | --- |
| Navigation | Floating bottom navigation using the shared Mission 0 destination model, Control Center, focus restoration, offer affordances and the Overhaul navigation indicator | Shared-element motion and native VoiceOver, Dynamic Type, keyboard and rotation qualification |
| Files and Photos | Native system pickers can select one item for Rift or import up to 12 items per batch to an ordered tray. Files can browse available providers. Photos uses the system's selected-item access with current representation. Rift stages a private copy for v1. Preview supported formats with Quick Look and export a copy through iOS sharing. Verified receives land under Files → AeRift → Received. | Named media groups and selected-representation metadata fidelity on physical devices |
| Notes | Local Markdown source and plain text, editable and sent as ordinary .md or .txt files after selecting an existing trusted destination | Attachments and rendered rich previews |
| Browser | Safari Services in-app browsing and explicit link collection. Link copies use .txt. Web pages are outside the transfer webview. | In-app page capture and download import from the browser, along with physical qualification of the browser's external-open controls |
| Clipboard | Optional text pins through an editable field and the native Paste menu. No automatic clipboard reads or background sync. Each send is explicit. | Image paste and optional history, image and sensitivity controls |
| Collections | Persistent ordering and removal of saved notes, links and text pins | Media membership and a receiver-compatible collection transfer format |
| Rift | UI Overhaul spatial peers, authenticated receiver readiness, shared Rift animation, manual consent and cancellation, and opt-in foreground gesture recognition. | Real-device sender and receiver choreography, readiness expiry, permission and interruption qualification |
| Devices and Activity | Discovery, pairing, trust revocation and real pending, active and final transfer states. Optional local retention for up to 60 final outcomes, with an explicit clear action. | Device capability negotiation |
| Android | Experience contract and platform adapter plan below | Native host, integrations and device validation |

Saved local objects use the versioned Mission 0 object contract. Opaque native selection IDs stay session-scoped. The v1 sender offers one ordinary file at a time. A receiver does not need workspace support to accept a note, link or pin copy. A staged file is released after its last native reader is done. Collection membership never implies that a recipient has its objects.

System surfaces used here are [Quick Look](https://developer.apple.com/documentation/quicklook/qlpreviewcontroller), the [iOS share sheet](https://developer.apple.com/documentation/uikit/uiactivityviewcontroller) and [Safari Services](https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller).

The Files and Photos library keeps up to 24 imported copies and 512 MiB in this iPhone’s app-owned storage across restarts. The library is excluded from device backup. Import publishes an ordered catalog only after each provider succeeds. Choose individual imports for Quick Look, export, or Rift. These actions use read-only local links to preserve the stored copies. Removing an imported copy leaves its source alone. A copy already selected for Rift stays available there until you clear or send it. Files, Photos and Videos use the shared digital-object presentation model. Photos and video imports keep the representation the platform supplies. AeRift requests the [system picker’s current representation](https://developer.apple.com/documentation/photosui/phpickerconfiguration-swift.struct/preferredassetrepresentationmode) and copies its bytes without recompression.

## Android adapter plan

The repository has no Android application, SDK project or Android runtime adapter. Use the mobile destination and digital-object contracts with an Android Tauri host and a Kotlin plugin. Map Files to the Storage Access Framework with temporary staged copies or persisted URI access where warranted. Map Photos to the Android system Photo Picker. For links, use an isolated browser surface such as Custom Tabs and preserve manual address collection. Keep clipboard actions foreground and user-initiated. Use Android Keystore for durable peer identity, Android service discovery with local network permissions, and the same authenticated v1 transport. Qualify gesture availability and foreground transfer interruption under Android lifecycle and permission rules before enabling either. Add equivalent accessibility and adaptive layout checks on phone and tablet emulators before testing the Windows-to-Android path on hardware.

## Integration handoff

PR #42 is stacked on [the shared UI Overhaul and Mission 0 staging base](https://github.com/Kgray44/AeRift/tree/integration/ui-overhaul-foundations). The base combines [Mission 0 #39](https://github.com/Kgray44/AeRift/pull/39) with [UI Overhaul #41](https://github.com/Kgray44/AeRift/pull/41). Merge the shared foundation and qualify the Overhaul, including reconciliation with the separate GLASS tint work in #36, before integrating Mobile. The mobile seam controls the route and supplemental module layout while the Overhaul TransferWorkspace retains its sole live subscription, consent, readiness, sender and receiver state, and recovery controls. Both native command sets remain registered. Activity presents the active Rift channel first so an incoming offer is visible immediately.

## Browser evidence

Playwright drove the production components through a deterministic fixture port at 320 × 640, 390 × 844, 844 × 390 and 1024 × 768. It checked focus, 44 px target bounds, sideways overflow, staged selection through navigation, outgoing offers, incoming consent, cancellation, appearance and motion after reload, collection persistence, clipboard opt-in and explicit pin removal, and Activity retention and clearing.

[Light Home](evidence/mobile-workspace/light-home-390.png) · [Light Workspace](evidence/mobile-workspace/light-workspace-390.png) · [Light Rift](evidence/mobile-workspace/light-rift-390.png) · [Dark Activity](evidence/mobile-workspace/dark-activity-390.png) · [Dark tablet Home](evidence/mobile-workspace/dark-home-1024.png)

Run the fixture from the root with `npm exec -- vite --config tests/ui/vite.config.mts --host 127.0.0.1 --port 4187`. Open `http://127.0.0.1:4187/mobile.html` in Playwright and run `playwright-cli run-code --filename=tests/ui/mobile-browser-check.js`. The script resets storage for the fixture origin and writes the browser captures.

[Multi-item Photos and Videos tray](evidence/mobile-workspace/media-import-tray-390.png) shows the selected file and ordered imports in the 390 px WebKit fixture.

## Qualification

Automated tests cover routing derived from the shared contract, received and pending distinctions, local persistence decoding, collection removal and inert text exports. The iOS CI native adapter tests exercise staging size and name rules. The [iPhone 17 Pro launch receipt and screenshot](https://github.com/Kgray44/AeRift/actions/runs/45268413571/artifacts/14865687166) qualify the shell and native bridge build at revision 1d7e766. The Activity retention and keyboard reading-order follow-up also has WebKit fixture coverage. Neither a webview fixture nor a simulator proves physical LAN, system media, camera or signed build behavior.

On a signed iPhone build, pair with the supported Windows app and verify SHA-256 for one accepted transfer each direction, including a file picked from Files and a photo or video picked from Photos. Check denial, picker cancellation, local network recovery, safe foreground interruption, notes after restart and an explicit clipboard pin. Test camera off and on, intentional release, camera interruption, acceptance, rejection and cancellation. Check VoiceOver, large text, reduced motion, both appearances, keyboard, rotation and tablet layout. Record exact build, OS, devices, inputs and outcomes.

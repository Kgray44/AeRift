# AeRift mobile workspace

The iPhone still uses the shared v1 pairing, consent and file transport. One subscription owns transfer and selection state as the user moves between Home, Workspace, Rift, Devices and Activity. Settings opens separately and stores appearance, available modules and camera opt-in locally.

| Area | Implemented in this change | Remaining |
| --- | --- | --- |
| Navigation | Floating bottom navigation using the shared Mission 0 destination model, settings sheet, focus restoration and offer affordances | Shared-element motion and native VoiceOver, Dynamic Type, keyboard and rotation qualification |
| Files and Photos | Direct, single-item system pickers. Files can browse available providers. Photos uses the system's selected-item access with current representation. Rift stages a private copy for v1. Preview supported formats with Quick Look and export a copy through iOS sharing. Verified receives land under Files → AeRift → Received. | Persistent asset library, multiselection and metadata fidelity evidence |
| Notes | Local Markdown source and plain text, editable and sent as ordinary .md or .txt files after selecting an existing trusted destination | Attachments and rendered rich previews |
| Browser | Safari Services in-app browsing and explicit link collection. Link copies use .txt. Web pages are outside the transfer webview. | In-app page capture and download import from the browser, along with physical qualification of the browser's external-open controls |
| Clipboard | Optional text pins through an editable field and the native Paste menu. No automatic clipboard reads or background sync. Each send is explicit. | Image paste and optional history, image and sensitivity controls |
| Collections | Persistent ordering and removal of saved notes, links and text pins | Media membership and a receiver-compatible collection transfer format |
| Rift | Existing manual start, consent, cancel and authenticated transfer flow. Gesture opt-in in Settings, per-attempt start/cancel in Rift and status from the actual recognizer and transport. | Shared sender and receiver object choreography, receiver readiness and physical motion acceptance |
| Devices and Activity | Discovery, pairing, trust revocation and real pending, active and final transfer states | Long-term durable transfer history and device capability negotiation |
| Android | Experience contract and platform adapter plan below | Native host, integrations and device validation |

Saved local objects use the versioned Mission 0 object contract. Opaque native selection IDs stay session-scoped. The v1 sender offers one ordinary file at a time. A receiver does not need workspace support to accept a note, link or pin copy. A staged file is released after its last native reader is done. Collection membership never implies that a recipient has its objects.

System surfaces used here are [Quick Look](https://developer.apple.com/documentation/quicklook/qlpreviewcontroller), the [iOS share sheet](https://developer.apple.com/documentation/uikit/uiactivityviewcontroller) and [Safari Services](https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller).

## Android adapter plan

The repository has no Android application, SDK project or Android runtime adapter. Use the mobile destination and digital-object contracts with an Android Tauri host and a Kotlin plugin. Map Files to the Storage Access Framework with temporary staged copies or persisted URI access where warranted. Map Photos to the Android system Photo Picker. For links, use an isolated browser surface such as Custom Tabs and preserve manual address collection. Keep clipboard actions foreground and user-initiated. Use Android Keystore for durable peer identity, Android service discovery with local network permissions, and the same authenticated v1 transport. Qualify gesture availability and foreground transfer interruption under Android lifecycle and permission rules before enabling either. Add equivalent accessibility and adaptive layout checks on phone and tablet emulators before testing the Windows-to-Android path on hardware.

## Qualification

Automated tests cover routing derived from the shared contract, received and pending distinctions, local persistence decoding, collection removal and inert text exports. The iOS CI native adapter tests exercise staging size and name rules. The simulator workflow produces launch evidence. Neither a webview fixture nor a simulator proves physical LAN, system media, camera or signed build behavior.

On a signed iPhone build, pair with the supported Windows app and verify SHA-256 for one accepted transfer each direction, including a file picked from Files and a photo or video picked from Photos. Check denial, picker cancellation, local network recovery, safe foreground interruption, notes after restart and an explicit clipboard pin. Test camera off and on, intentional release, camera interruption, acceptance, rejection and cancellation. Check VoiceOver, large text, reduced motion, both appearances, keyboard, rotation and tablet layout. Record exact build, OS, devices, inputs and outcomes.

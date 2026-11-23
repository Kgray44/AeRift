# AeRift Alpha 0.1 acceptance

**Release decision: HOLD.** The inspected foundation at `a34aaa2a4645fd2e4db844fcf0de843bb7cb2213` contains protocol constants and typed fixtures. No integrated Windows/iPhone release candidate or physical session was available at that baseline. The table records native outcomes. Update it against one exact integrated candidate before release.

| # | Criterion | Status | Evidence needed |
| --- | --- | --- | --- |
| 1 | Both apps launch | NOT TESTED | Clean Windows installer and provisioned iPhone install at the candidate SHA. Both show the native app. |
| 2 | Discovery or supported pairing method | NOT TESTED | Record same-LAN discovery on both devices and complete pairing with both invitation directions. |
| 3 | Authentication | NOT TESTED | Explicit approval, trusted reconnect after restart, and denial or revocation evidence. |
| 4 | Windows sends a real file to iOS | NOT TESTED | iPhone receives and opens a locally saved file. |
| 5 | iOS sends a real file to Windows | NOT TESTED | Windows receives and opens a locally saved file. |
| 6 | Byte-for-byte integrity | NOT TESTED | Source and saved size and SHA-256 match in each direction. |
| 7 | Windows gesture send | NOT TESTED | One deliberate gesture creates one offer and completes a real transfer. |
| 8 | iOS gesture send | NOT TESTED | One deliberate gesture creates one offer and completes a real transfer. |
| 9 | Conventional controls | NOT TESTED | Send, accept or reject, and cancel work through ordinary controls in both directions. |
| 10 | Safe network failure | NOT TESTED | Link loss settles safely, leaves no published partial file and allows a new transfer after reconnect. |
| 11 | Permissions and incoming approval | NOT TESTED | Denied and restored permissions, explicit accept, rejection, and absence of writes before consent. |
| 12 | Responsive UI | NOT TESTED | Input-to-render timing and accessibility observations during sustained transfer on both devices. |

Record PASS after all required observations for the row, FAIL for an attempted run with an unmet expectation, and NOT TESTED when evidence is missing. Link the receipt, fixture hashes and candidate SHA per row. Browser and loopback evidence supplements the native run.

## Initial component evidence

These results come from different workstream revisions. Rerun them on the integrated candidate before setting a physical gate to PASS.

| Workstream | Result and scope | Remaining release gate |
| --- | --- | --- |
| Windows host | Hosted Windows packaged and installed NSIS, launched the native app and rendered its disconnected WebView. The receipt identifies checked-out merge SHA `e69b35c28f1a656bb3f1e47c151abecde22ad32b` and installer SHA-256 `a23e0eb5461eb6160dc6fd9792b4248a169ee709f288751864eae75b350c5c2b`. [Installer run](https://github.com/Kgray44/AeRift/actions/runs/45115139474) | Candidate installer and operations on the actual Windows laptop. |
| iOS host | Simulator SDK typecheck and Tauri simulator launch passed for iOS head `2a96c76926571315115c8ed9e7a3f64a92c778d0` with pinned host `c5470a72e2ffda5149c6e94d2861503a7024542f`. [Simulator run](https://github.com/Kgray44/AeRift/actions/runs/45114916865) | Signed iPhone install, native picker registration, and bounded staging and cleanup. |
| Transfer and peer trust | On execution head `c8742eaf030c511dfb37475e18c57e2c5eca2aa0`, two Rust processes sent 3,145,745 bytes and an empty file in each direction. Binary SHA-256 matched, and each sender emitted 52 progress events. The execution head adds only the verification workflow to `a37c352aa7cf7fac0ef34f5da79c8260d1b48e93`. The fixture uses TLS test identities and auto-approval. [Loopback run](https://github.com/Kgray44/AeRift/actions/runs/45114780951) | Production identity and discovery, revocation, consent, and failure handling through native hosts. At the reviewed head, sender cancel can reset previously reported bytes to zero. |
| GLASS UI | Independent Windows run on `dfacf6472e7244155cb9a9b15b8a792cbe02b7f3` passed the TypeScript check, two send-action tests, and the showcase build. The workstream reports browser theme and accessibility checks. [GLASS PR](https://github.com/Kgray44/AeRift/pull/12) | Actual pairing UI, cancellation while a send is pending, native token rendering and assistive technology. |
| Gestures | Independent Windows run on `14d7fce21549efbd6ce3ee89768a96c3934694ea` passed the TypeScript check and all 23 synthetic command and native-bridge tests. A separate no-hand replay was still acquiring after 45 seconds of simulated time. The PR reports photographic replay p95 of 156.1 ms, with three of 32 frames over its 150 ms freshness budget. [Gesture PR](https://github.com/Kgray44/AeRift/pull/13) | Absolute acquisition timeout and real-camera qualification on both native hosts, with one offer per intent. |

The benchmark harness has passed its own tests. The integrated candidate still needs instrumented connection, throughput, memory, progress overhead and responsiveness results. The gesture replay measures software frame processing on one browser run.

## Internal TestFlight distribution

Use the VoyageWright sequence for Apple delivery. Its hosted macOS pipeline ran an unsigned build or signing preflight on a pinned source revision, then a separate protected job signed, exported, uploaded and observed Apple processing. The successful VoyageWright run proves the delivery procedure. An AeRift build needs its own delivery receipt. [VoyageWright signed upload](https://github.com/Kgray44/treasurehuntSoT/actions/runs/39521997164)

1. Confirm the AeRift App Store Connect record and App ID for `com.aerift.app`, an App Store distribution profile for that ID, a protected GitHub signing environment with authorized credentials, and the authorized internal TestFlight tester group. [Apple app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/) · [App Store provisioning](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/) · [Internal TestFlight groups](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
2. Run unsigned archive and signing preflight against the selected full SHA. Record the Xcode and iOS SDK versions, bundle ID, app version and build number, and pin the Windows installer from the same SHA.
3. Run signing, export, and upload in the protected job on the approved SHA. Keep the archive hash and the Apple processing result, remove temporary signing state, and keep private keys, profiles and tester identifiers out of the receipt.
4. Verify that the intended AeRift build is available to the internal group. On the physical iPhone, record the TestFlight version and build, install, launch, then execute the Windows ↔ iPhone checklist. Upload and Apple processing are delivery milestones. Record installation and each device observation separately.

The AeRift signing environment was absent when checked. Provisioning, upload and physical install remain pending.

## Physical Windows laptop ↔ iPhone run

1. Record the SHA, package/artifact checksums, build commands, OS/device models, architecture, WebView2 and Xcode versions, signing or distribution method, and network topology without private addresses. Install fresh builds on both devices. Launch both and verify they work without cloud sign-in.
2. Use ephemeral test identities and a receiver-owned test folder or sandbox. Put both devices on the same LAN. Deny iOS local-network access on first prompt, check the UI and retry after granting. Verify Windows firewall behavior with the normal private-network configuration and the app's expected permissions.
3. Discover and pair. Decline one invitation first and verify no saved trust. Approve a fresh invitation, restart both apps and verify trusted reconnect. Revoke and verify the previous pairing no longer permits sending. Re-pair with the other device initiating.
4. Prepare a zero-byte file, a binary file with a known SHA-256, and a generated 128 MiB test file if the storage budget allows. Keep fixtures in an isolated folder. Record size and SHA-256 before sending and against the actual saved bytes using an offline hash tool on each platform. On Windows use `Get-FileHash -Algorithm SHA256`. Keep the receiver app's destination appropriate for its platform.
5. Send by button in both directions. Before accepting, verify the destination has no new published file. Reject one offer and confirm zero publication. Accept fresh offers and compare hashes. Repeat with the empty, duplicate-name and large fixtures. Preserve and verify original contents after the duplicate-name case.
6. Cancel during an active transfer from each side, then interrupt a large transfer by briefly disconnecting the receiver from the LAN. Record both terminals, final file visibility, temporary-file cleanup where the adapter exposes it, retry behavior, and release of space. Repeat a successful transfer after reconnect.
7. Deny camera access, check ordinary controls, enable camera and send by gesture in each direction. Confirm exactly one offer per intent. Repeat with tracking loss, blur and target change before release. Record privacy observations without recording or retaining camera frames.
8. During the large transfer, test usable navigation and cancellation, keyboard focus on Windows, VoiceOver and touch on iPhone, and reduced motion. Record theme and OS accessibility settings, elapsed input-to-render timing where instrumented and any stall, loss of focus or dropped action.

Per case, record ID, UTC timestamp, SHA, both device builds, direction, fixture size and hashes, steps, expected and observed behavior, PASS/FAIL/NOT TESTED, and evidence reference. Redact invitations, identities, paths, personal filenames and frames.

## Build and run limits

The local host is Windows and can exercise Windows-native evidence once an installable artifact exists. Tauri's iOS build requires macOS and Xcode. The hosted `macos-15` foundation job cross-checks the Rust contract for the iOS simulator target. A hosted compile does not exercise the app UI or device installation. Xcode device installation additionally requires a signing and provisioning setup. A physical iPhone session and an AeRift-specific signing setup remain pending. [Tauri build prerequisites](https://v2.tauri.app/start/prerequisites/) · [Apple device installation](https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices)

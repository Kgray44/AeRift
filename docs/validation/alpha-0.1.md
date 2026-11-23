# AeRift Alpha 0.1 acceptance

**Release decision: HOLD.** The inspected foundation at `a34aaa2a4645fd2e4db844fcf0de843bb7cb2213` contains protocol constants and typed fixtures. No integrated Windows/iPhone release candidate or physical session was available at that baseline. The table records native outcomes. Update it against one exact integrated candidate before release.

| # | Criterion | Status | Evidence needed |
| --- | --- | --- | --- |
| 1 | Both apps launch | NOT TESTED | Clean Windows installer and provisioned iPhone install at the candidate SHA. Both show the native app. |
| 2 | Discovery or supported pairing method | NOT TESTED | Same-LAN peers visible or supported pairing flow recorded, with both invitation directions. |
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

The local host is Windows and can exercise Windows-native evidence once an installable artifact exists. Tauri's iOS build requires macOS and Xcode. The hosted `macos-15` foundation job cross-checks the Rust contract for the iOS simulator target. A hosted compile does not exercise the app UI or device installation. Xcode device installation additionally requires a signing and provisioning setup. No physical iPhone session or signing setup was confirmed for this validation baseline. [Tauri build prerequisites](https://v2.tauri.app/start/prerequisites/) · [Apple device installation](https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices)

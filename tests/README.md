# Alpha acceptance gates

Record the commit, app versions, platform versions, test inputs, observed outcomes and material failures. Keep receipts free of usernames, local paths, tokens and private file content. Browser-only evidence can support UI checks. Native launch and device behavior require the stated target.

| Gate | Required evidence |
| --- | --- |
| 1. Both applications launch | Install and launch a Windows build and an iOS build on a physical iPhone. Launch reaches the actual native host and shared UI without a crash or cloud sign-in. Record the Windows installer and iOS signing or distribution method. |
| 2. Discovery and pairing | Windows and iPhone discover one another on a normal LAN. The receiving user approves pairing. Pairing survives restart, and expiry, denial, untrusted requests and revocation are exercised. Confirm recovery after local-network permission denial. |
| 3. Bidirectional transfers with buttons | Send an ordinary file from Windows to iPhone and another from iPhone to Windows. Accept in the receiver UI and compare pre-send and saved SHA-256 hashes and size. Exercise rejection, cancellation, empty file, duplicate name, and an interrupted connection. Check integrity failure and cleanup with an automated fixture. |
| 4. Intentional gestures | On both native platforms, select a real file and paired target, arm and release an intent, and observe exactly one transfer offer through the shared action. Confirm interruption, stale or duplicate gestures, permission denial, and fallback to ordinary controls. |
| 5. Alpha install and end-to-end | On a clean Windows install and a physical iPhone install at the release SHA, pair and send real files by gesture in both directions. Verify the saved contents and repeat with buttons. Record the exact artifacts, logs with secrets removed, hashes and device results. |

The first gate establishes the installable slice. Each later gate keeps earlier flows usable.

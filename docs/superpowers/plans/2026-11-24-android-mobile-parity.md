# Android implementation and qualification plan

Follow the existing [Android architecture](../../android-mobile-workspace.md)
and current iOS implementation on main. The Windows/iOS glass and motion
changes are dependencies, not duplicated work. Reconcile against exact main
again before publishing the Android diff.

## What changes

1. **One mobile app:** keep destination structure, iOS user data, object/receipt
   schemas, gestures, glass, motion and accessibility. Extract only commands,
   copy, capabilities and storage scopes that need platform-specific behavior.
   An Android browser fixture is useful for parity, not proof of hardware.
2. **One transfer core:** bind the shared Rust session, pairing, identity,
   readiness and integrity-checked file transfer to the Android plugin.
   Kotlin owns Android platform dependencies: NSD and lifecycle, Keystore,
   media/documents, system viewer/share, and camera/hand landmarks. Activity
   results are bounded; JavaScript sees opaque selection or asset IDs, not
   unrestricted local paths or URIs. Keep consent and verified-receipt behavior.
3. **Private test builds:** pin the Android toolchain, test existing shared
   contracts, build and install the exact candidate in hosted Android CI where
   available. Keep test binaries and credentials out of the public source
   repository and its ordinary Actions artifacts. Produce APK and AAB for
   private testing using an owner-controlled signing process; no Play upload,
   public releases, or tester invitations in this task.
4. **Run qualification in layers:** browser shell/reduced modes and mocked
   receipt choreography; Android native installation/provider/camera-permission
   tests; then actual physical cross-platform transfer and gestures. A green
   component or emulator test does not establish physical interoperability.

## Acceptance record

| Potential result | Evidence needed |
| --- | --- |
| Phone layout matches iOS | Identical shared controls and state transitions; phone and tablet layout, system bars/IME/back, light and dark, Reduce Motion, accessibility. |
| Files and media work | Real system picker or provider, cancel/revoke, size+overflow, preview/share, failed copy cleanup, retry, app restart and durable stored imports. |
| Peers work between platforms | Discover, explicitly approve, exchange real files and compare digests Android↔iOS and Android↔Windows in both directions; reboot/reconnect, decline and revoke. |
| Gesture transfer works | Real camera with consent; pick up, hold, successful release/receive, interruption (background, camera loss, disappear), manual fallback, one offer, same receipt ID. |
| Build is ready for direct testers | Exact APK installs on intended ABI/device; signing lineage + report, SHA-256, no credential or private artifact published. |
| Build is ready for Play testing | Versioned AAB signed by the authorized upload key, supported target SDK, validated bundle/native alignment. Owner retains Play access and can authorize upload in a separate step. |

Do not claim parity, integration, or tester readiness for any unverified row.

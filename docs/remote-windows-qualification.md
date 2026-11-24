# Windows private Remote qualification host

This is an **explicit Windows development example**, absent from the AeRift installer and not registered as a WebView/native app command. It runs no startup service and performs no discovery or address lookup. Build/test it using the private-remote-host opt-in feature. Core Remote wire v2 keeps its file checkpoints across socket interruptions, not a Windows process restart. This example does not enable the Unix journal, integrate Friends, or test native direct internet/relay.

## Safety and operating limits

- Use two consenting devices on separate uplinks with a pre-existing approved private overlay such as Tailscale. Use a literal overlay IPv4 in 100.64.0.0/10 and a manually chosen fixed high port. The range itself does **not** prove an adapter or trusted VPN. Confirm the address/interface and access are already authorized in the overlay. Do not change routing/firewall rules or add port forwarding for this test. A blocked private route is an observed blocker.
- Close ordinary AeRift and any copied instances. For the supplied profile, the host takes the same exclusive OS profile lock as installed Windows AeRift, so native Nearby and this private listener cannot run simultaneously for the same identity. Do not use another profile as a way around that. A fresh eligible test profile is an existing user-owned local folder; using the normal profile explicitly reuses its DPAPI certificate.
- Remote grants are DPAPI-protected, scoped, and saved separately. A Nearby paired device is never added to Remote implicitly, even if the identity certificate is the same. Only targeted five-minute invites and explicit approvals authorize pairing. Remote revoke does not touch Nearby. Pairing, fingerprint coordination and sending are separate operator actions, and each file prompts the actual recipient. Do not copy invitation text, device fingerprints, IPs or filenames into public logs.
- Qualification is one synthetic file, maximum 256 MiB, with no service or background worker left running. Select a new empty receiver directory. The port must already be reachable in the private overlay. Keep it fixed on both computers when repeating the test; no random port or automatic selection is used. No test changes system configuration or installs this example.

## Commands

From the exact review branch root, on Windows:

    cargo test --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-host --example private_remote_host

Receiver:

    cargo run --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-host --example private_remote_host -- receive "<PROFILE>" "<RECEIVED_DIR>" "<PRIVATE_IPV4:PORT>"

Sender:

    cargo run --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-host --example private_remote_host -- send "<PROFILE>" "<SYNTHETIC_FILE>" "<PRIVATE_IPV4:PORT>"

Optional separate Remote revocation (while neither native host is running):

    cargo run --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-host --example private_remote_host -- revoke "<PROFILE>"

On a first run, both operators type PRIVATE TEST. Privately convey the intended sender fingerprint before the recipient creates the targeted invitation. Convey the inviter fingerprint and invitation securely; the sender verifies the fingerprint and explicitly approves pairing. The recipient only approves when the request identifies the expected sender. A saved Remote peer can send again without making a new invitation; the receiver must separately accept each test file.

Generating a 128 MiB sparse zero fixture under PowerShell is sufficient for transport integrity when allowed by the volume; retain only the local SHA-256. Do not use real files. After receipt, independently run Get-FileHash on the source and received file and compare them, along with the matching authenticated completion and recipient receipt. Capture only synthetic byte counts, matching digest, which route kind operated, exact build and separate-uplink evidence without address data. This code must not be described as verified across networks until that run succeeds.

# AeRift Remote private-network qualification

This is a development harness, not an installed-app feature. It uses ephemeral test identities and grants, never loads Nearby grants, and never advertises itself. The sender and receiver must explicitly approve pairing; after that, the receiver separately approves the individual file. All bytes use AeRift's existing pin-verified TLS and SHA-256 checks. The fixture cap is 256 MiB.

## Run on two independent networks

1. Put two consenting desktop test machines on different internet uplinks. Join each to an already-authorized private VPN such as Tailscale, or use a permitted routed private network. The receiver's literal private IPv4 and chosen port must be reachable under current VPN policy. Do not add Internet port forwarding, expose Nearby, change a live tailnet policy as part of the test, or use a public relay. Confirm the pinned commit on both test machines.
2. Generate a disposable 128 MiB synthetic file named `fixture.bin`; record its SHA-256 locally. Use a new empty receiver directory with enough free space. Use an address privately substituted for `<PRIVATE_IPV4:PORT>` below. Keep real addresses, device IDs, keys and invitations out of public logs; the invitation is entered interactively.
3. On the receiver:
   ```sh
   cargo run --locked -p aerift-peers --example private_remote_qualification -- receive '<PRIVATE_IPV4:PORT>' received
   ```
4. On the sender:
   ```sh
   cargo run --locked -p aerift-peers --example private_remote_qualification -- send '<PRIVATE_IPV4:PORT>' fixture.bin
   ```
5. Privately convey the sender fingerprint to the receiver. The receiver creates a five-minute targeted invitation and shares the code privately. The sender checks the inviter fingerprint and redeems; the receiver checks the authenticated fingerprint and types `yes`. Wait for the separate file prompt, then accept it. Verify the sender's completed receipt and the receiver's completed/published receipt. Independently hash the resulting file and compare to the original. Stop the receiver after the sender confirms receipt.
6. Record commit, OS pair, separate-uplink evidence (redacted), route kind, byte count, elapsed time and digest match. When testing with Tailscale, its direct or DERP telemetry describes the VPN underlay, not an AeRift-native routing capability. Repeat in reverse roles if qualifying both directions.

## Evidence boundaries

Loopback and independent local processes are not cross-network evidence. A successful private VPN test does not qualify native NAT traversal or AeRift relay fallback. This example does not use real platform key storage, mobile gestures, background operations, queues, folder transfers, or resume offsets. All of those remain separate gates.

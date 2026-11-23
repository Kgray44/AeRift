# File transfer verification

```sh
cargo test --manifest-path crates/transfer/Cargo.toml -- --nocapture
```

The executable integration test starts two independent processes on dynamically assigned loopback ports. Each sends a distinct 3,145,745-byte binary and an empty file over TLS 1.3, with automatic fixture consent. TLS in this fixture uses ephemeral generated CA-signed leaves and checks the exact fingerprints on both ends. The production self-signed pairing handshake is covered separately in aerift-peers.

The harness checks binary SHA-256, byte counts, intermediate monotonic progress and remote-confirmed completion. Separate HTTP tests cover duplicate names, retained cancellation progress and clean partial removal, success after a lost completion response, idempotence, cross-peer isolation, length checks and integrity errors.

For native device acceptance, record the exact app versions and commit, send real files both ways over the same LAN, and compare file size and SHA-256 on both endpoints. Check rejection, cancellation, duplicate names and interruption using the real app controls.

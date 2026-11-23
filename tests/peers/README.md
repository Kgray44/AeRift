# Peer verification

```sh
cargo test --manifest-path crates/peers/Cargo.toml -- --nocapture
```

The integration test creates two listener sockets and separate identities and stores. It exercises fingerprint mismatch, approval and denial, reply retry, trust reload, revocation, and file transfers in both directions over the production self-signed TLS transport. It uses memory-backed fixture stores and loopback.

On a host with a multicast-capable interface, also run `cargo test --manifest-path crates/peers/Cargo.toml --test discovery_lan -- --ignored` to exercise DNS-SD advertisement, resolution and removal.

Run the interactive example in two terminals against an existing empty receiver directory and an ordinary local file. Pick an available port and use the same port in both commands. Copy the invitation into the sender's prompt and approve pairing and the file in the receiver terminal.

```sh
cargo run --manifest-path crates/peers/Cargo.toml --example loopback_node -- receive 127.0.0.1:43180 ./receive-directory
cargo run --manifest-path crates/peers/Cargo.toml --example loopback_node -- send 127.0.0.1:43180 ./sample.bin
```

The example uses ephemeral identities. Run it in an interactive terminal so the displayed invitation stays out of captured logs. The manual socket example bypasses discovery while exercising the same pinned TLS and pairing protocol. On a physical iPhone and Windows PC, qualify DNS-SD, local-network permissions, protected store reload, revocation, and transfers through the host application.

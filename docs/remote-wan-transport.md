# AeRift Remote native WAN transport candidate

**Status:** standalone, opt-in transport library. This is not remotely enabled
in any app build. It is a follow-on to the independent invite-only Remote lane
and private routed/VPN qualification from #58. It does not change Nearby,
device lists, pairing grants or the existing Cargo workspace/toolchain floor.

## What this adds

- A bidirectional Tokio stream over [Iroh QUIC](https://docs.rs/iroh/1.5.0/iroh/).
  The dialer pins the explicitly exchanged outer endpoint key. The receiver
  consults a caller-supplied allowlist of pending-invitation or Remote-authorized
  outer keys before handing any stream to the app. There is no lookup by peer
  name or key: the dialer must supply at least one explicit address or the
  approved relay.
- Direct QUIC routes and an optional operator-only HTTPS relay. Iroh manages
  path selection and NAT traversal when network and relay config support it.
  No default, staging, public, or implicit relay. A relay contained in a peer
  route is rejected unless it exactly matches the local operator selection.
  Ordinary HTTPS certificate verification is required. No public DNS/Pkarr
  publication, global directory, local discovery, UPnP, or cloud file storage.
- The chosen path is observable as direct or relay without exposing addresses.
  The relay forwards encrypted QUIC packets, not AeRift file data in plaintext;
  transport acknowledgment is not AeRift recipient consent or verified receipt.

## Composition contract (not yet wired into the apps)

Keep existing Nearby discovery and authority, and prefer compatible local
paths (or explicitly configured VPN) when authorized by that product lane.
Never promote a Nearby grant to Remote. A future Remote host can pass this
adapter's byte stream to the **existing Remote-only inner pinned mutual TLS
lane**, with its independent certificate trust, invitation and per-offer
recipient decisions intact. Retain both identities: the outer route key is
not a user-facing identity or a substitute for the inner certificate. The
host must persist its outer private key in native protected storage and bind
a peer route key to its inner certificate in the existing authenticated
invitation or Remote-authorized route exchange. No invitation is emitted by
this adapter, no public advertisement, and no token or user metadata should
enter relay logs. Never send with only the outer transport's assertion.

The caller must update the allowed outer-key set when invites expire or are
cancelled and when Remote trust is revoked, and cancel live streams according
to the existing inner Remote authorization lifetime. The adapter does not
grant permissions, operate a relay, offer app UX, or implement transfer
durability. An operator deployment requires its own authenticated endpoint
allowlist, limits, monitoring, and metadata retention policy, separately
approved. If native WAN cannot be used, keep a remote error honest and never
fall back to accepting an untrusted peer.

## Qualification

```sh
cargo test --manifest-path crates/remote-wan/Cargo.toml --locked
```

This standalone package uses Rust 1.91+ without changing the product
workspace's declared minimum. Socket tests are restricted to loopback and a
test-only HTTPS relay; the tests do not contact a public relay. Native WAN
and NAT path migration across two independent uplinks, production operator
configuration, inner AeRift protocol integration, physical mobile behavior
and platform builds are separate gates. Record observed selected route,
authenticated identity, actual per-file receiver acceptance and verified
file digest across authorized independent uplinks before enabling in apps.
Egress and relay traffic must be limited to explicitly authorized endpoints.

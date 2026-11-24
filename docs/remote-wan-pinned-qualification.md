# Pinned Remote TLS over an explicit WAN route

This optional library seam is not an app feature or a published service.
It composes the Remote product authorization lane from #58 with the WAN
transport from #62, but does not change the Nearby TCP path or require Iroh
in the base platform peers crate.

The routed receiver must supply the expected inner AeRift certificate
fingerprint from an authenticated binding of outer key to inner device. A
successfully authenticated QUIC endpoint is not sufficient: the shared
Remote-only TLS ALPN, certificate proof, pinned server fingerprint, expected
client fingerprint and Remote grant still control the complete HTTP protocol.
The same invite service and recipient consent gate execute on this path;
the routed bytes cannot introduce Nearby trust or bypass explicit acceptance.

The test uses an HTTPS relay bound to loopback, a test-only CA, and two Iroh
endpoints with all direct/UDP transport removed. Both endpoints observe Relay
as selected. Using the correct outer key with an unrelated inner certificate
cannot redeem a targeted invite. The correct device redeems only after the
recipient confirms, and the separate file offer publishes only after recipient
acceptance. The test verifies a SHA-256 digest, a completed receipt, and denial
after Remote revocation. It does not exercise any production service or two
independent uplinks.

Run:

```sh
cargo test --manifest-path crates/remote-wan/Cargo.toml --locked
cargo test --workspace --locked
```

The native host must supply protected outer key persistence, the authenticated
outer-key/inner-fingerprint association, explicit opt-in startup and bounded
ingress. No untrusted route parsed from an invitation can configure a relay;
the operator's allowlist and HTTPS trust settings are separate from invites.
Before enabling apps, integrate the current resume and platform lanes and prove
at least one direct NAT-traversal transfer and one relay transfer across
authorized independent uplinks, including scoped revocation and no Nearby
fallback in both paths.

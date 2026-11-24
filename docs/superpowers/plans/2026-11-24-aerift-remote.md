# AeRift Remote initial implementation plan

> **For agentic workers:** Use test-driven-development and executing-plans. Track results separately from future work.

**Goal:** Add an opt-in, separately authorized Remote peer core with private routed TCP qualification without modifying Nearby authority.

**Architecture:** Use separate Pairing state and trust-store interfaces and a Remote-only pairing route and code envelope. Keep existing mTLS, transfer digest, explicit consent and receipt implementation.

**Tech Stack:** Rust, Tokio, rustls, Hyper; no additional dependency.

**Spec:** docs/superpowers/specs/2026-11-24-aerift-remote-design.md

- [x] Test a local grant against the same certificates on a distinct Remote listener; require denial. Reject nearby invitations on Remote before dialing.
- [x] Add shared transport lane discrimination and dedicated Remote API, bounded routes, and separate stores and listener.
- [x] Test explicit invite approval, expiry/rejection scope, offer acceptance and isolated revoke with real sockets and bytes.
- [x] Run locked workspace tests and fmt.
- [ ] Verify exact branch CI. Publish optional core only, no app activation.
- [ ] Subsequent qualification: see design for two-network test, platform integrations, and native WAN protocols.

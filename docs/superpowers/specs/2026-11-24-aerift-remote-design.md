# AeRift Remote: deliberately invited peers

Nearby devices are discovered; Remote devices are invited. Nearby remains fully offline, with DNS-SD/Bonjour, explicit approval and a six-digit comparison as the target verification UX. The existing nearby v1 code remains compatible; it does not yet provide the six-digit comparison.

## Boundaries

- One local certificate identity per device is reusable across lanes. Nearby and Remote have distinct persistent-grant interfaces, listeners, TLS ALPN values and invitation parsers. The native apps do not yet persist Remote grants; the core takes a separately scoped store. Local grants, DNS discovery, VPN membership and reachability never imply Remote permission. Keep the two lists, consent prompts and revocation controls separate in the app.
- Remote has no public lookup, public address publication, mDNS advertising or enumeration. An invite is created deliberately, expires at the inviter, pins the inviter ID and carries a 256-bit capability bound on the inviter to the expected recipient fingerprint. That fingerprint is exchanged privately before an invitation is created; copying the invite does not authorize a different device. The redeemer explicitly opens it; the inviter separately confirms the mutually authenticated device over the pinned channel. Keep the code out of logs, telemetry, URLs sent to a service, and command line arguments. Only out-of-band holders get the invitation.
- The initial Remote component uses the existing peer mTLS/protocol on an explicitly configured private IPv4 or Tailscale interface. The app remains unchanged and this core is not automatically started. Remote transfer acceptance is independent of pairing; do not expose or use the nearby readiness lease. No publicly accessible listener or service is deployed.
- Separate stages: install platform-protected Remote stores and an explicit Remote UX; harden the existing nearby wildcard listener's network scope before exposing a native product Remote listener; qualify genuine two-uplink VPN transfers; add native NAT traversal and opaque relay; add durable resume, folders, queue and mobile lifecycle. Do not claim network isolation from the fact that two ports exist: a port forward, subnet router, or broad firewall rule may accidentally expose the legacy Nearby listener.
- Future person-level identity adds optional groups of independently identified devices. Never authorize an entire person group implicitly, and keep each revocation independently enforceable.

## Transport choice

Explicit private VPN routing is the lowest-cost first route for known peers. Raw internet TCP forwarding is not an acceptable substitute for NAT traversal, and forwarding deals with inbound exposure poorly. For native WAN, compare explicit self-hosted relay with opt-in QUIC NAT traversal using a maintained library such as [Iroh](https://docs.rs/iroh/latest/iroh/). Require authenticated private rendezvous, explicitly configured relay, bounded sessions and bandwidth, no DNS/Pkarr/global lookup, and preserve the peer certificate pin plus application consent above the selected route. Relay may know route metadata but not offer names, file content, invitation capability, or digest; it never stores files. A Tailscale direct or DERP transfer does not qualify AeRift's future native NAT/relay.

## Qualification

See [the private-network qualification harness](../../remote-private-qualification.md).

On two authorized independent networks, send a generated fixture; approve on the recipient; compare byte counts, receiver-side SHA-256 and verified receipt; log route kind without recording addresses or secrets. Separately test wrong pin, used/expired invites, revoke isolated by scope, and cross-route interruption and resume. LAN/loopback tests are regression evidence only. iOS background continuation cannot be promised for arbitrary peer sockets; use durable queue/resume, appropriate platform scheduling, and actual OS qualification instead.

# Nearby six-digit verification

On Windows or iOS, open **Pair a device** on both devices on the same local
network. On one, select **Pair nearby** alongside a discovered unpaired device.
On the other, open **Review pairing**. Compare the six-digit number on the two
screens and select **Codes match** on both. If the numbers or physical devices
do not match, decline. The number is not a PIN, password or Remote invitation.
A request expires after two minutes even if one side has already approved.

The pairing exchange uses the existing TLS 1.3 device identity, a versioned
Nearby-only RPC and an exporter over the initial TLS connection bound to both
ordered certificate fingerprints. Digits are derived independently and never
included in a request or response. The host checks that the authenticated
connecting identity and its source address match an observed local DNS-SD
record, and the requester must choose a discovered identity. Approval on only
one device does not save a grant. The same local trust and transfer flow applies
after pairing. This change adds no relay, public lookup, account or Remote
permission.

Automatic fallback is not used. **Legacy local invitation** remains an explicit
interoperability option for older binaries and is labeled as not using six-digit
verification. Previously paired devices retain their existing LAN trust. Android
does not inherit native pairing support until its separate host is integrated;
macOS and Linux do not yet run the native device app peer runtime on this base.

Qualification:

- Run `cargo test --locked -p aerift-peers`. Check that actual TLS sessions
  display six matching ASCII digits, each one-sided approval leaves trust empty,
  rejection leaves both stores unchanged, stale request IDs are rejected, and a
  listener without a native discovery policy refuses Nearby.
- Open two current desktop/mobile apps on the same isolated LAN. Record versions,
  DNS-SD candidates (redacted), matching displays, pending-only state after the
  first approval, and paired state after both. Repeat with each role in turn.
- Decline, leave a request to expire, and try the legacy compatibility path.
  Then send a synthetic file and verify its recipient receipt and digest.
- A loopback integration test verifies the TLS pairing logic, not real-device
  multicast discovery, OS permission prompts or the physical cross-device UX.

## Wire extension

The base LAN service advertisement and existing LAN protocol are unchanged.
The additive Nearby protocol uses POST JSON control requests on pinned TLS:

- `/v2/nearby-pair/start`: `{name, platform}` → `{id, device}`. The
  respondent supplies a random request UUID. The displayed value is the
  first 64 exported bits reduced modulo 1,000,000 and formatted with leading
  zeros. Exporter label: `EXPORTER-AeRift-Nearby-v2`; context: the lower-case
  hexadecimal initiator and responder leaf fingerprints separated by a colon.
- `/v2/nearby-pair/finish`: `{id, accept}` → responder device after both
  approve; JSON null for requester decline. Only the requester’s original
  authenticated certificate may finalize. One pending inbound comparison is
  allowed per host. Expiration invalidates the request. Authorization remains
  the existing LAN trust grant, not a transferable token.

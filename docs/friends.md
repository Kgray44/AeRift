# AeRift Friends: governing architecture

**Status:** Owner-directed architecture. The initial shared-core gate and capability-gated desktop/mobile workspace are implemented in this change. Native adapter and Remote wire integration must meet the exit criteria below before Friends is enabled.

AeRift moves objects to people, not just machines. Friends is a distinct destination on desktop and mobile. It is deliberately private, not a social network, account directory, or cloud drive.

## Authorization lanes

| Lane | How a destination is found | What authorizes it |
|---|---|---|
| Nearby | LAN discovery; works offline | Explicit local pairing and verification |
| My Devices | Owned device enrollment | Independent proof that a particular device is mine, with separate revocation |
| Remote Devices | Deliberately issued invite, never automatic discovery | Exact Remote device grant over authenticated Remote ingress |
| Friends | Private, expiring friendship exchange, never automatic discovery | Mutually consented person identity, individually enrolled device, permitted action and explicit per-transfer acceptance |

These lanes reuse the existing TLS device identity, transfer implementation, storage adapters, gesture controller and presentation, but no lane implies another. An enrolled friend device belongs under its person presentation, not in the ordinary paired inventory because of that enrollment. If the same hardware was independently paired for Nearby or enrolled as My Device, those independent grants are neither silently promoted nor revoked by Friends. UI may identify a nearby advertisement without exposing that it belongs to a friend. No global key lookup, searchable alias, phone-number index, contact upload, or directory exists.

## Person and device claims

- Person authority is one Ed25519 public key. The private root stays in independent platform-protected storage. Do not copy it to every enrolled device. Initial enrollment uses the authority device or a later separately designed recovery/authority continuity mechanism; no silent migration from device certs.
- For initial pairing each side deliberately exchanges a privately shared signed card (valid up to 24 hours) with its person public key and pinned device identity (link, code, or QR transport in the app layer). This lets the issuer target a specific recipient instead of issuing an untargeted bearer credential. Each side verifies the person/key through a known private channel or in-person comparison. A signature proves key possession, not legal name or identity.
- The issuer signs a five-minute UUIDv4 invitation, with both person IDs and both TLS-pinned device IDs in a versioned domain. The recipient sees the card, explicitly consents, and signs acceptance. The issuer explicitly confirms that acceptance, cryptographically binding both signatures to the same transcript. Only after verifying the final transcript and matching the Remote TLS leaf can local storage admit the friend. Tokens are not collected by analytics, pasted into shared logs, or published.
- Additional device enrollment needs a fresh instruction from the same person key binding the current relationship UUID and the exact device TLS identity, proof of possession on that device's Remote session, and local admission. Do not derive membership from names, IPs, nearby presence, family sharing, or key continuity claims lacking prior proof. Disable automatic trust after an offline/unknown revocation status.
- Persist user-visible labels independently of verified public keys. Names are sanitized display data and never authorize behavior. Native store adapters must provide protected, atomic durable compare-and-swap. They must keep each person profile separate and turn storage errors into an explicit failure rather than interpreting them as unclaimed offers. Keep separate envelopes for person secret, friendship policy, Remote routes, and local transfer history.
- Revocation acts on each authenticated device and on friend identity separately; use tombstones or monotonic grants, terminate the appropriate active lease, withdraw pending offers, remove availability immediately, and never reassign an already claimed payload. Friend removal collects outstanding permissions and may preserve local history if UX makes that explicit. Recovering from an actual person-key loss currently requires new deliberate enrollment. This version treats removed/reissued invitations as distinct nonces.
- A revoke in this shared core denies future award or payload admission; host route must invoke a per-transfer cancellation lease to stop an in-flight stream. This implementation itself does not send revocation messages.

## Transfer and truthful state

1. The sender stages the object via existing platform pickers or workspace handles. A stable offer UUID identifies an immutable manifest hashing object names, sizes, kinds, canonical entries, and file digests. Preserve source consent for clipboard and links. Folder snapshots have bounded enumeration, normalized safe paths, and no external symlink traversal. Photos/video use the media pickers; links/notes/clipboard are explicit typed content and never open or overwrite automatically.
2. For a targeted device, include only that enrolled endpoint. For a person, capture the currently authorized endpoint set. Propagate a bounded invitation-only metadata offer over pre-authenticated Remote sessions, with explicit acceptance shown on each eligible receiving device. No automatic send based on presence or ready status.
3. The sender is the single coordinator for that offer. One atomic durable award happens before bytes. A receiver can render tentative acceptance immediately but cannot claim successful acceptance until it receives the recorded grant. Concurrent accept attempts lose, and the other prompts display Withdrawn when reconciliation reaches them. A sender crash does not authorize a second winner. A lost grant response is repeatable by the identical winning device and manifest, not a second award. If the sender is unreachable, do not accept speculatively. A pending descriptor can queue locally while both endpoints are unavailable; no server stores the user's transfer payload.
4. Bind payload start and subsequent reads to offer UUID, immutable manifest digest and exact authenticated winner device. On interruption, any durable resume is only for the already selected winner and last verified checkpoint. Do not claim delivery until existing native integrity verification and correlated receipt succeed; animate Withdrawal, Ready, Transferring and Verified as distinct states.
5. Display availability only from fresh authenticated probes of an enrolled device with a TTL and explicit access permission. Showing text sent/redeemed does not establish online state. Do not display private IPs or general presence outside the workspace. Keep pending offers and authenticated history keyed by person plus exact contributing device; native data outranks any animation timer.

## UX

- Desktop: Friends is a first-class Orbit/sidebar destination with an accessible list on the left and a selected person's workspace on the right. Prioritize Send, trusted device list, permission controls, pending and history; group endpoints under the person. A quiet private invite empty state does not pretend to have public search.
- Mobile: preserve the shared workspace design and move from list to detail with directional, reduced-motion-aware transitions, semantic back navigation and managed focus. Reuse existing light/dark Glass semantic surfaces, interaction states, and Rift engine; Friends does not define a new design system.
- Manual sending and gestures use the same authorization and receipt states. A deliberate selected friend is an admissible target; a blind gesture must never guess a friend. A receiver gesture is an explicit acceptance only while the clearly identified offer is active and the user has enabled that behavior.
- Expose Friends only when its complete native port is available. Test fixtures may exercise UI components but never appear in a live build. Hide unsupported actions or present honest disabled states; a web-only or offline preview is not an acceptance claim.

## Evidence and release gates

The first shared-core slice tests persistent person identity, signature and device transcript binding, expiration, replay, independent receive policy, concurrent one-winner durable award across store reopening, manifest mismatch, one-use stream start, and revocation. Existing LAN tests remain the baseline. The frontend registers a Friends workspace only on authenticated native snapshots advertising an operational Friends capability. Frontend synthetic tests do not establish a native Friends feature or a qualified network route.

Before enablement: protected operating-system adapters; full key enrollment/recovery model; signed wire envelopes + authenticated Remote host bridges; real multiple-device offer/withdrawal; native app testing in both themes and reduced motion; scoped gesture staging and object policy; protected queue/history/presence; in-flight cancellation; file/manifest/receipt and resume proof across distinct networks; Windows, macOS, Linux, iOS and Android evidence reported separately. No app release is implied by a draft or green shared Rust CI.

The bounded preview store intentionally does not compact historical invitation or offer rows yet. Before production enablement, add expiry-safe replay tombstone compaction and terminal-history retention with authoritative, monotonic checkpoints. In-memory tests verify the CAS contract and re-opening behavior, not OS-durable storage.

### Private offer-control qualification

The stacked control slice reuses Remote's explicit private IPv4 route policy and shared pinned TLS connector, but negotiates a dedicated Friends offer ALPN. It exposes exactly acceptance and status for an already known offer UUID and manifest digest. Each authorization derives the device from the actual mutual-TLS certificate, not from a field supplied by the client. Unknown or revoked devices cannot retrieve offer status or claim payload; losing authorized devices learn only that their prompt was withdrawn, not which device won. Offer polling communicates withdrawal when the losing device can reconnect. Nearby and Remote Device traffic cannot negotiate this Friends listener. No implicit binding or service advertisement is added.

The loopback fixture runs independent generated TLS identities and concurrent acceptance over real TLS sockets. It is not a real external-network test. It does not prove native persistence, friendship invitation transport, offer fan-out, payload/stream gating, or native UI. Keep the native capability disabled until all gates above pass.

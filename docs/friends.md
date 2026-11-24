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

### Windows native storage bridge

The opt-in Windows bridge opens a separate local `friends-v1` profile under the app's current-user data directory. It takes its own OS file lock for the lifetime of the book so cross-process writer races fail closed. The different protected envelopes for the person signing key and the authority/offer ledger are current-user DPAPI ciphertext. Ledger writes compare the encrypted profile's latest decoded revision, sync a staged encrypted file, and issue a same-directory Windows write-through replacement. An existing ledger with unavailable person-key material is not silently reinitialized. The DPAPI envelope's existing per-file limit also bounds this first adapter; retention/compaction remains an enablement prerequisite.

Native Windows tests cover ciphertext/profiles, stale compare-and-swap, exact winner across profile reopen, no replay of stream-start, and isolation from Nearby stores. The local Linux cross-check only type-checks the Windows DPAPI/atomic replacement module against native bindings; an actual Windows CI run must execute the full bridge tests. There is no automatic native startup, command registration, capability snapshot or listener rollout in this change.

### Authenticated metadata fan-out

The shared Friends control lane can now send an immutable preview (kind, safe label, byte count, bounded expiry, exact offer and manifest digest) separately to the trusted route of each individually enrolled device. Both exact destination identity and exact source transport leaf are verified, and the sender/recipient person relationship must already exist and allow incoming offers. The inbox writes once on identical retry, re-opens pending notices, and never grants or transfers content merely by receipt. Explicit acceptance invokes the sender's one-winner ledger; reachable losing devices refresh the authoritative withdrawn decision. A disconnected loser may still show a pending notice until refresh, but cannot accept successfully. No case turns a stale notice into a second payload claim.

Three independent TLS listener/device fixtures prove the control flow over loopback. The recipient's additional device roster is synthetically provisioned in the test; actual owner-authorized roster distribution, native background uptake, true cross-network discovery/route setup, secure invitation wire setup and payload streaming remain separate. No Friends snapshot is activated in production.

Each delivery issues a durable endpoint-bound random control ticket before sending, so missing delivery ACKs are recoverable without allowing award/status calls from an endpoint that has no ticket. The receiver records its explicit acceptance intent before contacting the sender and rechecks its own unexpired offer and live grant after the response; a lost acknowledgement does not permit another winner. The eventual payload adapter must verify both canonical manifest digest and the exact displayed object metadata, rather than treating the current metadata-only control as file authorization.

### Targeted friendship and roster-device admission

The shared library can run a separately opted-in invitation listener on the same restricted private-route/pinned TLS transport as Friends offers, with a different ALPN. There is no invitation search or unknown-peer submission. The issuer first saves one signed, exact-person/exact-device five-minute invitation and shares it privately. Its target may submit a signed consent only on its exact TLS connection. The issuer's separate approval durably commits the local grant and dual signed outcome together. The target first durably stores its consent, then reads back that exact outcome from the pinned issuer before committing its own grant; either side may reopen its local book during the exchange. Cross-device grant status can be temporarily asymmetric when a revocation races an already authenticated outcome, so offers and eventual payload must recheck live scoped grants on both endpoints. Replays of a previously removed or revoked relationship cannot recreate it.

Additional devices use a short-lived grant signed by the person's authority for the current relationship. The local user explicitly approves the exact new device first; only the matching new TLS identity can consume the private enrollment ticket, once. An acknowledged retry may report the same active enrollment, but an expired, removed, or revoked device cannot reuse a ticket. None of these operations modify Nearby or ordinary Remote trust.

Tests use independently generated device certificates and actual loopback TLS; issuer consent survives reopening the protected-store interface. Private exchange UX, authority recovery and roster distribution, external route qualification, durable platform adapters beyond the Windows slice, native consent and transfer/gesture enablement are still separate gates.

### First guarded file payload

A separate Friends-only payload ALPN now sends bounded single files (64 MiB proof-stage limit) through the shared v1 streaming, authenticated receipt and SHA-256 publication engine. The sender records a single durable start for the awarded recipient, dials only that device's pinned TLS certificate, and rechecks current authorization before each new file frame. The receiver does not accept merely because the TLS connection exists: it checks that the sender and destination certificates match a current recipient-consented award, the purpose and local permission still match, and the immutable manifest and displayed name/size describe the exact shared file offer. It reserves that admission durably before its scoped receiver may open a file. Shared stream logic rechecks the scope before each frame and serializes final verification/publication against permission and revocation mutations in the same live book. Do not share its receiver table with Nearby or Remote Device routes.

A synthetic loopback test sends real data only to the winning certificate and compares sender completion, matching receiver receipt UUID, disk bytes and independent recomputed SHA-256. It tests no consent, wrong loser route, modified source, revoked receiver admission, sender restart/replay, explicit cancellation, and active sender revoke without publication. Restart does not resume a consumed v1 acceptance; durable data resumability must be designed over the shared Remote v2 checkpoint path. Open receipt snapshots are session-scoped, and bytes already delivered before revocation cannot be retracted. This is not an app, WAN, large-file performance, or cross-platform qualification.

A v1 reservation is intentionally one-shot even when capacity, process restart, or a post-reservation network error prevents success; re-offer deliberately rather than reusing that grant. Production recipients must use one protected, exclusive live book per runtime for final revocation interlock (the Windows adapter holds a profile lock); per-frame persisted policy checks are proof-stage and need benchmarking/optimization before the larger-file limit changes. Native staging must pass only private, picker-owned regular files to these APIs; an arbitrary path received over IPC is not an admissible staging capability.

### Test-only native Windows profile qualification

The native Windows unit-test target now runs the full bounded single-file Friends route using independent real DPAPI-backed device keys, person authorities and ledgers in fresh temporary profiles. It deliberately binds only fresh loopback sockets and never mounts the desktop Friends workspace or a real user profile. The fixture verifies wrong-device invitation rejection and zero content before acceptance; the approved transfer checks sender and receiver receipt, exact content and SHA-256; then the sender stops its control listeners and reopens its actual protected stores while the recipient stays online, requiring the replay to fail with the consumed-authorization conflict.

To run on Windows: `cargo test --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --lib friends_native_profiles_qualify_private_invitation_offer_and_verified_payload`. The existing Windows app CI includes this test. This is host qualification, not live UI, other OS qualification, WAN testing, or feature enablement.

### Normal Windows product setup

On Windows, the ordinary installed app exposes Friends only after the main
window has opened the OS-protected person identity and contact book. No special
launch argument or build option is required. iOS/Android and unsupported
desktop hosts do not advertise this capability. The Windows setup page uses
the same Friends materials and desktop list/detail workspace as the gated
full product.

Two Windows users can build a verified contact if both are running AeRift and
can reach each other over an existing private IPv4 LAN/VPN route:

1. The recipient shares their signed contact card over a private channel.
2. The inviter copies that card into Friends and enters their own LAN/VPN IPv4
   address that the recipient can reach. This explicit action starts a
   five-minute listener on that address and an OS-assigned port.
3. The inviter shares the generated private invitation. The recipient reviews
   it against their exact identity, compares the inviter's full fingerprint
   out of band, and explicitly sends approval. Import and review do not dial.
4. The inviter verifies the recipient fingerprint and explicitly approves.
   The recipient selects **Check inviter approval and finish** before expiry.
   Each profile persists its own verified roster. If the listener exits early
   or is blocked by a firewall, create a fresh invitation after expiry. The app
   does not add firewall rules, configure VPNs, or contact anyone.
5. Remove the friendship, change inbound offer permissions, or revoke a
   previously enrolled device from its contact. These are local policy changes.

The envelope signs the route along with the exact invitation fields using
the issuer's person key. The actual connection still pins the issuer device
certificate, requires recipient possession of the exact device key, and uses
the separate invitation mTLS protocol. Public, wildcard, hostname and IPv6
routes are not accepted on this setup path. No route is discovered or shared
globally. A single active local invitation is allowed; creating another
doesn't interrupt a recipient who's finishing an approved one. A setup
invite is not a Nearby, My Device, or general Remote grant.

This setup flow enables **friendship setup and local roster management**. It does
not expose sending, offer/history, additional-device enrollment or remote
online status in the installed app. Existing authenticated data-plane tests
remain separate evidence; they are not proof of an installed-app delivery
route or WAN reliability.

### Windows private-file transfer window

Two verified Windows Friends can explicitly open five-minute file windows on
their own reachable LAN/VPN IPv4 addresses, then privately exchange the
shown offer/payload addresses. The sender names the exact authorized device,
provides both of its routes, and chooses one file (maximum 64 MiB) in the
native picker. Only signed and authenticated consent metadata is delivered.
The recipient reviews the sender device and filename, provides the sender's
offer address, and accepts locally. Payload is still not sent until the sender
selects **Send accepted file**. A declined, wrong-device, changed, withdrawn,
expired or duplicate transfer cannot publish a file. The default output is
`FriendsReceived` within the profile; no app command takes a raw source path.

These routes are not a grant: transport independently pins the device
certificates. No public or wildcard addresses, rendezvous, directory, Nearby
authorization, general Remote authorization, hidden route discovery, background
retry, or auto-accept policy are introduced. Closing the explicit window
cancels both listeners and active sends; a new attempt requires a fresh offer.
This iteration addresses **one chosen authorized device** rather than
discovering or fanning out to an unavailable roster. Person-targeted payload
selection, folders/objects, mobile and hands-free flow require further product
integration. Native hosted proof and physical/network coverage are separate.

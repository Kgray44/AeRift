# Ambient A4 single-file session core

The native session owns an A2 frozen capture before selecting a recipient.
It supports the existing single raw file representation only. The source
monotonic clock bounds the hold to 30 seconds. A first valid drop opens a
500 ms contention window. Repeats from the same authenticated peer are
idempotent; conflicting peers require a new pickup. No offer/data is sent
while resolving contenders.

The native adapter must bind an explicit receiver drop to the exact
interaction ID and the authenticated transport's peer. Local policy must
authorize that peer in the exact lane on claim, resolution and dispatch.
The connector pins the chosen identity and preserves revocation handling.
Drop does not imply acceptance: the existing transport creates the actual
offer and requires receiver consent. A5 only receives the interaction epoch,
sequence, phase, count, and progress or verified completion where applicable.

This is not a discovery service or control wire protocol. Real clients
do not yet exchange A4 claims or produce A4 offers. The next adapter must
authenticate and replay-protect the native control route, enforce current
scope grants, and publish host projection frames to A5. It must replace the
projection epoch after an ambiguous attempt. Tests simulate the drop
boundary and exercise the real transfer implementation over a local
harness; not physical hardware, mobile integration or cross-network proof.

## Nearby drop claim control route

The recipient host starts selection only after an explicit opt-in drop.
It supplies at most 16 distinct, currently reachable paired Nearby peers from
its local roster, using its existing exact-pinned connectors. In a single
two-second window it queries each in parallel, requires a complete result
set, and sends a claim only if exactly one source is actively holding.
Two sources are ambiguous; no claim is sent, and a new drop is required.
An absent, unsupported or timed-out answer is not treated as an idle peer.

The optional source-side route accepts GET/POST only after Nearby TLS
authentication and live lane authorization. An idle opted-in source returns
an authenticated negative result. An active source issues one random
challenge per peer, scoped to that pickup and its existing expiry, with no
object metadata or internal session ID. POST requires the exact unspent
challenge bound to the verified TLS leaf, and rechecks the authorization.
The response means "claim recorded," not "destination won" or "offer
accepted." Two distinct recipient claims in contention still prevent
dispatch. The v1 receiver still requires explicit acceptance.

The host must close the claim service on pause, lock, cancellation or
shutdown; separately cancel any dispatch it already resolved using its
normal cancellation token. The native adapter must not expose the route in
the generic transfer router, Remote, Friends, multicast, or the renderer.
The authenticated loopback tests cover both a single active source and
multiple simultaneous sources. Native mounting, gesture activation and
physical-camera/device acceptance remain open.

## Windows host seam

The native coordinator starts with A4 disabled. The Windows extension to
AmbientRuntime exposes separate native opt-in and explicit pickup/drop
actions; promoting a frozen slot requires its exact ID and consumes it
without recapturing. The hold age starts at the original capture. There is
no new camera activation, global shortcut, or renderer-exposed command.
Changing the exclusions, disabling Ambient, locking the interactive
desktop, or pausing invalidates the held pickup and cancels the matching
native generation. Returning to the desktop never restores old authority.

Integration must register visible user actions and provide the current
Nearby paired/pinned roster. The existing AppRuntime listener starts at
the serve_with_nearby call in runtime.rs; it currently owns the native
discovery predicate. The dedicated branch belongs after the verified TLS
leaf, confirmed Nearby identity/address scope and live pairing grant in
that listener, never in the common route() function shared with Remote.
The existing transfer/pairing routes should receive all unrelated
requests unchanged. A7's existing receiver destination and acceptance own
the receive side and must remain intact. Compose the A4 watchdog policy
check with #84's existing browser revocation/watchdog signature rather
than replacing its lifecycle logic.

The reusable seam does not itself mount the endpoint or register user actions.
Native integration still needs the existing opt-in landmark recognizer to
emit explicit debounced pickup/drop intents and the app to validate the
device-bound session and share projected frames, with lock and camera
resource behavior proven on a physical Windows/mobile pair.

### Local candidate mount

The Windows tray candidate exposes separate Enable/Disable, Hold Captured
File, and Drop actions. It does not open the camera. The nearby roster uses
current IPv4 endpoints from native discovery and admits only exact stored
trust identities; older siblings without this opt-in route refuse the drop
attempt but keep ordinary manual transfers. On the serving side only the
dedicated path branches before the existing generic route. It requires
current native discovery address binding, a live verified certificate
identity and pairing/desktop generation cancellation. Remote and Friends
do not attach the hook. The existing file offer is still independently
accepted in the recipient app. Source choreography is emitted as a safe
main-window event; the full overlay choreography consumer is separate.

The supplied behavior still requires exact Windows installer/runtime
verification and a second supported paired device. A tray click is not
real-camera verification. There is no mobile gesture receiver mount in
this candidate.

### Landed-base A4/A7 verification candidate

The composed local candidate keeps the existing tray-invoked A5 read-only
preview. When an authorized A4 source is active, that exact source epoch
takes precedence at subscription; the preview cannot switch epochs under
an existing observer. It shows only sanitized native phases and progress.
The watcher does not create transport state, and the tray Hold action
does not open a preview or enable the camera by itself.

Before native dispatch, the sender creates an outgoing activity row using
the immutable capture name/size, the verified selected peer, and the
native interaction/offer UUID. Pending and progress callbacks belong to
that same sender; only the final authenticated transport return can complete
the row. The receiver's ordinary pending offer uses the matching v1
UUID scoped by the authenticated sender certificate. Recipient acceptance
still chooses the existing receiving folder or Inbox as before. A7's
Explorer export is a later independent action bound to a verified Inbox
receipt, its exact target folder handle, and separate user confirmation.

No synthetic event establishes physical hand gestures, real monitor and
lock behavior, or cross-device visual timing. The exact integrated
Windows host must pass compilation, native loopback, shell and Explorer
conditions before claiming availability. Camera-backed pickup/drop,
mobile interoperability, and physical multi-device verification are
separate gates.

The default Windows installer workflow runs all Windows app library unit
tests before building NSIS. The focused tray/Explorer tests exercise
production admission functions on explicit IDs, stale/cancelled state and
an isolated directory pin; they never open Explorer, touch desktop focus,
press a real shortcut, activate the camera or require input. The tray and
Explorer end-to-end scenarios remain separate Windows product acceptance.

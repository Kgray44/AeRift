# Native WAN Remote: no-VPN acceptance

**User outcome:** On two different internet connections, invite one known person
privately, choose a file, and wait for their explicit acceptance. The UI does not
ask for a VPN, address, port, or router change. The private-VPN route remains an
optional separate fallback and is not evidence of this outcome.

## What this slice supplies

The existing standalone Iroh transport already carries opaque pinned Remote TLS
over direct QUIC or a configured HTTPS relay. Normal installed apps do not use
it yet. The peers crate supplies a bounded versioned WAN invite signed by the
existing issuer device key. The signed claims cover both devices' outer endpoint
keys, the intended recipient's inner identity, the expiry and the original
targeted Remote token. The recipient checks the issuer fingerprint from a
separately trusted exchange, checks its own inner and current outer identity,
and requires the signature and expiry before choosing any route. The invite
carries no host name, address, port, or relay URL. It does not establish trust by
itself. The original authority still checks the live targeted invitation,
including cancellation, expiry and one-time consumption, and requires approval
before pairing. Every file needs separate recipient acceptance and verified
publication. The route key does not replace either pinned inner TLS identity.

An invite is a private pairing capability. Do not log it or put it in an
externally hosted landing page or a URL query string. For the first restricted
tester cohort, exchange a recipient card and issuer pin using a channel the
testers already trust; no public lookup. A later one-link experience requires a
confirmed authenticated recipient-card/trust handoff, not a weaker anonymous
grant or silently trusted first connection. The issuer must obtain the recipient
outer key and inner fingerprint together from a deliberately verified exchange.
The first code cannot be issued securely for an unknown remote device.

```sh
cargo test --locked -p aerift-peers --lib wan_invitation_tests
```

The synthetic peers regression acts through the new signed redemption entry,
then sends a file each way with the real existing inner TLS and receiver gates
over in-process duplex streams. It is neither Iroh NAT qualification nor an
installed app test. The standalone relay loopback suite remains a separate gate.

## Next product and deployment gates

1. Wire the native host to the standalone adapter. Persist its outer private
   key with platform protection, separate from ordinary preferences. Host
   owns the trusted relay configuration, not the invitation. Restrict inbound
   outer-key bindings to a live targeted pending invite or an active Remote
   grant; expire, cancel and revoke them promptly, and bound handlers. Record
   the latest authenticated route for a trusted peer without rediscovery.
2. For a two-tester release, provision an explicitly approved internet-facing
   HTTPS rendezvous/relay with validated certificates and only the exact
   tester outer keys allowed. Avoid stock open-access mode. Confirm packet
   and bandwidth bounds, retention, operating owner, rollback and budget first.
   A trusted bundled configuration must be provisioned without user network
   settings. It does not replace AeRift authorization, store files, publish a
   global lookup, or log capability tokens or file information. For direct-path
   qualification, qualify the relay's UDP/QUIC address-discovery path too.
   Neither a public shared relay nor a service deployment is implied here.
3. Build exact-head Windows private tester installers and obtain consent for
   two participating hosts. Use the same build hash on both, actual independent
   uplinks (for example home Wi-Fi and a cellular hotspot), no shared LAN,
   no VPN and no forwarding. Keep redacted evidence that the uplinks differ;
   do not publish real IPs, endpoint IDs, fingerprints or invitation tokens.
4. On separate uplinks, use ordinary invite and send screens. First decline
   an offer and confirm there is no published payload. Then accept fresh
   synthetic files both directions, compare SHA-256 against original bytes,
   and exercise cancellation/revocation. Verify an interruption and resume
   within the same app session. Keep the net path, build, OS, direction,
   duration, size and digest outcome, not network secrets.
5. For the **direct** result, require the Iroh selected path to be direct
   during actual payload progress; a working file with only relay telemetry
   is not a NAT traversal pass. Retain any authenticated fallback and
   record route changes. Some NATs may never permit a direct path.
6. Repeat in a test-controlled network or fixture that disables direct
   peer UDP while leaving the HTTPS relay reachable. Require the installed
   client to fall back without asking for network configuration, observe
   actual relay use during the payload, and repeat consent, hash and
   revocation checks. Do not change household firewall settings. Two
   independently observed outcomes are required before describing both
   routes as verified. Repeat on each supported platform before claiming
   cross-platform parity.

## Native host lifecycle slice

The Windows profile adapter can explicitly load a stable, dedicated WAN seed
under the existing exclusive profile lock. It uses current-user DPAPI with
a distinct record namespace bound to the device certificate fingerprint.
Corrupt or transplanted protected records fail closed and are not silently
overwritten. Loading this seed is not part of current app startup. No plaintext
fallback, default relay, network listener or app command is introduced.

The outer endpoint can choose a route using the one relay already configured
at host startup; the peer invitation cannot replace that configuration.
Authorization must be checked after the outer key is authenticated and again
before dispatching the stream. A pending targeted invite admits only the inner
pairing request, never payload, and uses the existing monotonic expiration.
Confirmation and successful redemption bind the authenticated outer keys to
the corresponding Remote grant for this session. Replacement, rejection,
expiry, revocation and stop cancel the relevant admissions. Revocation removes
the key and cancels its sender even if the protected trust mutation reports a
failure. Known route bindings are intentionally not persisted; ordinary saved
Remote grants alone do not restore WAN routes. Persisting authenticated route
bindings and reconciling live grant lifetimes are future work.

The standalone Iroh relay fixture now exercises the signed invite and live
admission flow, pinned inner TLS, explicit acceptance, digest and revocation
through a forced HTTPS relay on loopback. Its other tests cover direct local
transport only. The native DPAPI regression is Windows-only and must run on
Windows before reporting platform qualification.

### Joinable application adapter

The standalone transport now exports `WanSession`. Explicit startup consumes
a Remote peer node, protected endpoint seed, validated `OperatorRelay`, and
the existing locked profile file. The Windows profile has an unregistered
constructor for these same protected parts. The relay config is fixed for
the session, never supplied by a card or invite. Sending by confirmed device
uses only its session-bound approved key; neither a legacy Remote grant nor
a card alone allows a file send. The worker bounds the live handlers, checks
outer permission during accept and again at dispatch, and closes WAN grants,
pending receiver work and the endpoint before releasing the OS profile lock.
The awaited stop is the join/restart barrier. Dropping a session signals
closure but is not itself proof that the worker already released the lock.

Both native host directions were exercised over a real HTTPS relay on
loopback, in the fixture that disables the direct transports. The fixture
used signed targeted pairing, explicit acceptance, verified bytes, revocation
and lock release at shutdown. It injected a test-only CA below the public
constructor. This is not a test of an installer, Windows DPAPI execution,
public TLS trust or independent WAN uplinks.

The ordinary Windows application and the existing VPN launcher remain
unchanged. The isolated app dependency probe would add 134 lock packages and
the full Windows-target offline resolution stopped on uncached
`ipconfig v0.3.4`; its manifest and lock were restored. Before attaching
Tauri, qualify an exact reviewed lock and Windows build, implement trust
preserving native invoke and UI flow with the immutable approved relay,
and verify deployment, and the direct and relay tests above. No default,
relay deployment or feature toggle is registered by this seam.

### Initial Windows Tauri qualification entry (startup-only evidence)

The separate Windows `private_remote_wan_host` example requires Cargo feature
`private-remote-wan-host`, exactly one qualified-start flag, and an immutable
relay URL supplied by the trusted build. Missing or invalid build configuration
fails before opening the existing app-local profile. The feature is not a
default, the normal app has no call site, and the example creates no WebView,
Tauri commands, pairing entry point or product UI. It only starts and joins
the transport under an authorized qualification configuration. It cannot
transfer a file by itself because it does not expose pairing controls; the
standalone session fixture remains the consent and transfer entry proof.
Do not run this source candidate with a real profile or a reachable relay
without separate authorization.

The example uses the same AeRift app-local exclusive lock as Nearby and VPN
Remote, consumes current-user DPAPI protected host parts, and checks that the
profile and new private receive directory are directories and not reparse
points. Any console input or EOF is a local stop request, never configuration
or pairing data. A single shutdown owner awaits `WanSession::stop` before
exiting; it does not print relay addresses, codes, paths, or raw errors. This is
a normal-exit design, not a guarantee for an OS kill or crash. The approved
environment, Windows runtime, and exact route endpoints must be qualified
before use. Do not compile an invitation, token or credential as a build input.

The isolated lock was generated using `cargo update --workspace --offline`,
not a broad dependency refresh. Review against a saved baseline lock with
`python scripts/check-windows-wan-qualification-lock.py before.lock after.lock`.
The script verifies and inventories exact package name/version/source/checksum
identities and canonical dependency edges. The observed transition is 543 to
677 lock entries; all 543 old package identities and semantic edges remain.
The new entries are the local WAN package plus 133 checksum-pinned crates.io
entries. Application lock SHA-256:
`31a37f7697513a6b0c1da9a5d883e9bb53159f5862e07b7412808bf004c95aa3`.
Feature unification adds edges to some existing packages; preserving versions
does not exempt those edges from dependency review.

Checks run locally:

- Standalone Rust tests for the explicit flag and concurrent exit-owner
  state machine passed. Standalone host relay and peers suites above still
  cover transfers, not the native Windows event loop.
- Locked, offline, Windows-target manifest metadata with `--no-deps` parsed
  successfully. A full locked, offline Windows-target `cargo check` of the
  feature/example stopped before compiling at uncached `ipconfig v0.3.4`.
  The Windows example is therefore not yet natively compile-qualified.

For the first approved native build, obtain the required cached Windows
dependency closure by the ordinary approved CI route, review the locked
feature tree with and without the optional feature, and run the existing
advisory/license/source checks on the delta and new edges. Confirm the usual
Windows build has no startup, invoke, capability or relay changes. Compile and
test the feature and example on the same commit, with no configured service
first and an isolated, reviewed qualification configuration only later.
Verify wrong flag and active existing profile fail before networking, no WebView
exists, native DPAPI and exclusive lock gates pass, and an explicit normal
exit joins and permits the profile to reopen. Separate the eventual installed
transfer, independent uplink and operator deployment acceptance.

### Windows private preview transfer flow (next exact candidate)

The previous #103 gate proved compilation of the startup-only optional
example without starting it. This successor gives that same opt-in example
a separate local document and one typed, exact-origin, window-scoped
command. It does not change normal React startup or package assets. Qualification
assets replace the context's ordinary assets only inside the example; the
document loads only its embedded CSS and script. There is no external browser
navigation, relay override, global discovery, account signup or exported UI state.

Both participants share a device card privately and verify it using a trusted
channel. One creates an invitation targeted to the recipient's two identities.
The recipient pastes the original sender’s verified card and invitation text;
the endpoint key as well as the device fingerprint must match the signed
invitation. The sender separately approves the pending device, then either
side may use **Choose & send file**. The receiving side must explicitly
accept or decline. No token file is required. Code is transient, cleared
from fields after submission, cancellation, expiry or document close; users
who choose Copy are responsible for any Windows clipboard history.

The command receives only typed card/control metadata: no pathname, address,
or relay config fields. The attached native picker supplies one local regular
file, frozen under the shared transport's source-integrity path, with a 64 MiB
qualification cap. Publication remains receiver-verified. Incoming file
paths stay native. Use the
`%LOCALAPPDATA%\com.kgamazing44.aerift\RemoteWanQualificationReceived`
folder in File Explorer after verified delivery. Peer grants use a separate
current-user DPAPI file and discriminant from VPN Remote. Reopening the
preview requires fresh pairing to re-establish the in-memory routes.

The automated wire journey runs real pinned Iroh/HTTPS relay connections on
loopback, with synthetic native pickup and explicit recipient decisions. It
moves a file in each direction, rejects a mismatching card before pairing,
tests a decline that leaves no published file, and checks no invitations or
native paths leak into snapshots. The JS component contract test drives
the same command shapes with a DOM/IPC fixture. The new WebView,
Windows picker and DPAPI scope test still require fresh exact-revision
Windows qualification; #103 does not certify these changes. No operator
service has been configured or qualified, and this is not real WAN evidence.

### Offline device cards for a restricted two-device pilot

An operator can collect the two public endpoint identities for a private relay
allowlist **before either device connects to the relay**. In an approved,
disposable Windows test profile, build the existing gated example without a
configured relay, and run it with exactly:

```powershell
private_remote_wan_host.exe --show-wan-device-card-offline
```

The only successful output is the canonical public device card. The other
participant and the relay operator do not need a seed, TLS private key,
invitation, path, or address. Share the card only through the approved private
channel; the app never sends the card itself. Normal AeRift, Nearby, VPN Remote
and the ordinary installer have no invocation for this mode.

The mode uses the Windows LocalAppData known folder and the same app bundle
identifier as the normal runtime, failing on an unexpected drive or reparse
ancestor rather than accepting a supplied path. It holds the existing
exclusive native profile lock through public derivation and printing. A
fresh profile may create only its directory, session lock, and the existing
current-user DPAPI identity and endpoint seed files. It does not construct
a Tauri app, start a transport, read relay policy, create the receive
directory, use a trust grant, or write a new trust record. Running another
AeRift host against that profile must prevent the offline command.

Native qualification without owning a publicly reachable server: run
`cargo test --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-wan-host --lib offline_wan_card_uses_only_protected_identity_and_lock`
on isolated Windows CI with the relay variable unset. That test uses a
synthetic disposable directory and checks stable public output, lock
contention, scope and the exact created-file inventory. A separately approved
isolated no-network launch test can also capture stdout and confirm one
public card and no relay/WebView startup. This gate is separate from approved
relay configuration and independent-uplink transfer.

### Disposable native Windows WebView bootstrap smoke (manual gate)

The ignored Windows unit-test target
`windows_wan_preview_smoke_without_transport` runs the actual Wry document,
embedded stylesheet/script, exact window and navigation scope, and
`private_wan_action` bridge in a disposable Windows profile. The synthetic
controller and observer command compile only with Rust's `cfg(test)`; there
is no CLI fixture flag or production path to select them. The test-only
controller exposes a real offline DPAPI-derived **public** card for the
synthetic profile and denies every operation except Snapshot. It creates no
WAN endpoint, relay, receive folder, staging, trust record, or external URL
and starts no Iroh networking. The harmless `data:` script can be
permitted or blocked without either case sending a network request.

Only after separate approval, give a disposable hosted Windows runner its
normal WebView2 installation and a fresh synthetic user context. Build
the normal bundled frontend and compile the test while
`AERIFT_TRUSTED_QUALIFICATION_RELAY` is absent. Stage dependencies first and
disconnect test execution from external networks; browser startup flags are
not an egress policy. From that isolated native test lane (GitHub Actions
provides `GITHUB_ACTIONS=true`):

```powershell
Remove-Item Env:AERIFT_TRUSTED_QUALIFICATION_RELAY -ErrorAction SilentlyContinue
$env:AERIFT_DISPOSABLE_WINDOWS_WAN_SMOKE = '1'
cargo test --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-wan-host --lib windows_wan_preview_smoke_without_transport -- --ignored --nocapture
```

Use a bounded job timeout and retain only pass/fail, not the synthetic card,
WebView data or profile files. The witness checks native Snapshot appears on
the displayed page, local CSS loaded, CSP denies the `data:` probe,
unregistered navigation did not replace the document, and the fixture did
not accept an invitation mutation. The observer requests the normal window
close, and the test verifies the real exit gate releases its synthetic lock.
A watchdog exits as failure if the WebView does not report. The test is not
part of default CI and does not prove a native picker, actual WAN transfers,
or relay/operator availability. Those remain separately authorized tests.

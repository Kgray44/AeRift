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

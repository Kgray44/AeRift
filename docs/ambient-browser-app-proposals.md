# A6 browser proposals in the local AeRift app

`aerift_transfer::ambient_browser::BrowserProposalBroker` is the shared
native app control, separate from Chromium's native-message stdio parser.

| State | Local app behavior | Native companion behavior |
| --- | --- | --- |
| Unavailable | No arm, preview or confirmation | Cannot attach using browser origin or argv |
| Ready | Explicitly arm once, or leave inactive | No proposal accepted without a fresh arm |
| Waiting | Cancel; no preview yet | Exactly one bounded frame from the attached session/addressed arm, within 45 seconds |
| Review | Read exact text literally, approve the matching review ID, or cancel | Cannot replace a pending review |
| Confirmed | App receives exact frozen object once | No send, destination, navigation or execution right |

The broker has no socket, Tauri command, external listener, filesystem writes,
or automatic transfer. Dropping the owning state, disconnecting the matching
session, locking/cancelling (when the app lifecycle is wired), and expiry must
all remove pending authority. A wrong session does not burn an otherwise
valid arm; after a correct-session and correct-arm attempt a malformed frame
burns it. No qualification identity is accepted by a production build.

A later installed app should expose just availability, Arm, Cancel, literal
preview, and Confirm in native-owned UI state. Never expose the arm or channel
credential to a renderer. Use escaped literal text without markup, active
links, clipboard access, or route inference. Invoke expiry on native timers
and clear state immediately on lock, product suspension or loss of authenticated
connection. Keep object approval separate from the existing recipient/gesture
transfer journey. Do not log proposal content, arm IDs or credentials.

## Prerequisites for enabling the app path

1. **Channel-specific extension identity.** An AeRift-controlled, signed
   Chrome/Edge extension (stable release IDs), reviewed extension permission
   manifest, and a deliberate approval/install flow. A development ID or the
   temporary hosted fixture ID is not an approved production identity.
2. **Signed companion installation.** An AeRift-owned Windows signing identity,
   a reviewed release certificate policy, atomic registration of only those
   extension origins to an app-owned executable/path, and registration
   ownership validation on upgrades/uninstall. Keep registry writer outside
   this common broker.
3. **Actual authenticated local connection.** The installed application must
   independently validate the connected companion's executable and signature,
   bind the observed process/session to a channel transcript, and require a
   deliberate extension enrollment credential that can be rotated and revoked.
   Exact browser origin enforcement is necessary but not sufficient. No
   production attach implementation may trust `argv`, claimed PIDs, a
   browser-provided string, or a same-user ACL alone. The broker's current
   channel fixture is compile-time test-only, not a production fallback.
4. **Installed-app proof.** With disposable browser and app profiles and
   released/signed candidate identities, demonstrate synthetic browser
   selection to local literal review, local cancel/confirm/expiry, stale
   identity and impersonation refusal, and no transfer without a separate
   transfer decision. Hosted Chromium-to-native framing ([#78](https://github.com/Kgray44/AeRift/pull/78))
   does not prove browser-to-app handoff. Do not activate or advertise the
   browser pickup feature in the ordinary app before this qualification.

This change implements the native review control, not the installer or the
Chrome/Edge extension release. It intentionally refuses production arming.

### Installed app review consumer

Windows Settings → **Browser pickup** reads only native status. It displays inert exact text for a broker-authorized proposal and lets the user retain the corresponding frozen RiftObject in a single, expiring in-memory slot or discard it. Review text is hidden when the surface loses focus. Neither the renderer nor the commands can attach a companion, supply an origin or frame, obtain a pickup capability, open a link, persist a preview, or send an object. The installed app has no authorized production attachment until approved Chrome/Edge IDs and a trusted companion are available, so it accurately displays the unavailable state and manual Workspace link capture remains a fallback. Attach/arm routing, lock/disconnect lifecycle wiring, and end-to-end transfer of non-file RiftObjects remain explicit gates; this consumer is not an active browser-to-app experience.

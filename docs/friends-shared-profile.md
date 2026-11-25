# Private Friends profiles

A shared profile is presentation, not identity or any transfer permission.
The phone or desktop's authenticated AeRift person identity and friendship
remain the only authority. A local alias, nickname or replacement avatar
changes what the observer sees without changing their friend or sending
anything back. This contract has no local-override fields or APIs.

## Native contract

1. Save the owner's personal choices privately. An explicit sharing decision
   identifies the exact name and avatar to publish; nickname is omitted by
   default and may be included only if separately selected. Never feed a
   renderer-side contact or override table into signing.
2. Complete the existing mutually approved invitation and commit the
   verified Friends book on both sides. Do not include this profile in a
   contact card, invitation URL, before a consent prompt, or in a directory.
3. After the protected relationship is active, an authenticated private
   connection may carry an envelope from
   `FriendAuthority::share_profile`. The existing Ed25519 person authority
   signs the versioned domain, issuer and recipient people, exact current
   relationship, exact sender and recipient devices, positive revision,
   ten-minute issue/expiry period and intentionally shared fields. The
   issuer verifies the destination's pinned device again before emitting.
   Device values are supplied from native pinned mTLS, never from incoming
   payload or the webview. Whether to send belongs to the user, not the
   appearance editor or network transport.
4. `FriendBook::verify_shared_profile` confirms that person and current
   pinned device are still trusted, rejects wrong recipient, wrong device,
   wrong relationship, tampering and expired packets, and requires a
   strictly increasing revision over the caller's current cursor when there
   is one. Revocation is applied through the existing book read overlay.
   Failed verification must never replace effective presentation. Profile
   names are always rendered as text, not markup.
5. For native admission use `FriendBook::apply_shared_profile`. It
   verifies the envelope, then revalidates the current enrolled origin
   and exact relationship under the existing compare-and-set mutation
   lock before committing presentation and the cursor atomically.
   `FriendBook::shared_profile` projects through current book state on
   every lookup; retaining a previously returned value in a webview does
   not confer authority. Revoking the origin hides and erases the stored
   presentation while keeping a relationship-wide replay floor. Removing
   the friendship drops its record and cursor. The first persisted
   profile promotes the ledger format from 1 to 2; older clients reject
   it instead of silently discarding a replay floor on write. A valid
   existing version-1 ledger needs no migration before that first write.
   Expiration bounds accepting a message, not display lifetime for an
   already admitted profile in a still-active friendship.
6. If no shared presentation is present, use the existing neutral verified
   friend's presentation until one is deliberately shared. Overlay local
   user choices only after verified shared-state projection. Preserve
   local choices independently of authenticated update revisions.

## Bounded avatars

Use built-in `initials`, solid RGB, or an enumerated glass preset
(`glacier`, `prism`, `aurora`, or `obsidian`). A selected personal
photo is converted locally into exactly 64×64 RGB24 pixels before
sharing. The wire uses bounded base64url, contains no original file
bytes, alpha, file path, metadata, SVG, CSS, URL, or instructions to
load a remote resource. The recognizer is a length and byte-format
check, not an image or archive decoder. Observers can still choose a
different local image and never publish that substitution. Presets are
presentation-only. Do not put photo bytes, profile fields or signed
envelopes into operational logs, telemetry, clipboard, or remotely
published build evidence.

## Qualification

This change provides Rust signing, validation, and a native-controller
storage seam using the existing protected Friends ledger. It does not
register native commands, provide cross-device transport, or enable a
public profile. The real first-connection experience still needs a
bounded profile-only message on a pinned Friends session and UI wiring
that reads live projection and separates shared state from local
overrides. The synthetic suite covers confirmed trust, pins, scope,
tampering, expiry, replay, atomic persistence across reopen, failed
write, pending and durable revocation, concurrent updates, and bounded
raster, without opening a network connection. The separate
`friends_windows_profile_revision_reopens_and_revocation_erases_presentation`
regression is native Windows test coverage, but must be executed on an
authorized Windows runner before claiming that platform's proof. No
mobile or actual Internet claim follows from these tests.

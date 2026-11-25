# Recently received images in the profile editor

The profile editor can accept a trusted local receipt catalog, but no native platform supplies that catalog in this revision. The UI shows the supported fallback: save a verified copy through Inbox, then explicitly choose it in Upload image. This is not a network image loader or a history of remote files.

The existing Windows `list_ambient_inbox` returns recovery candidates, not a fresh verification of the payload. `verify_ambient_inbox_entry` verifies bytes and returns no image payload. `save_ambient_inbox_entry` gives the native Save call the user's chosen destination; it does not authorize future reads by the profile editor. The current shared Inbox reader checks path metadata before opening a file. It does not hold the receipt directory and both leaves by trusted native handles through verification and reading.

A native catalog must:

- Bind one local user and process generation to the app-owned sealed Inbox. List no arbitrary directories or paths. Show only existing image receipts that passed native verification, most recent first, without transferring thumbnails or other image bytes into the WebView.
- Accept selection only of an opaque ID and grant previously issued for that exact local verified receipt. Establish native consent for that selection; a grant is not permission to bypass it. Bind and consume grants once, with a short lifetime, and do not use filenames to address disk files.
- Pin the Inbox root, receipt directory, metadata and payload using local native no-reparse handles. Validate the sealed receipt's peer, transfer ID, size, format admission and digest against the same open file. No bytes may reach the caller on mismatch, cancellation, destination/profile change, or credential failure. Bound listing, verification, workers and bytes independently of JavaScript.
- Return only the explicitly selected bounded payload. The local profile image path checks the raster header before decoding, crops and re-encodes for the avatar, and never uploads it.

The optional JavaScript adapter adds a 24-item catalog limit, an 8 MiB per-image ceiling, a 30-second local selection deadline, bounded request time, abort propagation and exact-ID/length matching. These only narrow a trusted native capability. They cannot replace the native gates.

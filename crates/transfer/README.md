# AeRift v1 transfer

The [v1 protocol](../../contracts/v1/protocol.md) defines the offer, status, upload and cancellation routes. The crate shares the wire implementation between Windows and iOS. [aerift-peers](../peers/README.md) supplies production TLS, pairing and discovery.

The native host creates a `Receiver` with a private destination directory, a combined byte allowance for accepted and streaming offers, and a session receipt limit. Calculate the allowance from the user's storage limit and available space. Subscribe before reading the initial snapshot. Ask for explicit confirmation with `respond`, or call `cancel`. Snapshot notifications may coalesce on a busy receiver. The adapter translates native paths and selection state into the opaque IDs from the app contract.

The device that sends the file is the HTTP client. The offer carries a basename, UUIDv4, byte count and SHA-256. The source ID comes from the verified TLS leaf and the destination from the pinned connection. The content media type is `application/octet-stream` under v1. Native pickers can retain a more specific MIME type for presentation without changing the wire format.

The sender hashes the selected file using 64 KiB reads, rewinds the same file handle, and streams the advertised byte count. The receiver validates the length and SHA-256 before publishing. It writes a temporary file beside the final destination, synchronizes the data and publishes without overwriting an existing file. A duplicate gets a numeric prefix. The destination filesystem must support the no-overwrite operation; the adapter must provide a location that another application cannot redirect or modify. Drops, short reads, integrity failures and cancellation clean up incomplete files during the session. An OS kill or power loss can leave an orphaned temporary file. The v1 receiver keeps receipts in memory, so a process restart ends the retry window.

Pending and accepted offers expire after five minutes in each state. The pending-to-accepted transition starts the content-arrival clock. Uploads have a 30-second read-idle limit. The sender polls at most once per second while awaiting acceptance, with caller-specified finite timeouts. Sender progress counts bytes handed to HTTP. It records completion only after a confirmed receiver receipt. If the PUT response is lost it checks status, without retransmitting the upload. Cancellation and the final destination publication share the receiver state lock.

Run the [transfer harness](../../tests/transfer/README.md) for the two-process check and protocol regressions.

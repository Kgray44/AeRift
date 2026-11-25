# Invite-only Remote WAN device binding

First slice of the no-VPN flow. The installed app must ultimately let trusted people exchange an invitation and accept each transfer without choosing network settings. The existing standalone QUIC adapter already supports operator-configured HTTPS relay and direct paths; the AeRift inner Remote TLS checks stay authoritative.

1. Add an exact, bounded, versioned, device-signed invitation envelope to peers, using the existing platform certificate/key and targeted invitation lifetime. Verify trusted issuer, intended recipient inner/outer identities, freshness, and original code issuer before transport is opened. Carry no infrastructure URL or IP address.
2. Expose the narrow typed redeem entry, including mandatory inner pin and original explicit confirmations. Do not turn signed claims into a persistent Remote grant, route advertisement or app feature. Route factories are host-controlled.
3. Exercise the positive path and fail-closed verification, plus existing Remote pairing and file tests. Document remaining deployment, release and independent-uplink gates.

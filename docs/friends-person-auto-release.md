# Friends person-only transfer: local authority and automatic release

The person-only action opens a native picker only after validating a contact and
finding a route from a Rust-only verified provider. An explicit picker selection
and outgoing offer authorizes sending this one immutable file after consent.
No renderer route, address, recipient device selection, or Nearby fallback is
accepted. The older diagnostic Windows actions retain their explicit release step.

1. The sender creates a short-lived offer and sends metadata, not bytes, to
   individually enrolled reachable devices. Each device may decline locally
   or explicitly accept this exact offer.
2. The authenticated recipient stores the consent intent, requests the one-time
   award, commits the local grant, then acknowledges readiness through the
   same pinned control lane. Readiness requires the original device-bound
   ticket, manifest digest, a live award, and the same TLS identity.
3. Only an explicit live person offer has a registered one-shot release. There
   is no idle transport polling. Repeated readiness does not repeat release.
   The sender rechecks the immutable winner and live authorization; the
   existing durable stream-start guard still admits file bytes only once.
4. Other devices are already excluded by the sender's atomic award. The sender
   makes a bounded, pinned best-effort withdrawal notification to those exact
   devices. It reveals only each one's own disposition, not who accepted.
   Unreachable devices reconcile their known offer when reachable or expire;
   they cannot still claim the file.
5. Revocation or a changed file can block dispatch, and no other device is
   promoted. The v1 transport requires a new deliberate offer after a failed or
   interrupted transfer. A lost readiness response can be retried by the same
   recipient by reconciling its known grant, without a second transfer.

The Linux loopback fixture proves both the two-device consent race and the
no-second-click path through the native shared protocol. The fixture supplies
routes in memory; it does not publish a service or assert real WAN reachability.
The installed Windows app cannot advertise the person-transfer capability before
an authenticated provider is registered and a valid receive window is mounted.
Existing invitation listeners are not a verified or reusable file-route provider.
Windows app/IPCs, protected operating-system operation and two-network testing
remain release gates.

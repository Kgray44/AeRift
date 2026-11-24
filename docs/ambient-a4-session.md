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

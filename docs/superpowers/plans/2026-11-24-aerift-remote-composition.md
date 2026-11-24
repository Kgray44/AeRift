# AeRift transport composition gates

## Keep unrelated drafts separate

- #58 is the independent Remote authority lane, 1661313b85e2a4558d600b8f6721c88d23869bc7, based on main 85026413c232d2de076b89a9000a6f6d182c7477.
- #59 is the Nearby six-digit authority proposal, originally b6baa528ba88b4ca32dbbdc8995c4cee2604ef30. Re-read exact current head before composing.
- #60 is the Remote v2 socket resume, 56cee845cb2e4738fc2847eb852cc614b703b54f, stacked on #58.
- This draft adds an opt-in Unix receiver restart journal above #60. Do not enable in an installed product, deploy, merge, or infer cross-network acceptance from test outputs.

## Compose on an isolated integration branch

1. Require individually green exact-head CI for the accepted core and Nearby candidate. Use current main and verify all review and merge prerequisites before making an integration decision.
2. Replay accepted shared changes in order: scoped Remote identity (#58), socket resume (#60), journal, then Nearby (#59). Resolve only overlapping peer transport seams deliberately. In crates/peers/src/lib.rs export both separately. In crates/peers/src/network.rs retain Remote-only ALPN, route, trust and recipient approval. Nearby ingress local policy and comparison transcript must never run on the Remote accepted stream. Nearby remains on default v1 lane and offline.
3. Independent apps wire only Nearby behavior from #59; do not add a Remote app/UI context just to get the merge green. Neither Nearby nor a VPN route implicitly authorizes Remote, and pending grants cannot be read as presence. Friends adapters must use their separate person/device authorization and atomic recipient claim before entering any content route. Do not reuse Remote-grant lookups as Friend membership.
4. Run exact integrated Rust and installed-app CI. Verify authentication permutations at actual listeners including dual grants with the same certificate on the same machine, scope mismatch, Remote grant revoked during resume, fresh approval after restart, and Nearby with no uplink. Then test private VPN on two authorized independent uplinks; native NAT/relay, background policies and mobile builds remain separate gates. #57 Android is an independent draft and is not included by default.

### Current three-way conflict map

The exact main/#58/#59 source merge has one conflict in peers/lib.rs (keep both public export sets) and six in peers/network.rs: node fields, constructor, listener/config, authenticated service dispatch, pairing helper composition, and HTTP request-path selection. Keep a private lane selected by the native host, not by callers or HTTP headers. Make Nearby state and discovery predicate private to the Nearby lane; call the Nearby-only exporter/start/finish only after that lane authenticates and verifies its local discovery predicate. Preserve shared HTTP helper routing by passing the lane's exact pairing path rather than hard-coding the Nearby route in pair_remote. Neither a positive DNS-SD match nor an installed Nearby grant may pass Remote application dispatch. Independently harden legacy Nearby listener network scoping before enabling product Remote: new Nearby comparison alone does not make the historical wildcard v1 listener unreachable via a routed private network.

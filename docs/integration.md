# Alpha 0.1 integration

Use one Tauri 2 host with a shared React and TypeScript interface and native Windows and iOS targets. Keep pairing and transfer in Rust. Adapt platform APIs at the native boundary. Use the [v1 protocol](../contracts/v1/protocol.md) and [typed app port](../packages/app-contract/src/v1.ts) as the seams between workstreams.

## Workstream ownership

| Workstream | Branch | Owned paths |
| --- | --- | --- |
| Windows and shared host | `worker/01-windows` | `apps/windows/`, `apps/aerift/` except the iOS paths |
| iOS | `worker/02-ios` | `apps/ios/`, `apps/aerift/src-tauri/gen/apple/`, `apps/aerift/src-tauri/src/platform/ios/` |
| Discovery and pairing | `worker/03-peers` | `crates/peers/`, `tests/peers/` |
| File transport | `worker/04-transfer` | `crates/transfer/`, `tests/transfer/` |
| GLASS and transfer UI | `worker/05-glass` | `packages/ui/`, `tests/ui/` |
| Camera gestures | `worker/06-gestures` | `packages/gestures/`, `tests/gestures/` |

Integration owns root manifests and lockfiles, workflow and GitHub settings, `contracts/`, `crates/protocol/`, `packages/app-contract/`, `tests/contracts/`, and shared docs. Ask in the workstream issue or PR before editing shared paths, adding dependencies or crossing an ownership boundary. Identify the exact package, feature flags and rationale. Integration coordinates API and lockfile changes together.

## Worker handoff

1. Start from the published baseline SHA in an independent checkout or cloud environment. Follow the AERO X16 reserve rule for local clones, worktrees and builds. Keep a dedicated branch and PR linked to your issue.
2. Open a draft PR as soon as a reviewable seam is ready. List scope, touched paths, commands and actual results, native evidence, remaining dependencies and shared changes. Use isolated fixtures only in tests and label any simulated evidence.
3. Coordinate shared app wiring by PR. For packages awaiting workspace registration, use self-contained test commands and ask Integration to register the package before merging. Avoid competing lockfile edits.
4. Integration reviews ownership, contract compatibility and exact-commit checks and merges to main. After the first native launch slice, each merge must preserve the installable slice. Land independently useful changes as gates pass.
5. Start native work early. Windows owns installer and WebView2 evidence. iOS owns Mac/Xcode build, provisioning and physical-device install evidence. Integration records the build SHA for all qualification evidence.

## Source intake

For any import, record the originating repository, commit, files, owner authorization, and license terms. Review dependencies and bundled assets separately, scan the proposed files and diff for secrets, remove unrelated source, and preserve required notices. Voyagewright is proprietary. Use the documented open-hand, grasp, and release interaction as the initial reference. Copying source or assets into this public repository requires explicit authorization that covers that publication.

## CI

`npm ci && npm run typecheck && npm test` checks the frontend contracts. `cargo fmt --all --check` and `cargo test --workspace --locked` are the Windows Rust baseline. macOS also checks the Rust contract crate against the iOS simulator target. The native workstreams extend CI with actual app builds as their targets land. Physical-device and signing evidence are tracked separately in the [acceptance gates](../tests/README.md).

# Alpha 0.1 integration

Use one Tauri 2 host with a shared React and TypeScript interface and native Windows and iOS targets. Keep pairing and transfer in Rust. Adapt platform APIs at the native boundary. Use the [v1 protocol](../contracts/v1/protocol.md) and [typed app port](../packages/app-contract/src/v1.ts) as the seams between workstreams.

## Workstream ownership

| Workstream | Branch | Owned paths |
| --- | --- | --- |
| Windows and shared host | `feat/alpha-windows-app` | `apps/windows/` and `apps/aerift/` outside the iOS-owned subtrees and the coordinated `.github/workflows/windows-app.yml` |
| iOS | `feat/alpha-ios-app` | `apps/ios/`, `apps/aerift/src-tauri/gen/apple/` and `apps/aerift/src-tauri/src/platform/ios/` and the coordinated `.github/workflows/ios.yml` |
| Alpha validation | `feat/alpha-validation` | `tests/acceptance/` and `docs/validation/` |
| Discovery, pairing and transport | `feat/alpha-transfer-engine` | `crates/peers/`, `tests/peers/`, `crates/transfer/` and `tests/transfer/` |
| GLASS and transfer UI | `feat/alpha-glass-design` | `packages/ui/` and `tests/ui/` |
| Camera gestures | `feat/alpha-gesture-engine` | `packages/gestures/` and `tests/gestures/` |

Integration owns root manifests and lockfiles, shared workflow and GitHub settings, `contracts/`, `crates/protocol/`, `packages/app-contract/`, `tests/contracts/`, and shared docs. The iOS workstream also owns the iOS-specific `apps/aerift/src-tauri/Info.ios.plist`. Alpha validation owns the coordinated `.github/workflows/alpha-validation.yml`. Ask in the workstream issue or PR before editing shared paths, adding dependencies or crossing an ownership boundary. Identify the exact package, feature flags and rationale. Integration coordinates API and lockfile changes together.

## Worker handoff

1. Start from the published baseline SHA in an independent checkout or cloud environment. Follow the AERO X16 reserve rule for local clones, worktrees and builds. Keep a dedicated branch and PR linked to your issue.
2. Open a draft PR as soon as a reviewable seam is ready. If a later slice needs to start before the first is merged, coordinate a dependent follow-up branch. List scope, touched paths, commands and actual results, native evidence, remaining dependencies and shared changes. Use isolated fixtures only in tests and label any simulated evidence.
3. Coordinate shared app wiring by PR. For packages awaiting workspace registration, use self-contained test commands and ask Integration to register the package before merging. Avoid competing lockfile edits.
4. Integration reviews ownership, contract compatibility and exact-commit checks and merges to main. After the first native launch slice, each merge must preserve the installable slice. Land independently useful changes as gates pass.
5. Start native work early. Windows owns installer and WebView2 evidence. iOS owns Mac/Xcode build, provisioning and physical-device install evidence. Integration records the build SHA for all qualification evidence.

## Source intake

For any import, record the originating repository, commit, files, owner authorization, and license terms. Review dependencies and bundled assets separately, scan the proposed files and diff for secrets, remove unrelated source, and preserve required notices. Voyagewright is proprietary. On November 22, 2026, the Voyagewright owner explicitly authorized AeRift to use all Voyagewright work. Port the open-hand, grasp, and release interaction from a pinned source revision. Verify third-party rights independently before importing any libraries, models, or bundled assets.

## CI

`npm ci && npm run typecheck && npm test` checks the frontend contracts. `cargo fmt --all --check` and `cargo test --workspace --locked` are the Windows Rust baseline. macOS also checks the Rust contract crate against the iOS simulator target. The native workstreams extend CI with actual app builds as their targets land. Physical-device and signing evidence are tracked separately in the [acceptance gates](../tests/README.md).

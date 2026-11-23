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

## Unified experience integration

AeRift is a shared digital space across devices. Digital objects should feel tangible. Navigation should feel spatial, and transitions should preserve continuity. Connected devices and their actual readiness should be visible. Platform conventions and accessibility preferences shape each presentation while preserving a recognizable AeRift identity. Protect responsiveness, legibility, permissions and transfer reliability when adding visual effects.

The governing experience and Orbit design proposals are reviewed in [#37](https://github.com/Kgray44/AeRift/pull/37) and [#38](https://github.com/Kgray44/AeRift/pull/38). Reconcile the proposals during review so the governing specification carries the product direction and the Orbit addendum carries its platform interaction details. This integration section owns the executable boundaries, implementation order and cross-mission handoff.

| Owner | Main responsibility | Shared dependency or handoff |
| --- | --- | --- |
| Mission 0 | Versioned object, navigation, preference and experience contracts. Integration sequencing and regression gates. | Owns the new app-contract subpaths, contract tests and this integration section. Coordinates root scripts and dependency changes. |
| Mission 1 | Orbit geometry, pointer and keyboard interactions, focus, dismissal and cancellable transitions. | Uses shared destinations and lifecycle. Gives Mission 3 a controlled desktop navigation component. Requests new optical recipes or sampling through UI Overhaul. |
| Mission 2 | Mobile shell and safe-area bottom navigation, mobile workspace modules and permission-scoped adapters. | Owns mobile app wiring and related iOS areas. Uses the existing iOS host ports and workspace object contracts. |
| Mission 3 | Desktop shell, Simplified and Full window modes, and native Ambient adapters. | Owns desktop host wiring. Mounts Mission 1 as the default primary navigator with a conventional alternative. Keeps the live transfer and gesture controllers above layout changes. |
| UI Overhaul | Glass Laboratory calibration, semantic materials, theme and tokens, shared UI effects and components. | Owns changes to optical rendering and coordinates any new reusable motion or icon styling with Missions 0 and 1. |

Coordinate edits to the same package exports, root manifests, lockfile, shared entry point, TransferWorkspace, gesture engine or native port before implementation. Use an isolated branch for each mission and record its base and any temporary adapter in the draft PR. Keep test fixtures scoped to test or preview entry points. Use focused commits that can be integrated independently.

### Contracts and runtime boundaries

- Import the [object model](../packages/app-contract/src/digital-objects.ts) from @aerift/app-contract/digital-objects. A descriptor has a caller-assigned persistent ID, schema version, name, kind and local or received ownership. A received descriptor carries device, transfer and receipt time. A media asset may have an opaque local asset reference. Collections contain ordered object IDs. Clipboard entries reference workspace objects created after explicit user action. Keep IDs stable across renames and moves. The repository and asset adapter own durable storage, access, reference integrity and cleanup. Validate references against the repository, including missing IDs and indirect cycles, before expanding groups.
- Persist documents through the versioned codec. The codec verifies a single document, while the owning repository enforces indexes and transactions. The shared presentation mapper supplies icon and preview semantics. Render text with safe text or a sanitized formatter, use permission-scoped previews and require a user action to open a link or file. Treat structured values as data and use a namespace-specific consumer when available. Apply destination-specific authorization in the native adapter.
- Keep the [v1 AppPort](../packages/app-contract/src/v1.ts) and Rust transport authoritative for consent, trust, integrity, progress and file publication. The object adapter can map live native picker handles to v1 offers for files and selected media. Picker handles are session-scoped. Persist descriptors and asset references separately. New content kinds and collections require a versioned negotiation, integrity and fallback design before network transport. Moving between views never reissues an offer.
- Import [experience contracts](../packages/app-contract/src/experience.ts) from @aerift/app-contract/experience. The shared registry gives mobile Home, Workspace, Rift, Devices and Activity as primary routes with Settings separately reachable. Desktop Simplified exposes Home, Rift, Devices, Activity and Settings. Full adds Workspace. Keep registered modules in Workspace and filter visibility from preferences. Register the renderers actually available on that platform. Hiding a module preserves its data.
- The shell owns route state. Request a transition against the available destinations, issue a fresh transition ID, and commit or cancel that lifecycle exactly once. Ignore stale completion callbacks. Focus the new destination heading at commit and expose the current destination to assistive technology. Restore or fall back to Home when the active route becomes unavailable. Reduced motion changes the presentation of a transition while preserving its state and focus. Use the existing GLASS motion tokens and renderer effects. Keep Orbit geometry in its renderer.
- [GLASS design](../packages/ui/glass-design.md) owns the visual recipes, material roles and accessibility treatment. Reuse ThemeProvider, the theme registry, semantic tokens and the existing optical renderer on WebView surfaces. Resolve motion from effective user and system preferences and preserve reduced-transparency and high-contrast behavior. Icon keys carry semantic identity. Renderers provide the corresponding glyphs, with text labels or accessible names and mechanically equivalent keyboard control.
- Store appearance, module visibility, window mode and desktop navigation preferences separately from the transfer session. Preserve existing appearance keys during shell migrations. Ambient availability depends on an explicit preference and native capability, independent of the window mode. Toggling presentation leaves native subscriptions and data owners mounted. Camera availability is independent of navigation. Permission prompts require explicit actions and camera revocation immediately changes the runtime capability. Keep conventional controls operable.
- Drive transfer choreography from the native status and correlate by transfer ID. Shared gesture presentation may describe readiness and the engaged object, while the existing gesture engine owns recognition, intent timeouts and cancellation. Preserve the current safe cancellation on focus, permission or target loss. A navigation animation cannot authorize a transfer or invent remote readiness.

### Integration sequence

1. Review and publish the shared contracts and baseline regression tests. Align #37 and #38 with these boundaries and coordinate compatible optical hooks through UI Overhaul.
2. Land the isolated Orbit renderer and shell adapters with typed fixtures and accessible fallbacks. Wire each shell to the existing AppPort and long-lived native subscriptions. Migrate preferences without disturbing transfer history or trust.
3. Introduce platform-backed object repositories and permissions module by module. Qualify the unchanged v1 media path before any new network format. Wire Ambient through the native capability boundary independently of desktop window mode.
4. Qualify each exact commit, then repeat the integrated native gates in the [validation strategy](validation/strategy.md). Keep physical receipts tied to both build SHAs and record the host, device, OS, result and local evidence location.

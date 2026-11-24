# Installed Windows private folder acceptance (synthetic design)

The dedicated qualification workflow is staged locally. It has not run on
Windows. The connected GitHub tool cannot dispatch a workflow directly, so
only an explicitly approved publication of the same-repository
`qual/windows-installed-private-folders` draft into `main` can start this
single credentialless job. Other PRs and the existing Windows workflow are
unchanged. The fixture uses the exact head checkout, not the synthetic merge.
It needs a dedicated disposable GitHub-hosted Windows runner, exact checked
revision, explicit synthetic-only consent, and permission to attach a temporary
private IPv4 alias *only* to that runner's actual 127.0.0.1 interface.
If the OS cannot perform that exact attachment or native UI Automation cannot
control the owned folder dialog, it fails rather than using another NIC or a
product test bypass. Do not run it on a user device.

In a dedicated authorized Windows job, check out the exact candidate with
`persist-credentials: false`. Install normal locked dependencies. Use a
unique target under `RUNNER_TEMP` and build:

    $env:CARGO_TARGET_DIR = Join-Path $env:RUNNER_TEMP 'aerift-installed-folder-fixture-build'
    npm ci
    cargo build --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-folder-qualification --example installed_remote_folder_peer
    Push-Location apps/aerift
    try { npm run tauri build -- --bundles nsis --features private-remote-folder-qualification } finally { Pop-Location }

Abort on every failed command; require exactly one setup executable in
`$env:CARGO_TARGET_DIR/release/bundle/nsis`, then invoke
`apps/windows/Test-InstalledRemoteFolders.ps1` with that installer, the owned
`debug/examples/installed_remote_folder_peer.exe`, and an explicit
`-Consent 'SYNTHETIC PRIVATE FOLDERS ONLY'` for this scenario only.
Do not attach artifacts or sign/publish this installer. Preserve the separate
ordinary Windows installer job and rerun it with the default feature set.

The sender creates only hard-coded synthetic files, keeps an independent
DPAPI profile and redeems a real invitation for the exact installed identity.
The fixture starts with its own protected private-mode preference, not a trust
grant, so initial Nearby discovery cannot leave the loopback fixture. The
real app starts off and the script agrees to the private session, folder
qualification and pairing via visible controls. It tests legacy files
while folders are on; opening/cancelling a native picker does not authorize
a folder. Native UI Automation operates only on a dialog owned by the
installed AeRift PID, not a JS/native test command. An accepted folder must
not publish before separate Save. Export must preserve exact bytes and empty
directories, while proving the held directory cannot move until the one-time
lease is consumed. A competing existing destination retains its bytes.
Revoking the protected peer removes authorization and a fresh request is
not admitted. Only synthetic endpoints, command events and status are logged;
pairing codes are not included in test output.

The runner removes its own local alias, installer, profile, processes and
synthetic data. The real installed fixture must pass on the exact head before
considering ordinary app enablement. Those results would still be hosted
Windows loopback evidence, not physical camera, independent-network, actual
VPN interoperability, or public release evidence.


## Destination volume boundary

The positive fixture selects a newly created, runner-owned directory beside
the synthetic local app profile, and verifies the destination and protected
staging share the same local NTFS volume. The install/build scratch may reside
on another volume. This does not qualify cross-volume destinations. The
current handle-relative no-replace rename intentionally does not copy or
fall back across volumes. Before ordinary enablement, reject unsupported
volume choices before accepting an offer and tell the user which destination
type is supported, or separately design and qualify cross-volume publication.

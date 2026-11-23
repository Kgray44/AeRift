# AeRift internal TestFlight

AeRift uses Apple team `X2JZ9N65V2`, bundle identifier `com.kgamazing44.aerift`, and App Store Connect record `6838181986`. The `aerift-testflight` GitHub environment allows only branches matching `codex/aerift-testflight-*`.

The workflow follows the Windows-initiated Landfall process. An unchanged source revision on protected main generates a temporary, single-workflow transport branch. GitHub-hosted macOS generates the Tauri Xcode target and builds a device archive. The protected job verifies the local provisioning identity, exports the signed IPA, validates it with Apple and uploads only in upload mode. It then records Apple processing and optionally links the build to an existing internal group for the same app. Public artifacts contain scrubbed receipts and unsigned diagnostics. The runner removes its own Keychain, temporary keys and installed profiles.

The AeRift runner and owner-local helper derive from the authorized [Landfall runner and deployment at the successful TestFlight revision](https://github.com/Kgray44/treasurehuntSoT/tree/40c4eb387d257050018a39683e3acb1e1925edc1). The [successful Landfall hosted run](https://github.com/Kgray44/treasurehuntSoT/actions/runs/39521997164) records the original distribution path.

## Signing inputs

Use the existing Apple Distribution certificate and matching CurrentUser DPAPI key from the owner’s Windows machine. The retained App Store Connect team key can be reused once an authenticated lookup returns the exact AeRift app. The App Store provisioning profile must be for AeRift and include that Distribution certificate.

Run the Windows helper with a local profile path. It reads Landfall’s non-secret API identifiers and AeRift’s numeric app identifier from their environment variables. The helper validates the certificate, profile, private key and App Store Connect record first. With `-InstallSecrets`, it constructs a PKCS#12 in memory using a fresh export password and sends the four values to the AeRift environment over standard input. GitHub stores values as environment secrets and supplies only their names through readback.

```powershell
pwsh -NoProfile -File .agents/scripts/aerift-apple-signing.ps1 -ProfilePath '<local profile>'
pwsh -NoProfile -File .agents/scripts/aerift-apple-signing.ps1 -ProfilePath '<local profile>' -InstallSecrets
```

| Kind | Names |
| --- | --- |
| Signing secrets | `AERIFT_DISTRIBUTION_P12_BASE64`, `AERIFT_DISTRIBUTION_P12_PASSWORD`, `AERIFT_APPSTORE_PROFILE_BASE64` |
| API secret | `AERIFT_ASC_PRIVATE_KEY_P8` |
| Variables | `AERIFT_ASC_KEY_ID`, `AERIFT_ASC_ISSUER_ID`, `AERIFT_ASC_APP_ID`, optional `AERIFT_INTERNAL_GROUP_ID` |

## Hosted operations

In a full checkout with the AeRift origin, select an exact candidate from protected main and an unused Apple build number. Use the same version, build, and candidate for each operation.

```sh
node scripts/testflight/dispatch.mjs <candidate-sha> unsigned 0.1.0 1 --publish
node scripts/testflight/dispatch.mjs <candidate-sha> signed 0.1.0 1 --publish
node scripts/testflight/dispatch.mjs <candidate-sha> upload 0.1.0 1 --publish
node scripts/testflight/dispatch.mjs <candidate-sha> observe 0.1.0 1 --publish
```

Unsigned checks compilation and packaging. Signed checks archive, export and Apple validation before upload. Observe resumes Apple processing on an already submitted build. Retain the dispatch and Actions receipts for each exact candidate. Once receipts are saved, remove the temporary transport branch only after confirming its expected commit. Use the [physical acceptance checklist](validation/alpha-0.1.md) after the build reaches the intended internal TestFlight group.

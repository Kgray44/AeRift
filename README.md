# AeRift

<img src="assets/branding/aerift-logo.png" alt="Official AeRift logo" width="320">

AeRift is a local-network file transfer app for Windows and iPhone. Devices pair with explicit approval. Users can send files with conventional controls or an intentional camera gesture. File transfers run on the local network without an AeRift account or a cloud relay.

Alpha 0.1 is in device qualification. The matching Windows installer and TestFlight build use the same source revision. The [device qualification report](docs/validation/alpha-0.1.md) links both builds and records the remaining steps for Windows ↔ iPhone acceptance.

- [Windows installer and development](apps/windows/README.md)
- [iOS signing and TestFlight](docs/testflight.md)
- [Integration and package ownership](docs/integration.md)
- [Spatial experience and material principles](docs/spatial-experience.md)
- [Version 1 protocol](contracts/v1/protocol.md)
- [Version 1 app interface](packages/app-contract/src/v1.ts)
- [Acceptance test harness](tests/README.md)

Experimental development: [AeRift Remote architecture](docs/superpowers/specs/2026-11-24-aerift-remote-design.md) and [private-network qualification harness](docs/remote-private-qualification.md). Remote is not yet enabled in the installed apps.

# Windows private Remote developer window

**Off by default.** This is a receiver-only acceptance and display seam, not a release, installed-mode feature, gesture surface, or WAN proof. It is a separate Tauri startup builder with only three private Remote commands; the normal Nearby/app runtime, notifications, Explorer and camera integrations do not initialize. The existing native per-profile lock separately excludes another normal Nearby process with the same identity. This does not retrofit the historical Nearby wildcard listener to run safely alongside Remote; simultaneous product use remains deliberately blocked.

1. Close ordinary AeRift, including its tray process. Use only an already-authorized, literal approved private overlay address in 100.64.0.0/10 and a fixed high port, not a wildcard, public IP, hostname, or forwarding rule. In a normal installer build the developer flag fails closed without starting any listener.
2. Build and run the Windows workspace from the exact review revision with Cargo feature **private-remote-app** and launch flag **--private-remote-dev PRIVATE_IPV4:PORT**. For example, after building normal frontend assets in apps/aerift, from the repository root:

       cargo run --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features private-remote-app -- --private-remote-dev 100.64.0.10:47497

   Replace the illustrative address with the machine's explicitly approved overlay address. The address is immutable for the run. No device discovers or automatically publishes itself.
3. The window starts with the listener off. Read the private-overlay/synthetic-data statement and deliberately click Start. It reuses the profile’s DPAPI device certificate but stores Remote authorization separately, with no Nearby permission promotion. This renders a list of **authorized** Remote devices, not a discovery or availability list.
4. Use a friend’s device fingerprint explicitly shared by that operator to create a targeted five-minute invitation. Confirmation, revocation and individual file acceptance are separate controls. File offers display the authenticated peer fingerprint and claimed file size before acceptance. No silent transfers. Use the separate Windows qualifier to send a generated synthetic file; the operator procedure in [the Windows qualification guide](remote-windows-qualification.md) still requires independent SHA-256 checks and different uplinks.
5. Click Stop. The native runtime stops the listener and waits for its connections before releasing the same app-profile lock. Dialling, Windows Restart state, signed release artifacts, native WAN/NAT/relay, Android/iOS and normal workspace UI are separate gates.

The normal Windows app does not register any of these commands, including in a feature-enabled build started without the developer flag. The capability does not modify network/firewall settings, add aliases, open an outbound connection, enable a user account, or run during regular startup.

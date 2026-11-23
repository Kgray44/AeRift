# GLASS showcase

The showcase uses an in-memory v1 `AppPort` fixture. It demonstrates the shared UI with simulated devices, files, progress and gesture feedback.

With Node 24, install the showcase toolchain from the repository root. The command leaves the root manifests and lockfile unchanged.

```sh
npm ci
npx vite --config tests/ui/vite.config.mts
```

Open the localhost URL printed by Vite. Use **Scenarios** to switch between connected, discovering, disconnected, incoming, send-error and delayed-offer states. Choose a file and paired device to enable **Send file**. **Control Center** previews system, light and dark color schemes, reduced transparency, increased contrast, reduced motion, and a CSS token override theme.

Enable camera gestures in **Control Center**, then select a file and paired device or switch to **Incoming request**. When the navigation indicator says **Camera on · Listening**, press **Shift + H** four times to replay hand detection, a stable open palm, grasp and release. The replay feeds synthetic observations through the same gesture intent used by the apps. The connected scene acknowledges receiver readiness after the grasp. The fixture models acceptance, byte progress and completion in memory.

In **Delayed offer receipt**, send a file and accept or decline the incoming request before pressing **Resolve demo offer**. The fixture holds the offer promise until that final step.

In **Pairing request**, open **Review pairing (1)**. Create and copy the demo invitation, submit it through the redemption form, or approve or deny the incoming request. Submitting a different code exercises the expiry error.

Open `/lab.html` on the same server for the GLASS Laboratory. Preview either appearance, vary the optical parameters, and download each recipe independently. The high-contrast preview checks WebView material against fine detail.

```sh
npm run test:ui
```

The build output is `tests/ui/dist/`. Both pages are development fixtures and stay out of the native app build.

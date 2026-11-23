# GLASS showcase

The showcase uses an in-memory v1 `AppPort` fixture. It demonstrates the shared UI with simulated devices, files, progress and gesture feedback.

With Node 24, install the showcase toolchain from the repository root. The command leaves the root manifests and lockfile unchanged.

```sh
npm install --no-save --package-lock=false react@19 react-dom@19 @types/react@19 @types/react-dom@19 vite@7 typescript@5.9.3
npx vite --config tests/ui/vite.config.mts
```

Open the localhost URL printed by Vite. Use **Scenarios** to switch between connected, discovering, disconnected, incoming, send-error and delayed-offer states. Choose a file and paired device to enable **Send file** or **Arm demo gesture**. **Appearance** previews system, light and dark color schemes, reduced transparency, increased contrast, reduced motion, and a CSS token override theme.

In **Delayed offer receipt**, send a file, cancel another transfer and accept or decline the incoming request before pressing **Resolve demo offer**. The fixture holds the offer promise until that final step.

```sh
npx tsc -p packages/ui/tsconfig.json
node --test tests/ui/send-action.test.mjs
npx vite build --config tests/ui/vite.config.mts
```

The build output is `tests/ui/dist/`. The root foundation workflow covers the v1 contract. The package commands above cover the UI separately until the root workspace and CI are updated by Integration.

# AeRift shared UI

[GLASS Design Specification](glass-design.md) · [Interactive showcase](../../tests/ui/README.md)

## Host integration

The shared Windows and iOS entry point imports the package and its stylesheet once. Provide a stable v1 `AppPort` from the host. The UI subscribes to snapshots and delegates native file picking and transfer requests to the port. The workspace supports paired device selection, outgoing offers, incoming accept or decline, and cancellation. Supply pairing controls through the shell toolbar.

```tsx
import { AppShell, ThemeProvider, TransferWorkspace } from "@aerift/ui";
import "@aerift/ui/styles.css";

export function App() {
  return (
    <ThemeProvider>
      <AppShell>
        <h1>Transfer files</h1>
        <TransferWorkspace port={nativeAppPort} />
      </AppShell>
    </ThemeProvider>
  );
}
```

The optional `gesture` render prop supplies `intent`, `busy` and `send(intent)`. The gesture controller captures the intent when arming, discards it on interruption or target change, and calls the same send action as the button after a valid release. The workspace checks the captured IDs against the current file and paired online device and serializes composer operations independently of each transfer row. The native adapter remains responsible for authorization. `GestureIndicator` displays state supplied by the caller.

The host should resolve `transfer({ action: "offer", ... })` as soon as it has allocated and published the pending transfer receipt. Stream progress and terminal results through `watch`. Keep the native command handler able to process consent and cancellation while a stream is active. The UI keeps each transfer row independently actionable even when another command receipt is delayed.

## Add a theme

1. Register a theme with `createThemeRegistry([glassTheme, customTheme])`.
2. Scope its CSS to `.ae-theme[data-ae-theme="your-id"]` and import the rules after the shared stylesheet. Define light and dark values using the semantic roles in `src/tokens.css`. Registration also supports an optional `overrides` object.
3. Select the theme through `ThemeProvider` and persist the setting in the host as needed. Unknown IDs resolve to GLASS. Provider overrides take precedence over theme defaults. Modal and popover tokens inherit through their DOM ancestry.

`ThemeProvider` defaults to system appearance. A host can pass explicit `scheme`, `contrast`, `transparency` and `motion` preferences from native settings. The package expects React and React DOM 19 from the host, a TS-aware bundler and WebViews that implement native modal dialog and auto popover. The GitHub integration PR tracks root workspace registration.

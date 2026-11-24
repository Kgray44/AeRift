import { isTauri } from "@tauri-apps/api/core";
import { AppShell, ThemeProvider } from "@aerift/ui";
import "@aerift/ui/styles.css";
import { AndroidApp, IosApp } from "./ios/IosApp";
import { DesktopApp } from "./windows/DesktopApp";
import { DesktopTransferPreview } from "./windows/DesktopTransferPreview";

export function App() {
  if (isTauri()) {
    if (/Windows/.test(navigator.userAgent)) {
      const surface = new URLSearchParams(location.search).get("surface");
      return surface === "desktop-preview" ? <DesktopTransferPreview /> : <DesktopApp />;
    }
    if (/Android/.test(navigator.userAgent)) return <AndroidApp />;
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) return <IosApp />;
  }
  return (
    <ThemeProvider>
      <AppShell brand={<h1 className="aerift-title">AeRift</h1>}>
        <h2>Nearby devices</h2>
        <p>Disconnected</p>
      </AppShell>
    </ThemeProvider>
  );
}

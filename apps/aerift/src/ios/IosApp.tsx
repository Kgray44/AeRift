import { AppShell, Button, ConnectionStatus, SettingsPanel, Sheet, ThemeProvider, TransferWorkspace, type AppearanceSettings, type WorkspaceConnection } from "@aerift/ui";
import type { AppSnapshot } from "@aerift/app-contract";
import { useState } from "react";
import { DeviceTrust } from "../DeviceTrust";
import { nativeAppPort, command } from "../nativeAppPort";
import { IosGestureCamera } from "./IosGestureCamera";
import "./ios.css";

type DiscoveryState = "disabled" | "starting" | "ready" | "suspended" | "unavailable";
type IosSnapshot = AppSnapshot & { localNetwork?: DiscoveryState };

const appearanceDefaults: AppearanceSettings = {
  theme: "glass",
  scheme: "system",
  contrast: "system",
  transparency: "system",
  motion: "system",
};
const appearanceKey = "aerift.ios.appearance.v1";

function readAppearance(): AppearanceSettings {
  try {
    const settings = JSON.parse(localStorage.getItem(appearanceKey) ?? "{}");
    return {
      theme: "glass",
      scheme: settings.scheme === "light" || settings.scheme === "dark" ? settings.scheme : "system",
      contrast: settings.contrast === "increase" ? "increase" : "system",
      transparency: settings.transparency === "reduce" ? "reduce" : "system",
      motion: settings.motion === "reduce" ? "reduce" : "system",
    };
  } catch {
    return appearanceDefaults;
  }
}

export function IosApp() {
  const [connection, setConnection] = useState<WorkspaceConnection>({ state: "connecting" });
  const [watchAttempt, setWatchAttempt] = useState(0);
  const snapshot: IosSnapshot | undefined = connection.state === "ready" ? connection.snapshot : undefined;
  const [appearance, setAppearance] = useState(readAppearance);
  const [sheet, setSheet] = useState<"devices" | "settings">();
  const [discoveryError, setDiscoveryError] = useState(false);

  function retryConnection() {
    setDiscoveryError(false);
    setWatchAttempt(attempt => attempt + 1);
  }

  async function discover() {
    setDiscoveryError(false);
    const result = await command<void>("retry_ios_discovery");
    if (!result.ok) setDiscoveryError(true);
  }

  function updateAppearance(value: AppearanceSettings) {
    setAppearance(value);
    try {
      localStorage.setItem(appearanceKey, JSON.stringify(value));
    } catch {
      // Settings still apply until the app reloads.
    }
  }

  const paired = snapshot?.devices.some((device) => device.online && device.paired);
  const discoveryUnavailable = discoveryError || snapshot?.localNetwork === "unavailable";
  const searching = connection.state !== "disconnected" && !discoveryUnavailable;

  return (
    <div className="aerift-ios">
      <ThemeProvider {...appearance}>
        <AppShell brand={<h1 className="aerift-title">AeRift</h1>} toolbar={
          <>
            <ConnectionStatus state={paired ? "connected" : searching ? "searching" : "offline"}
              label={paired ? "Paired" : !searching ? "Disconnected" : snapshot ? "Searching" : "Connecting"} />
            <Button onClick={() => setSheet("devices")}>Devices</Button>
            <Button onClick={() => setSheet("settings")}>Settings</Button>
          </>
        }>
          {discoveryUnavailable && <div className="aerift-ios-network">
            <p role="status">Allow Local Network access in iPhone Settings to find AeRift devices nearby.</p>
            <Button onClick={() => void discover()}>Retry discovery</Button>
          </div>}
          <TransferWorkspace
            port={nativeAppPort}
            connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
            activityFooter={<p>Received files appear in Files → On My iPhone → AeRift → Received.</p>}
            gesture={(controls) => <IosGestureCamera controls={controls} enabled={!sheet} />}
          />
        </AppShell>
        <Sheet open={sheet === "devices"} title="Devices" onClose={() => setSheet(undefined)}>
          {sheet === "devices" && <DeviceTrust snapshot={snapshot} />}
        </Sheet>
        <Sheet open={sheet === "settings"} title="Settings" onClose={() => setSheet(undefined)}>
          <SettingsPanel value={appearance} themes={[{ id: "glass", label: "GLASS" }]}
            onChange={updateAppearance} />
          <section aria-label="Privacy and permissions">
            <p>Local Network lets AeRift find nearby devices and transfer files over Wi-Fi.</p>
            <p>The camera runs during an active gesture attempt. Recognition runs on this iPhone.</p>
            <p>Choose Files or Photos to share a single item with AeRift.</p>
            <p>Keep AeRift on screen until the transfer finishes.</p>
          </section>
        </Sheet>
      </ThemeProvider>
    </div>
  );
}

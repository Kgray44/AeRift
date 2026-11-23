import {
  AppBrand, AppShell, Button, GestureCameraIndicator, SettingsPanel, Sheet, SpatialIcon, ThemeProvider, TransferWorkspace,
  type AppearanceSettings, type DiscoveryState, type GestureCameraStatus, type WorkspaceConnection,
} from "@aerift/ui";
import type { AppSnapshot } from "@aerift/app-contract";
import { useState } from "react";
import { DeviceTrust } from "../DeviceTrust";
import { nativeAppPort, command } from "../nativeAppPort";
import { IosGestureCamera } from "./IosGestureCamera";
import "./ios.css";

type BonjourState = "disabled" | "starting" | "ready" | "suspended" | "unavailable";
type IosSnapshot = AppSnapshot & { localNetwork?: BonjourState };

const appearanceDefaults: AppearanceSettings = {
  theme: "glass",
  scheme: "system",
  contrast: "system",
  transparency: "system",
  motion: "system",
};
const appearanceKey = "aerift.ios.appearance.v1";
const gesturesKey = "aerift.ios.gestures.enabled";

function readGesturesEnabled() {
  try {
    return localStorage.getItem(gesturesKey) === "true";
  } catch {
    return false;
  }
}

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
  const [controlOpen, setControlOpen] = useState(false);
  const [pairRequest, setPairRequest] = useState(0);
  const [gesturesEnabled, setGesturesEnabled] = useState(readGesturesEnabled);
  const [cameraStatus, setCameraStatus] = useState<GestureCameraStatus>();
  const [cameraRetry, setCameraRetry] = useState(0);
  const [discoveryError, setDiscoveryError] = useState(false);
  const [retryingDiscovery, setRetryingDiscovery] = useState(false);

  function retryConnection() {
    setDiscoveryError(false);
    setWatchAttempt(attempt => attempt + 1);
  }

  async function discover() {
    setRetryingDiscovery(true);
    setDiscoveryError(false);
    try {
      const result = await command<void>("retry_ios_discovery");
      if (!result.ok) setDiscoveryError(true);
    } finally {
      setRetryingDiscovery(false);
    }
  }

  function updateAppearance(value: AppearanceSettings) {
    setAppearance(value);
    try {
      localStorage.setItem(appearanceKey, JSON.stringify(value));
    } catch {
      // Settings still apply until the app reloads.
    }
  }

  function updateGestures(enabled: boolean) {
    setGesturesEnabled(enabled);
    try {
      localStorage.setItem(gesturesKey, String(enabled));
    } catch {
      // This setting still applies for the session.
    }
  }

  const discoveryUnavailable = discoveryError || snapshot?.localNetwork === "unavailable";
  const discoveryDisabled = snapshot?.localNetwork === "disabled";
  const discovery: DiscoveryState = connection.state === "connecting" ? "connecting"
    : connection.state === "disconnected" ? "interrupted"
    : retryingDiscovery || snapshot?.localNetwork === "starting" ? "searching"
    : discoveryUnavailable || snapshot?.localNetwork === "suspended" ? "interrupted"
    : discoveryDisabled ? "disabled"
    : snapshot?.devices.some(device => device.online) ? "available" : "empty";

  return (
    <div className="aerift-ios">
      <ThemeProvider {...appearance}>
        <AppShell hideToolbar>
          <TransferWorkspace
            port={nativeAppPort}
            platform="ios"
            discovery={discovery}
            discoveryNotice={(discoveryUnavailable || discoveryDisabled) && <div className="aerift-shell-notice aerift-ios-network">
              <p role="status">Allow Local Network access in iOS Settings to find AeRift devices nearby.</p>
              <Button variant="quiet" onClick={() => void discover()} loading={retryingDiscovery} loadingLabel="Retrying discovery…">Retry discovery</Button>
            </div>}
            navigationStart={<AppBrand />}
            navigationEnd={<><GestureCameraIndicator status={cameraStatus} /><Button className="ae-control-gear" variant="quiet" aria-label="Control Center"
              aria-haspopup="dialog" title="Control Center" onClick={() => setControlOpen(true)}>
              <SpatialIcon name="settings" />
            </Button></>}
            pairRequest={pairRequest}
            connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
            activityFooter={<p>Open the AeRift Received folder under On My iPhone in Files.</p>}
            gesture={(controls) => <IosGestureCamera controls={controls} enabled={gesturesEnabled} actionsBlocked={controlOpen}
              retryKey={cameraRetry} onStatus={setCameraStatus} />}
          />
        </AppShell>
        <Sheet open={controlOpen} title="Control Center" onClose={() => setControlOpen(false)}>
          {controlOpen && <div className="aerift-control-center">
            <section aria-label="Devices and pairing">
              <h3>Devices and pairing</h3>
              <DeviceTrust snapshot={snapshot} />
              <Button onClick={() => { setControlOpen(false); setPairRequest(request => request + 1); }} disabled={!snapshot}>
                <SpatialIcon name="pair" size={17} />Pair a device
              </Button>
            </section>
            <section aria-label="Appearance and accessibility">
              <h3>Appearance and accessibility</h3>
              <SettingsPanel value={appearance} themes={[{ id: "glass", label: "GLASS" }]} onChange={updateAppearance} />
            </section>
            <section aria-label="Permissions">
              <h3>Permissions</h3>
              <p>Local Network access lets AeRift find nearby devices and transfer files over Wi-Fi.</p>
            </section>
            <section aria-label="Gestures and camera">
              <h3>Gestures and camera</h3>
              <label className="ae-camera-toggle">Enable camera gestures
                <input type="checkbox" checked={gesturesEnabled} onChange={event => updateGestures(event.currentTarget.checked)} />
              </label>
              <p>The front camera listens with a selected file and recipient or an incoming offer while AeRift is open in portrait. Hand recognition stays on this device.</p>
              {gesturesEnabled && <p role="status"><strong>{cameraStatus?.label ?? "Camera standby"}</strong> {cameraStatus?.detail}</p>}
              {gesturesEnabled && (cameraStatus?.state === "permission" || cameraStatus?.state === "unavailable" ||
                cameraStatus?.state === "paused") && <div>
                <p>Allow camera access for AeRift in iOS Settings, then return to the workspace.</p>
                <Button onClick={() => setCameraRetry(value => value + 1)}>Retry camera</Button>
              </div>}
            </section>
            <section aria-label="Transfers">
              <h3>Transfers</h3>
              <p>Choose Files or Photos to share a single item with AeRift.</p>
              <p>Keep AeRift on screen until the transfer finishes.</p>
            </section>
          </div>}
        </Sheet>
      </ThemeProvider>
    </div>
  );
}

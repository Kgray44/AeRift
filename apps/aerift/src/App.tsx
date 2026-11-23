import { isTauri } from "@tauri-apps/api/core";
import {
  AppBrand,
  AppShell,
  Button,
  GestureCameraIndicator,
  SettingsPanel,
  Sheet,
  SpatialIcon,
  ThemeProvider,
  TransferWorkspace,
  type AppearanceSettings,
  type GestureCameraStatus,
  type WorkspaceConnection,
} from "@aerift/ui";
import "@aerift/ui/styles.css";
import type { FileSelection } from "@aerift/app-contract";
import { useCallback, useEffect, useState } from "react";
import { nativeAppPort } from "./nativeAppPort";
import { desktopSettings, watchFileSelection, type ReceiveFolder } from "./windows/nativeAppPort";
import { GestureCamera, cameraShortcutLabels, type CameraShortcut } from "./windows/GestureCamera";
import { DeviceTrust } from "./DeviceTrust";
import { IosApp } from "./ios/IosApp";

const defaults: AppearanceSettings = {
  theme: "glass",
  scheme: "system",
  contrast: "system",
  transparency: "system",
  motion: "system",
};
const settingsKey = "aerift.settings.v1";
type Settings = { appearance: AppearanceSettings; cameraShortcut: CameraShortcut; gesturesEnabled: boolean; cameraDeviceId?: string };

function readSettings(): Settings {
  try {
    const source = JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
    const settings = source.appearance ?? {};
    return {
      appearance: {
        theme: "glass",
        scheme: settings.scheme === "light" || settings.scheme === "dark" ? settings.scheme : "system",
        contrast: settings.contrast === "increase" ? "increase" : "system",
        transparency: settings.transparency === "reduce" ? "reduce" : "system",
        motion: settings.motion === "reduce" ? "reduce" : "system",
      },
      cameraShortcut: source.cameraShortcut === "off" || source.cameraShortcut === "v" ? source.cameraShortcut : "c",
      gesturesEnabled: source.gesturesEnabled === true,
      cameraDeviceId: typeof source.cameraDeviceId === "string" ? source.cameraDeviceId : undefined,
    };
  } catch {
    return { appearance: defaults, cameraShortcut: "c", gesturesEnabled: false };
  }
}

function WindowsApp() {
  const [connection, setConnection] = useState<WorkspaceConnection>({ state: "connecting" });
  const [watchAttempt, setWatchAttempt] = useState(0);
  const snapshot = connection.state === "ready" ? connection.snapshot : undefined;
  const [controlOpen, setControlOpen] = useState(false);
  const [pairRequest, setPairRequest] = useState(0);
  const [settings, setSettings] = useState(readSettings);
  const [dropError, setDropError] = useState<string>();
  const [folder, setFolder] = useState<ReceiveFolder>();
  const [folderError, setFolderError] = useState(false);
  const [openingFolderPicker, setOpeningFolderPicker] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<GestureCameraStatus>();
  const [cameraRetry, setCameraRetry] = useState(0);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!controlOpen || !navigator.mediaDevices?.enumerateDevices) return;
    let disposed = false;
    async function refreshCameras() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!disposed) setCameras(devices.filter(device => device.kind === "videoinput" && !!device.label && !!device.deviceId));
      } catch {
        if (!disposed) setCameras([]);
      }
    }
    void refreshCameras();
    navigator.mediaDevices.addEventListener("devicechange", refreshCameras);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener("devicechange", refreshCameras);
    };
  }, [controlOpen, cameraStatus?.state]);

  useEffect(() => {
    let disposed = false;
    if (snapshot) {
      void desktopSettings.folder().then((result) => {
        if (!disposed && result.ok) setFolder(result.value);
      });
    }
    return () => { disposed = true; };
  }, [!!snapshot]);

  const watchSelection = useCallback((listener: (file: FileSelection | null) => void) =>
    watchFileSelection(update => {
      if (update.kind === "changed") {
        listener(update.selection);
        setDropError(undefined);
      } else {
        setDropError(update.error.code === "invalid_request" ? "Drop one regular file." :
          update.error.code === "storage_failed" ? "AeRift could not read that file." :
          "AeRift could not update the file selection.");
      }
    }), []);

  function updateSettings(next: Settings) {
    setSettings(next);
    try {
      localStorage.setItem(settingsKey, JSON.stringify(next));
    } catch {
      // Preferences still apply for this session if storage is unavailable.
    }
  }

  function retryConnection() {
    setWatchAttempt(attempt => attempt + 1);
  }

  async function selectDestination() {
    setOpeningFolderPicker(true);
    setFolderError(false);
    try {
      const result = await desktopSettings.chooseFolder();
      if (!result.ok) setFolderError(true);
      else if (result.value) {
        setFolder(result.value);
        if (!snapshot) retryConnection();
      }
    } finally {
      setOpeningFolderPicker(false);
    }
  }

  return (
    <ThemeProvider {...settings.appearance}>
      <AppShell hideToolbar>
        <TransferWorkspace
          port={nativeAppPort}
          platform="windows"
          allowDrop
          watchSelection={watchSelection}
          navigationStart={<AppBrand />}
          navigationEnd={<><GestureCameraIndicator status={cameraStatus} /><Button className="ae-control-gear" variant="quiet" aria-label="Control Center"
            aria-haspopup="dialog" title="Control Center" onClick={() => setControlOpen(true)}>
            <SpatialIcon name="settings" />
          </Button></>}
          pairRequest={pairRequest}
          discoveryNotice={dropError && <p className="aerift-shell-notice" role="alert">{dropError}</p>}
          connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
          activityFooter={folder?.active && <p>Incoming files are saved to {folder.active}.</p>}
          gesture={(controls) => <GestureCamera controls={controls}
            shortcut={settings.cameraShortcut} enabled={settings.gesturesEnabled} actionsBlocked={controlOpen} source={settings.cameraDeviceId}
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
            <SettingsPanel
              value={settings.appearance}
              themes={[{ id: "glass", label: "GLASS" }]}
              onChange={(appearance) => updateSettings({ ...settings, appearance })}
            />
          </section>
          <section aria-label="Gestures and camera">
            <h3>Gestures and camera</h3>
            <div className="ae-settings">
              <label className="ae-camera-toggle">Enable camera gestures
                <input type="checkbox" checked={settings.gesturesEnabled} onChange={event =>
                  updateSettings({ ...settings, gesturesEnabled: event.currentTarget.checked })} />
              </label>
              <p>When enabled, the camera listens in the foreground workspace with a selected file and recipient or an incoming offer. Hand recognition stays on this device.</p>
              {settings.gesturesEnabled && <p role="status"><strong>{cameraStatus?.label ?? "Camera standby"}</strong> {cameraStatus?.detail}</p>}
              {settings.gesturesEnabled && (cameraStatus?.state === "permission" || cameraStatus?.state === "unavailable" ||
                cameraStatus?.state === "paused") && <div>
                <p>Allow camera access for AeRift in Windows privacy settings if prompted.</p>
                <Button onClick={() => setCameraRetry(value => value + 1)}>Retry camera</Button>
              </div>}
              {(cameras.length > 0 || settings.cameraDeviceId) && <label>Camera
                <select value={settings.cameraDeviceId ?? ""} onChange={event =>
                  updateSettings({ ...settings, cameraDeviceId: event.currentTarget.value || undefined })}>
                  <option value="">System default</option>
                  {settings.cameraDeviceId && !cameras.some(camera => camera.deviceId === settings.cameraDeviceId) &&
                    <option value={settings.cameraDeviceId}>Selected camera unavailable</option>}
                  {cameras.map(camera => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
                </select>
              </label>}
              <label>Camera shortcut in AeRift
                <select value={settings.cameraShortcut} onChange={(event) =>
                  updateSettings({ ...settings, cameraShortcut: event.currentTarget.value as CameraShortcut })}>
                  {Object.entries(cameraShortcutLabels).map(([key, label]) =>
                    <option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              <p>The shortcut pauses or resumes enabled gestures for this session.</p>
            </div>
          </section>
          <section aria-label="Incoming files">
            <h3>Incoming files</h3>
            {folder?.active && <p>Current receive folder <strong>{folder.active}</strong></p>}
            {folder?.next && <p>Restart AeRift to use <strong>{folder.next}</strong> for incoming files.</p>}
            <Button onClick={() => void selectDestination()} loading={openingFolderPicker}
              loadingLabel="Opening folder picker">Choose receive folder</Button>
            {folderError && <p role="alert">AeRift could not use that folder.</p>}
          </section>
        </div>}
      </Sheet>
    </ThemeProvider>
  );
}

export function App() {
  if (isTauri()) {
    if (/Windows/.test(navigator.userAgent)) return <WindowsApp />;
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

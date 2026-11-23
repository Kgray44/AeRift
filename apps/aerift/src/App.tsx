import { isTauri } from "@tauri-apps/api/core";
import {
  AppShell,
  Button,
  ConnectionStatus,
  SettingsPanel,
  Sheet,
  ThemeProvider,
  TransferWorkspace,
  type AppearanceSettings,
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
type Settings = { appearance: AppearanceSettings; cameraShortcut: CameraShortcut };

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
    };
  } catch {
    return { appearance: defaults, cameraShortcut: "c" };
  }
}

function WindowsApp() {
  const [connection, setConnection] = useState<WorkspaceConnection>({ state: "connecting" });
  const [watchAttempt, setWatchAttempt] = useState(0);
  const snapshot = connection.state === "ready" ? connection.snapshot : undefined;
  const [sheet, setSheet] = useState<"devices" | "settings">();
  const [settings, setSettings] = useState(readSettings);
  const [dropError, setDropError] = useState<string>();
  const [folder, setFolder] = useState<ReceiveFolder>();
  const [folderError, setFolderError] = useState(false);
  const [openingFolderPicker, setOpeningFolderPicker] = useState(false);

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

  const pairedOnline = snapshot?.devices.some((device) => device.online && device.paired);

  return (
    <ThemeProvider {...settings.appearance}>
      <AppShell brand={<h1 className="aerift-title">AeRift</h1>} toolbar={
        <>
          <ConnectionStatus state={pairedOnline ? "connected" : connection.state === "disconnected" ? "offline" : "searching"}
            label={pairedOnline ? "Paired" : connection.state === "disconnected" ? "Disconnected" : snapshot ? "Searching" : "Connecting"} />
          <Button onClick={() => setSheet("devices")}>Devices</Button>
          <Button onClick={() => setSheet("settings")}>Settings</Button>
        </>
      }>
        {dropError && <p role="alert">{dropError}</p>}
        <TransferWorkspace
          port={nativeAppPort}
          watchSelection={watchSelection}
          connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
          activityFooter={folder?.active && <p>Incoming files are saved to {folder.active}.</p>}
          gesture={(controls) => <GestureCamera controls={controls}
            shortcut={settings.cameraShortcut} enabled={!sheet} />}
        />
      </AppShell>

      <Sheet open={sheet === "devices"} title="Devices" onClose={() => setSheet(undefined)}>
        {sheet === "devices" && <DeviceTrust snapshot={snapshot} />}
      </Sheet>
      <Sheet open={sheet === "settings"} title="Settings" onClose={() => setSheet(undefined)}>
        <SettingsPanel
          value={settings.appearance}
          themes={[{ id: "glass", label: "GLASS" }]}
          onChange={(appearance) => updateSettings({ ...settings, appearance })}
        />
        <div className="ae-settings">
          <label>Camera shortcut in AeRift
            <select value={settings.cameraShortcut} onChange={(event) =>
              updateSettings({ ...settings, cameraShortcut: event.currentTarget.value as CameraShortcut })}>
              {Object.entries(cameraShortcutLabels).map(([key, label]) =>
                <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          {folder?.active && <p>Current receive folder <strong>{folder.active}</strong></p>}
          {folder?.next && <p>Restart AeRift to use <strong>{folder.next}</strong> for incoming files.</p>}
          <Button onClick={() => void selectDestination()} loading={openingFolderPicker}
            loadingLabel="Opening folder picker">Choose receive folder</Button>
          {folderError && <p role="alert">AeRift could not use that folder.</p>}
        </div>
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

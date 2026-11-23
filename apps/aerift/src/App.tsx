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
} from "@aerift/ui";
import "@aerift/ui/styles.css";
import type { AppSnapshot, FileSelection } from "@aerift/app-contract";
import { useEffect, useState } from "react";
import { desktopSettings, nativeAppPort, watchFileDrop, type ReceiveFolder } from "./windows/nativeAppPort";
import { GestureCamera, cameraShortcutLabels, type CameraShortcut } from "./windows/GestureCamera";
import { DeviceTrust } from "./windows/DeviceTrust";

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
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [watchAttempt, retryWatch] = useState(0);
  const [sheet, setSheet] = useState<"devices" | "settings">();
  const [settings, setSettings] = useState(readSettings);
  const [droppedSelection, setDroppedSelection] = useState<FileSelection | null>(null);
  const [dropError, setDropError] = useState<string>();
  const [folder, setFolder] = useState<ReceiveFolder>();
  const [folderError, setFolderError] = useState(false);
  const [openingFolderPicker, setOpeningFolderPicker] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unwatch: (() => void) | undefined;
    void nativeAppPort.watch((next) => {
      if (!disposed) setSnapshot(next);
    }).then((result) => {
      if (!result.ok) return;
      if (disposed) result.value();
      else unwatch = result.value;
    });
    const stopDrop = watchFileDrop((update) => {
      if (disposed) return;
      if (update.kind === "dropped") {
        setDroppedSelection(update.selection);
        setDropError(undefined);
      } else {
        setDropError(update.error.code === "storage_failed"
          ? "AeRift could not read that file." : "Drop one regular file.");
      }
    });
    return () => {
      disposed = true;
      stopDrop();
      unwatch?.();
    };
  }, [watchAttempt]);

  useEffect(() => {
    let disposed = false;
    if (snapshot) {
      void desktopSettings.folder().then((result) => {
        if (!disposed && result.ok) setFolder(result.value);
      });
    }
    return () => { disposed = true; };
  }, [!!snapshot]);

  function updateSettings(next: Settings) {
    setSettings(next);
    try {
      localStorage.setItem(settingsKey, JSON.stringify(next));
    } catch {
      // Preferences still apply for this session if storage is unavailable.
    }
  }

  async function selectDestination() {
    setOpeningFolderPicker(true);
    setFolderError(false);
    try {
      const result = await desktopSettings.chooseFolder();
      if (!result.ok) setFolderError(true);
      else if (result.value) {
        setFolder(result.value);
        if (!snapshot) retryWatch((attempt) => attempt + 1);
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
          <ConnectionStatus state={pairedOnline ? "connected" : snapshot ? "searching" : "offline"}
            label={pairedOnline ? "Paired" : snapshot ? "Searching" : "Disconnected"} />
          <Button onClick={() => setSheet("devices")}>Devices</Button>
          <Button onClick={() => setSheet("settings")}>Settings</Button>
        </>
      }>
        {dropError && <p role="alert">{dropError}</p>}
        <TransferWorkspace
          port={nativeAppPort}
          droppedSelection={droppedSelection}
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
  if (isTauri() && /Windows/.test(navigator.userAgent)) return <WindowsApp />;
  return (
    <ThemeProvider>
      <AppShell brand={<h1 className="aerift-title">AeRift</h1>}>
        <h2>Nearby devices</h2>
        <p>Disconnected</p>
      </AppShell>
    </ThemeProvider>
  );
}

import { Button, SettingsPanel, type AppearanceSettings, type GestureCameraStatus } from "@aerift/ui";
import { WORKSPACE_MODULES, type ModuleId } from "@aerift/app-contract/experience";
import { useEffect, useState } from "react";
import { cameraShortcutLabels, type CameraShortcut } from "./GestureCamera";
import { command } from "../nativeAppPort";
import type { DesktopPreferences } from "./preferences";
import type { ReceiveFolder } from "./nativeAppPort";

export function DesktopSettings({ value, onChange, folder, folderError, openingFolderPicker, chooseFolder,
  ambientAvailable, ambientError, shortcutError, cameraStatus, retryCamera }: {
  value: DesktopPreferences;
  onChange(value: DesktopPreferences): void;
  folder?: ReceiveFolder;
  folderError: boolean;
  openingFolderPicker: boolean;
  chooseFolder(): void;
  ambientAvailable: boolean;
  ambientError: boolean;
  shortcutError: boolean;
  cameraStatus?: GestureCameraStatus;
  retryCamera(): void;
}) {
  const { experience } = value;
  const [explorerEnabled, setExplorerEnabled] = useState<boolean>();
  const [explorerUpdating, setExplorerUpdating] = useState(false);
  const [explorerError, setExplorerError] = useState(false);
  const [startupEnabled, setStartupEnabled] = useState<boolean>();
  const [startupPending, setStartupPending] = useState(false);
  const [startupError, setStartupError] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraAvailability, setCameraAvailability] = useState("Checking camera availability…");

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) {
      setCameraAvailability("Camera discovery is unavailable.");
      return;
    }
    let disposed = false;
    async function refresh() {
      try {
        const all = await media.enumerateDevices();
        if (disposed) return;
        const input = all.filter(device => device.kind === "videoinput");
        setCameras(input.filter(device => device.deviceId));
        setCameraAvailability(input.length
          ? "Camera available · off while Settings is open"
          : "No camera exposed. Check Windows camera permissions and connections.");
      } catch {
        if (!disposed) setCameraAvailability("Camera discovery failed. Check Windows camera permissions.");
      }
    }
    void refresh();
    media.addEventListener("devicechange", refresh);
    return () => {
      disposed = true;
      media.removeEventListener("devicechange", refresh);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void command<boolean>("desktop_explorer_enabled").then(result => {
      if (!disposed && result.ok) setExplorerEnabled(result.value);
    });
    void command<boolean>("desktop_startup_enabled").then(result => {
      if (!disposed && result.ok) setStartupEnabled(result.value);
    });
    return () => { disposed = true; };
  }, []);

  async function setExplorer(enabled: boolean) {
    setExplorerUpdating(true);
    setExplorerError(false);
    const result = await command<boolean>("set_desktop_explorer", { enabled });
    if (result.ok) setExplorerEnabled(result.value);
    else setExplorerError(true);
    setExplorerUpdating(false);
  }

  async function setStartup(enabled: boolean) {
    setStartupPending(true);
    setStartupError(false);
    const result = await command<boolean>("set_desktop_startup", { enabled });
    if (result.ok) setStartupEnabled(result.value);
    else setStartupError(true);
    setStartupPending(false);
  }

  function updateAppearance(appearance: AppearanceSettings) {
    onChange({ ...value, experience: { ...experience, ...appearance } });
  }

  function setModule(id: ModuleId, enabled: boolean) {
    const hiddenModules = enabled ? experience.hiddenModules.filter(module => module !== id) : [...experience.hiddenModules, id];
    onChange({ ...value, experience: { ...experience, hiddenModules } });
  }

  return <div className="aerift-settings-grid">
    <section aria-labelledby="experience-heading">
      <h3 id="experience-heading">Experience</h3>
      <label>Window mode
        <select value={experience.windowMode} onChange={event => onChange({ ...value, experience: {
          ...experience, windowMode: event.currentTarget.value === "full" ? "full" : "simplified",
        } })}>
          <option value="simplified">Simplified</option>
          <option value="full">Full workspace</option>
        </select>
      </label>
      <label>Navigation
        <select value={experience.desktopNavigation} onChange={event => onChange({ ...value, experience: {
          ...experience, desktopNavigation: event.currentTarget.value === "conventional" ? "conventional" : "orbit",
        } })}>
          <option value="orbit">Orbit</option>
          <option value="conventional">Navigation bar</option>
        </select>
      </label>
      <label>Orbit shortcut
        <select value={value.orbitShortcut} onChange={event => {
          const shortcut = event.currentTarget.value;
          onChange({ ...value, orbitShortcut: shortcut === "off" || shortcut === "alt-shift-o" ? shortcut : "alt-o" });
        }}>
          <option value="alt-o">Alt + O</option>
          <option value="alt-shift-o">Alt + Shift + O</option>
          <option value="off">None</option>
        </select>
      </label>
      <fieldset>
        <legend>Workspace modules</legend>
        {WORKSPACE_MODULES.map(module => <label className="aerift-check" key={module.id}>
          <input type="checkbox" checked={!experience.hiddenModules.includes(module.id)}
            onChange={event => setModule(module.id, event.currentTarget.checked)} />{module.label}
        </label>)}
      </fieldset>
    </section>
    <section aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">Appearance and accessibility</h3>
      <SettingsPanel value={experience} themes={[{ id: "glass", label: "GLASS" }]} onChange={updateAppearance} />
    </section>
    <section aria-labelledby="gestures-heading">
      <h3 id="gestures-heading">Gestures and camera</h3>
      <label className="aerift-check"><input type="checkbox" checked={value.gestures}
        onChange={event => onChange({ ...value, gestures: event.currentTarget.checked })} />Enable gesture recognition in the Rift</label>
      <p>{cameraAvailability}</p>
      {value.gestures && cameraStatus && <p role="status">{cameraStatus.label}. {cameraStatus.detail}</p>}
      {value.gestures && <Button onClick={retryCamera}>Retry camera when I return to the Rift</Button>}
      <label>Camera
        <select value={value.cameraId} onChange={event => onChange({ ...value, cameraId: event.currentTarget.value })}>
          <option value="">System default</option>
          {value.cameraId && !cameras.some(camera => camera.deviceId === value.cameraId) &&
            <option value={value.cameraId}>Previously selected camera</option>}
          {cameras.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>
            {camera.label || `Camera ${index + 1}`}
          </option>)}
        </select>
      </label>
      <label>Camera activation shortcut
        <select value={value.cameraShortcut} onChange={event => onChange({ ...value, cameraShortcut: event.currentTarget.value as CameraShortcut })}>
          {Object.entries(cameraShortcutLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <p>AeRift listens only in the foreground Rift while an object and recipient, or an incoming offer, are available. The shortcut pauses or resumes recognition for this session.</p>
    </section>
    <section aria-labelledby="transfer-settings-heading">
      <h3 id="transfer-settings-heading">Transfers and storage</h3>
      {folder?.active && <p>Receive folder <strong>{folder.active}</strong></p>}
      {folder?.next && <p>Restart AeRift to use <strong>{folder.next}</strong> for incoming files.</p>}
      <Button onClick={chooseFolder} loading={openingFolderPicker} loadingLabel="Opening folder picker">Choose receive folder</Button>
      {folderError && <p role="alert">AeRift could not use that folder.</p>}
      {explorerEnabled !== undefined && <>
        <label className="aerift-check">
          <input type="checkbox" checked={explorerEnabled} disabled={explorerUpdating}
            onChange={event => void setExplorer(event.currentTarget.checked)} />
          Add Stage in AeRift to the File Explorer context menu
        </label>
        <p>Stage one file, then choose a device and confirm the transfer in the Rift.</p>
        {explorerError && <p role="alert">AeRift could not update the File Explorer menu.</p>}
      </>}
    </section>
    <section aria-labelledby="clipboard-heading">
      <h3 id="clipboard-heading">Clipboard privacy</h3>
      <label className="aerift-check"><input type="checkbox" checked={value.clipboard}
        onChange={event => onChange({ ...value, clipboard: event.currentTarget.checked })} />Allow manual clipboard capture in Workspace</label>
      <p>AeRift reads clipboard text only when you choose to capture it. Saved entries stay on this device.</p>
    </section>
    {(ambientAvailable || startupEnabled !== undefined) && <section aria-labelledby="ambient-heading">
      <h3 id="ambient-heading">Ambient operation</h3>
      {ambientAvailable && <label className="aerift-check"><input type="checkbox" checked={experience.ambientEnabled}
        onChange={event => onChange({ ...value, experience: { ...experience, ambientEnabled: event.currentTarget.checked } })} />
        Keep AeRift in the Windows notification area when closing its window</label>}
      {ambientAvailable && <label className="aerift-check">
        <input type="checkbox" checked={value.ambientNotifications} disabled={!experience.ambientEnabled}
          onChange={event => onChange({ ...value, ambientNotifications: event.currentTarget.checked })} />
        Notify me of incoming offers when AeRift is in the notification area
      </label>}
      {ambientAvailable && <label>Windows shortcut to open the Rift
        <select value={value.ambientShortcut} disabled={!experience.ambientEnabled} onChange={event => {
          const choice = event.currentTarget.value;
          onChange({ ...value, ambientShortcut: choice === "alt-shift-r" || choice === "ctrl-alt-r" ? choice : "off" });
        }}>
          <option value="off">None</option>
          <option value="alt-shift-r">Alt + Shift + R</option>
          <option value="ctrl-alt-r">Ctrl + Alt + R</option>
        </select>
      </label>}
      {shortcutError && <p role="alert">AeRift could not register the Windows shortcut. Choose another shortcut.</p>}
      {ambientError && <p role="alert">AeRift could not change its notification area visibility.</p>}
      {startupEnabled !== undefined && <label className="aerift-check">
        <input type="checkbox" checked={startupEnabled} disabled={startupPending}
          onChange={event => void setStartup(event.currentTarget.checked)} />Open AeRift when I sign in to Windows
      </label>}
      {startupError && <p role="alert">AeRift could not update Windows startup settings.</p>}
    </section>}
  </div>;
}

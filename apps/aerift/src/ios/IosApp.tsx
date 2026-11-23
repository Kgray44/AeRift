import {
  AppBrand, AppShell, Button, GestureCameraIndicator, GlassSurface, SettingsPanel, Sheet,
  SpatialIcon, ThemeProvider, TransferProgress, TransferWorkspace,
  type AppearanceSettings, type DiscoveryState, type GestureCameraStatus, type WorkspaceConnection,
} from "@aerift/ui";
import type { AppPort, AppSnapshot, FileSelection } from "@aerift/app-contract";
import { createNavigationChange, DESTINATIONS, WORKSPACE_MODULES } from "@aerift/app-contract/experience";
import { useEffect, useMemo, useRef, useState } from "react";
import { DeviceTrust } from "../DeviceTrust";
import { nativeAppPort, command } from "../nativeAppPort";
import { IosGestureCamera, iosCameraPermission, type IosCameraPermission } from "./IosGestureCamera";
import { MobileNavigation } from "./MobileNavigation";
import { observeMobileMedia } from "./mobile-media-observer";
import { nativeMobileMedia, type MobileMediaPort } from "./mobile-media";
import { MobileWorkspace, type ModuleVisibility, type PickerSource } from "./MobileWorkspace";
import { decodeMobileObjects, persistMobileObjects, readMobileObjects, removeMobileObject, type MobileObject } from "./local-objects";
import { decodeMobileHistory, historyStorageKey, isTerminalRecord, recordTransfers, withArchivedTransfers } from "./mobile-history";
import { mobileNavigation, summarizeMobile, type MobileDestination } from "./mobile-experience";
import "./ios.css";

type BonjourState = "disabled" | "starting" | "ready" | "suspended" | "unavailable";
type IosSnapshot = AppSnapshot & { localNetwork?: BonjourState };

const appearanceDefaults: AppearanceSettings = {
  theme: "glass", scheme: "system", contrast: "system", transparency: "system", motion: "system",
};
const appearanceKey = "aerift.ios.appearance.v1";
const workspaceKey = "aerift.ios.workspace.v1";

function readSettings(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writeSettings(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function readAppearance(): AppearanceSettings {
  const settings = readSettings(appearanceKey);
  return {
    ...appearanceDefaults,
    scheme: settings.scheme === "light" || settings.scheme === "dark" ? settings.scheme : "system",
    contrast: settings.contrast === "increase" ? "increase" : "system",
    transparency: settings.transparency === "reduce" ? "reduce" : "system",
    motion: settings.motion === "reduce" ? "reduce" : "system",
  };
}

function readWorkspace() {
  const settings = readSettings(workspaceKey);
  return {
    files: settings.files !== false, photos: settings.photos !== false,
    notes: settings.notes !== false, browser: settings.browser !== false,
    clipboard: settings.clipboard === true, collections: settings.collections !== false,
    clipboardShare: settings.clipboardShare === true,
    rememberActivity: settings.rememberActivity === true,
    gestures: typeof settings.gestures === "boolean" ? settings.gestures :
      readSettings("aerift.ios.gestures.enabled") === true,
  };
}

function readObjects() {
  try {
    return readMobileObjects(localStorage);
  } catch {
    return undefined;
  }
}

function readHistory() {
  try {
    return decodeMobileHistory(localStorage.getItem(historyStorageKey) ?? "[]");
  } catch {
    return [];
  }
}

const pickNative = (source: PickerSource) => command<FileSelection | null>("select_app_file", { source });

export function IosApp({ port = nativeAppPort, pick = pickNative, media = nativeMobileMedia }: {
  port?: AppPort;
  media?: MobileMediaPort;
  pick?: (source: PickerSource) => ReturnType<AppPort["selectFile"]>;
} = {}) {
  const library = useMemo(() => observeMobileMedia(media), [media]);
  const [connection, setConnection] = useState<WorkspaceConnection>({ state: "connecting" });
  const [watchAttempt, setWatchAttempt] = useState(0);
  const snapshot: IosSnapshot | undefined = connection.state === "ready" ? connection.snapshot : undefined;
  const [appearance, setAppearance] = useState(readAppearance);
  const [preferences, setPreferences] = useState(readWorkspace);
  const canShareClipboard = preferences.clipboard && preferences.clipboardShare;
  const clipboardAllowed = useRef(canShareClipboard);
  const clipboardSelections = useRef(new Set<string>());
  const [objects, setObjects] = useState(readObjects);
  const [objectError, setObjectError] = useState("");
  const [history, setHistory] = useState(readHistory);
  const [historyError, setHistoryError] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const clearedReceipts = useRef(new Set<string>());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClearPins, setConfirmClearPins] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [destination, setDestination] = useState<MobileDestination>("home");
  const [discoveryError, setDiscoveryError] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<GestureCameraStatus>();
  const [cameraRetry, setCameraRetry] = useState(0);
  const [cameraPermission, setCameraPermission] = useState<IosCameraPermission>();
  const [requestingCamera, setRequestingCamera] = useState(false);
  const cameraPermissionRequest = useRef(0);
  const cameraPermissionPending = useRef(false);
  const [discovering, setDiscovering] = useState(false);
  const destinationHeading = useRef<HTMLHeadingElement>(null);
  const navigationRequested = useRef(false);
  const summary = summarizeMobile(snapshot);
  const liveTransfers = snapshot?.transfers;
  const recentTransfers = withArchivedTransfers(liveTransfers ?? [], history);
  const discoveryUnavailable = discoveryError || snapshot?.localNetwork === "unavailable";
  const connectionFailed = connection.state === "disconnected";
  const discoveryDisabled = snapshot?.localNetwork === "disabled";
  const discovery: DiscoveryState = connection.state === "connecting" ? "connecting"
    : connectionFailed ? "interrupted"
    : discovering || snapshot?.localNetwork === "starting" ? "searching"
    : discoveryUnavailable || snapshot?.localNetwork === "suspended" ? "interrupted"
    : discoveryDisabled ? "disabled"
    : summary.available ? "available" : "empty";
  const latestObject = objects?.find(item => item.kind !== "text" && preferences[
    item.kind === "note" ? "notes" : item.kind === "url" ? "browser" : "collections"
  ]);
  const pins = objects?.filter(item => item.kind === "text") ?? [];
  function closeSettings() {
    setConfirmClearPins(false);
    setConfirmClearHistory(false);
    setSettingsOpen(false);
  }

  useEffect(() => {
    if (!preferences.rememberActivity || !liveTransfers) return;
    const next = recordTransfers(history, liveTransfers.filter(item => !clearedReceipts.current.has(item.id)));
    if (next === history) return;
    const saved = writeSettings(historyStorageKey, next);
    setHistoryError(!saved);
    if (saved) setHistory(next);
  }, [history, liveTransfers, preferences.rememberActivity]);

  function clearSavedActivity() {
    if (!writeSettings(historyStorageKey, [])) {
      setHistoryError(true);
      return;
    }
    for (const item of liveTransfers ?? []) {
      if (isTerminalRecord(item)) clearedReceipts.current.add(item.id);
    }
    setHistory([]);
    setHistoryError(false);
    setConfirmClearHistory(false);
  }

  useEffect(() => {
    if (!navigationRequested.current || settingsOpen) return;
    navigationRequested.current = false;
    destinationHeading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [destination, settingsOpen]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    function updateKeyboard() {
      const editing = document.activeElement?.matches('textarea, input:not([type="checkbox"]):not([type="radio"])');
      const obscured = viewport ? window.innerHeight - viewport.height * viewport.scale : 0;
      setKeyboardOpen(!!editing && obscured > 120);
    }
    viewport.addEventListener("resize", updateKeyboard);
    document.addEventListener("focusin", updateKeyboard);
    document.addEventListener("focusout", updateKeyboard);
    return () => {
      viewport.removeEventListener("resize", updateKeyboard);
      document.removeEventListener("focusin", updateKeyboard);
      document.removeEventListener("focusout", updateKeyboard);
    };
  }, []);

  function navigate(next: MobileDestination) {
    const change = createNavigationChange(mobileNavigation, destination, next, "user");
    if (!change || change.to === "settings") return;
    navigationRequested.current = true;
    setDestination(change.to);
  }

  function retryConnection() {
    setDiscoveryError(false);
    setWatchAttempt(attempt => attempt + 1);
  }

  async function discover() {
    setDiscovering(true);
    setDiscoveryError(false);
    const result = await command<void>("retry_ios_discovery");
    setDiscoveryError(!result.ok);
    setDiscovering(false);
  }

  useEffect(() => {
    if (!settingsOpen) return;
    let active = true;
    const refresh = async () => {
      if (cameraPermissionPending.current) return;
      const request = ++cameraPermissionRequest.current;
      const status = await iosCameraPermission();
      if (active && request === cameraPermissionRequest.current) setCameraPermission(status);
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [settingsOpen]);

  async function requestCameraAccess() {
    if (cameraPermissionPending.current) return;
    cameraPermissionPending.current = true;
    cameraPermissionRequest.current++;
    setRequestingCamera(true);
    try {
      const status = await iosCameraPermission(true);
      setCameraPermission(status);
      if (status === "authorized") setCameraRetry(value => value + 1);
    } finally {
      cameraPermissionPending.current = false;
      setRequestingCamera(false);
    }
  }

  function updatePreferences(key: keyof ModuleVisibility | "gestures" | "rememberActivity" | "clipboardShare", checked: boolean) {
    const next = { ...preferences, [key]: checked };
    clipboardAllowed.current = next.clipboard && next.clipboardShare;
    setPreferences(next);
    setSettingsError(!writeSettings(workspaceKey, next));
  }

  function saveObjects(next: readonly MobileObject[]) {
    setObjectError("");
    if (!objects) return false;
    const serialized = JSON.stringify(next);
    if (!decodeMobileObjects(serialized)) {
      setObjectError("The local workspace has reached its storage limit. Remove an item and try again.");
      return false;
    }
    try {
      persistMobileObjects(localStorage, objects, next);
      setObjects([...next]);
      return true;
    } catch {
      setObjectError("AeRift couldn't save this change. Your earlier saved items are still available.");
      return false;
    }
  }

  return <div className="aerift-ios" data-keyboard={keyboardOpen ? "open" : undefined}>
    <ThemeProvider {...appearance}>
      <AppShell hideToolbar>
        <TransferWorkspace
          port={port}
          platform="ios"
          discovery={discovery}
          discoveryNotice={(discoveryUnavailable || discoveryDisabled) &&
            <div className="aerift-shell-notice aerift-ios-network">
              <p role="status">Allow Local Network access in iOS Settings to find AeRift devices nearby.</p>
              <Button variant="quiet" loading={discovering} loadingLabel="Retrying discovery…"
                onClick={() => void discover()}>Retry discovery</Button>
            </div>}
          navigationStart={<AppBrand />}
          navigationEnd={<>
            <GestureCameraIndicator status={cameraStatus} />
            <Button className="ae-control-gear" variant="quiet" aria-label="Control Center"
              aria-haspopup="dialog" title="Control Center" onClick={() => setSettingsOpen(true)}>
              <SpatialIcon name="settings" />
            </Button>
          </>}
          connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
          activityFooter={<>
            <p>Open the AeRift Received folder under On My iPhone in Files.</p>
            {historyError && <p role="alert">AeRift couldn't update saved Activity.</p>}
          </>}
          gesture={controls => <IosGestureCamera controls={controls} enabled={preferences.gestures}
            actionsBlocked={settingsOpen} retryKey={cameraRetry} onStatus={setCameraStatus} />}
          mobile={{
            archivedTransfers: history,
            offerBlockedReason: selection => clipboardSelections.current.has(selection.selectionId) && !clipboardAllowed.current
              ? "Enable clipboard sharing in Control Center to offer this file." : undefined,
            view: destination === "rift" || destination === "activity" ? destination : "supplement",
            openRift: () => navigate("rift"),
            openActivity: () => navigate("activity"),
            render: regions => <div key={destination} className="ios-page" data-destination={destination}>
              {summary.pairRequests > 0 && destination !== "devices" &&
                <Button className="ios-pair-notice" variant="quiet" onClick={() => navigate("devices")}>
                  <SpatialIcon name="pair" size={17} />Review pairing requests ({summary.pairRequests})
                </Button>}
              <div className="ios-destination-heading">
                <h2 ref={destinationHeading} tabIndex={-1}>{DESTINATIONS[destination].label}</h2>
              </div>
              {destination === "home" && <>
                <GlassSurface material="content" className="ios-overview" role="region" aria-label="Connection overview">
                  <div>
                    <h3>{summary.trustedOnline ? "Connected space" : "Your portable workspace"}</h3>
                    <p>{snapshot ? `${summary.trustedOnline} trusted online · ${summary.available} nearby` :
                      connectionFailed ? "Transfer service disconnected" : "Connecting to AeRift…"}</p>
                  </div>
                  <Button variant="quiet" onClick={() => navigate("devices")}>View devices</Button>
                </GlassSurface>
                <div className="ios-home-grid">
                  <section className="ios-section" aria-labelledby="ios-home-workspace">
                    <h3 id="ios-home-workspace">Workspace</h3>
                    <p>{regions.selection ? regions.selection.name : latestObject?.name ?? summary.received[0]?.file.name ?? "Start with a file, photo or video."}</p>
                    <Button onClick={() => navigate("workspace")}>Open Workspace</Button>
                  </section>
                  <section className="ios-section" aria-labelledby="ios-home-activity">
                    <h3 id="ios-home-activity">Activity</h3>
                    <p>{summary.active.length ? `${summary.active.length} in progress` : recentTransfers.length ? "Recent transfers" : "No transfers yet."}</p>
                    <div className="ae-activity-list">{(summary.active.length ? summary.active : recentTransfers).slice(0, 2).map(transfer =>
                      <TransferProgress key={transfer.id} transfer={transfer}
                        deviceName={snapshot?.devices.find(device => device.id === transfer.deviceId)?.name} />)}</div>
                    <Button variant="quiet" onClick={() => navigate("activity")}>View Activity</Button>
                  </section>
                </div>
                <p>{summary.trustedOnline > 0 && "Paired transfers are encrypted. "}
                  {preferences.gestures ? "Camera gestures are enabled in Rift." : "Camera gestures are off."}</p>
              </>}
              {destination === "workspace" && <>
                <MobileWorkspace regions={regions} modules={preferences}
                  pick={pick} media={library} received={summary.received} openRift={() => navigate("rift")}
                  objects={objects} save={saveObjects} clipboardSharing={canShareClipboard}
                  markClipboardSelection={id => { clipboardSelections.current.add(id); }} />
                {objectError && <p role="alert">{objectError}</p>}
              </>}
              {destination === "devices" && <div className="ios-section">
                <DeviceTrust snapshot={snapshot} port={port} />
                {regions.pairingAction}
                <p>Pair only with devices you recognize. Removing trust stops future transfers until you pair again.</p>
              </div>}
            </div>,
          }}
        />
        <MobileNavigation destination={destination} navigate={navigate}
          attention={{ devices: summary.pairRequests > 0, activity: summary.active.length > 0 }} />
      </AppShell>
      <Sheet open={settingsOpen} title="Control Center" onClose={closeSettings}>
        {settingsOpen && <div className="aerift-control-center">
          <section aria-label="Appearance and accessibility">
          <h3>Appearance and accessibility</h3>
          <SettingsPanel value={appearance} themes={[{ id: "glass", label: "GLASS" }]}
            onChange={value => {
              setAppearance(value);
              setSettingsError(!writeSettings(appearanceKey, value));
            }} />
          </section>
          <fieldset className="ae-settings">
            <legend>Workspace modules</legend>
            {WORKSPACE_MODULES.map(({ id, label }) => <label key={id}><input type="checkbox" checked={preferences[id]}
                onChange={event => updatePreferences(id, event.currentTarget.checked)} />{label}</label>)}
            <p>Clipboard is off by default. AeRift saves only text you explicitly pin.</p>
            <label><input type="checkbox" checked={preferences.clipboardShare} disabled={!preferences.clipboard}
              onChange={event => updatePreferences("clipboardShare", event.currentTarget.checked)} />
              Allow sending clipboard copies through Rift</label>
            {pins.length > 0 && (confirmClearPins ? <div className="ae-actions">
              <Button variant="danger" onClick={() => {
                if (!objects) return;
                const next = pins.reduce((items, pin) => removeMobileObject(items, pin.id), objects);
                if (saveObjects(next)) setConfirmClearPins(false);
              }}>Remove all saved pins</Button>
              <Button variant="quiet" onClick={() => setConfirmClearPins(false)}>Keep pins</Button>
            </div> : <div>
              <Button variant="quiet" onClick={() => setConfirmClearPins(true)}>Clear saved clipboard pins</Button>
            </div>)}
            {objectError && <p role="alert">{objectError}</p>}
          </fieldset>
          <fieldset className="ae-settings">
            <legend>Gesture recognition</legend>
            <label className="ae-camera-toggle">Enable camera gestures in Rift
              <input type="checkbox" checked={preferences.gestures}
                onChange={event => {
                  const enabled = event.currentTarget.checked;
                  updatePreferences("gestures", enabled);
                  if (enabled) void requestCameraAccess();
                }} />
            </label>
            <p>The front camera listens in Rift with a selected file and recipient or an incoming offer while AeRift is open in portrait. Recognition stays on this iPhone.</p>
            {preferences.gestures && <p role="status"><strong>{cameraStatus?.label ?? "Camera standby"}</strong> {cameraStatus?.detail}</p>}
            {preferences.gestures && <div>
              {cameraPermission === "denied" && <p>Allow camera access for AeRift in iOS Settings, then return to Rift.</p>}
              {cameraPermission === "restricted" && <p>Camera access is restricted on this iPhone.</p>}
              {cameraPermission === "unavailable" && <p>AeRift couldn’t check camera access. Try again while the app is open.</p>}
              {cameraPermission !== "restricted" && <Button loading={requestingCamera} loadingLabel="Checking camera access…"
                onClick={() => void requestCameraAccess()}>
                {cameraPermission === "notDetermined" || !cameraPermission ? "Request camera access" : "Retry camera"}
              </Button>}
            </div>}
          </fieldset>
          <fieldset className="ae-settings">
            <legend>Activity history</legend>
            <label><input type="checkbox" checked={preferences.rememberActivity}
              onChange={event => updatePreferences("rememberActivity", event.currentTarget.checked)} />
              Keep final transfer outcomes after restart</label>
            <p>AeRift can keep the last 60 outcomes on this iPhone, including file names.</p>
            {history.length > 0 && (confirmClearHistory ? <div className="ae-actions">
              <Button variant="danger" onClick={clearSavedActivity}>Clear saved outcomes</Button>
              <Button variant="quiet" onClick={() => setConfirmClearHistory(false)}>Keep outcomes</Button>
            </div> : <div>
              <Button variant="quiet" onClick={() => setConfirmClearHistory(true)}>Clear saved Activity</Button>
            </div>)}
            {historyError && <p role="alert">AeRift couldn't update saved Activity.</p>}
          </fieldset>
          <section aria-label="Privacy and storage">
            <p>Local Network access lets AeRift find nearby devices. Keep AeRift open until your transfer finishes.</p>
            <p>Find accepted transfers under AeRift → Received in the Files app.</p>
            <Button variant="quiet" onClick={() => { closeSettings(); navigate("devices"); }}>Manage trusted devices</Button>
          </section>
          {settingsError && <p role="alert">AeRift could not save this preference for your next session.</p>}
        </div>}
      </Sheet>
    </ThemeProvider>
  </div>;
}

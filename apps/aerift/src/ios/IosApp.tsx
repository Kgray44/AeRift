import { CompactHeaderMark, CompactHeaderStatus } from "../CompactHeader";
import { destinationIntent } from "../destination-intent";
import {
  AppShell, Button, GlassSurface, SettingsPanel, Sheet,
  SpatialIcon, ThemeProvider, TransferProgress, TransferWorkspace,
  type AppearanceSettings, type DiscoveryState, type GestureCameraStatus, type WorkspaceConnection,
} from "@aerift/ui";
import { ordinaryDevices } from "@aerift/app-contract/friends";
import type { AppPort, AppSnapshot, FileSelection } from "@aerift/app-contract";
import { createNavigationChange, DESTINATIONS, WORKSPACE_MODULES } from "@aerift/app-contract/experience";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FriendsWorkspace } from "../FriendsWorkspace";
import { DeviceTrust } from "../DeviceTrust";
import { nativeAppPort, command } from "../nativeAppPort";
import { MobileGestureCamera, mobileCameraPermission, type MobileCameraPermission } from "./IosGestureCamera";
import { MobileReceivedActivity } from "./MobileReceivedActivity";
import { MobileNavigation } from "./MobileNavigation";
import { observeMobileMedia } from "./mobile-media-observer";
import type { MobileMediaPort } from "./mobile-media";
import { MobileWorkspace, type ModuleVisibility, type PickerSource } from "./MobileWorkspace";
import { decodeMobileObjects, persistMobileObjects, readMobileObjects, removeMobileObject, type MobileObject } from "./local-objects";
import { decodeMobileHistory, isTerminalRecord, recordTransfers, withArchivedTransfers } from "./mobile-history";
import { getMobileNavigation, summarizeMobile, type MobileDestination } from "./mobile-experience";
import { mobileMotionDirection, observeMobileMotionSuppression, type MobileMotionDirection } from "./mobile-motion";
import { createMobileOperations, mobilePlatformCopy, mobileStorageKeys, type MobilePlatform } from "./mobile-platform";
import "./ios.css";

type LocalDiscoveryState = "disabled" | "starting" | "ready" | "suspended" | "unavailable";
type MobileSnapshot = AppSnapshot & { localNetwork?: LocalDiscoveryState };

const appearanceDefaults: AppearanceSettings = {
  theme: "glass", scheme: "system", contrast: "system", transparency: "system", motion: "system",
};
type MobileStorageKeys = ReturnType<typeof mobileStorageKeys>;

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

function readAppearance(keys: MobileStorageKeys): AppearanceSettings {
  const settings = readSettings(keys.appearance);
  return {
    ...appearanceDefaults,
    scheme: settings.scheme === "light" || settings.scheme === "dark" ? settings.scheme : "system",
    contrast: settings.contrast === "increase" ? "increase" : "system",
    transparency: settings.transparency === "reduce" ? "reduce" : "system",
    motion: settings.motion === "reduce" ? "reduce" : "system",
  };
}

function readWorkspace(keys: MobileStorageKeys) {
  const settings = readSettings(keys.workspace);
  return {
    files: settings.files !== false, photos: settings.photos !== false,
    notes: settings.notes !== false, browser: settings.browser !== false,
    clipboard: settings.clipboard === true, collections: settings.collections !== false,
    clipboardShare: settings.clipboardShare === true,
    rememberActivity: settings.rememberActivity === true,
    gestures: typeof settings.gestures === "boolean" ? settings.gestures :
      readSettings(keys.gestures) === true,
  };
}

function readObjects(keys: MobileStorageKeys) {
  try {
    return readMobileObjects(localStorage, keys);
  } catch {
    return undefined;
  }
}

function readHistory(keys: MobileStorageKeys) {
  try {
    return decodeMobileHistory(localStorage.getItem(keys.history) ?? "[]");
  } catch {
    return [];
  }
}

type MobileAppOverrides = {
  port?: AppPort;
  media?: MobileMediaPort;
  pick?: (source: PickerSource) => ReturnType<AppPort["selectFile"]>;
};

export function IosApp(overrides: MobileAppOverrides = {}) {
  return <MobileApp platform="ios" {...overrides} />;
}

export function AndroidApp(overrides: MobileAppOverrides = {}) {
  return <MobileApp platform="android" {...overrides} />;
}

function MobileApp({ platform, port = nativeAppPort, media, pick }: MobileAppOverrides & { platform: MobilePlatform }) {
  const operations = useMemo(() => createMobileOperations(platform, command), [platform]);
  const keys = useMemo(() => mobileStorageKeys(platform), [platform]);
  const copy = mobilePlatformCopy[platform];
  const library = useMemo(() => observeMobileMedia(media ?? operations.media), [media, operations]);
  const [connection, setConnection] = useState<WorkspaceConnection>({ state: "connecting" });
  const [watchAttempt, setWatchAttempt] = useState(0);
  const snapshot: MobileSnapshot | undefined = connection.state === "ready" ? connection.snapshot : undefined;
  const [appearance, setAppearance] = useState(() => readAppearance(keys));
  const [preferences, setPreferences] = useState(() => readWorkspace(keys));
  const canShareClipboard = preferences.clipboard && preferences.clipboardShare;
  const clipboardAllowed = useRef(canShareClipboard);
  const clipboardSelections = useRef(new Set<string>());
  const [objects, setObjects] = useState(() => readObjects(keys));
  const [objectError, setObjectError] = useState("");
  const [history, setHistory] = useState(() => readHistory(keys));
  const [historyError, setHistoryError] = useState(false);
  const [savedReceipts, setSavedReceipts] = useState(false);
  const [receiptRevision, setReceiptRevision] = useState(0);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const receiptOperation = useRef(false);
  const receiptReady = connection.state === "ready";
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const clearedReceipts = useRef(new Set<string>());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClearPins, setConfirmClearPins] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [route, setRoute] = useState<{ destination: MobileDestination; motion?: MobileMotionDirection }>({ destination: "home" });
  const friendsAvailable = snapshot?.friends?.version === 1 && !!port.friends;
  const navigation = useMemo(() => getMobileNavigation(friendsAvailable), [friendsAvailable]);
  const destinations = navigation.primary.map(({ id }) => id).filter((id): id is MobileDestination => id !== "settings");
  const destination = route.destination === "friends" && !friendsAvailable ? "home" : route.destination;
  useEffect(() => {
    if (!friendsAvailable) setRoute(current => current.destination === "friends" ? { destination: "home" } : current);
  }, [friendsAvailable]);
  const [discoveryError, setDiscoveryError] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<GestureCameraStatus>();
  const [cameraRetry, setCameraRetry] = useState(0);
  const [cameraPermission, setCameraPermission] = useState<MobileCameraPermission>();
  const [requestingCamera, setRequestingCamera] = useState(false);
  const cameraPermissionRequest = useRef(0);
  const cameraPermissionPending = useRef(false);
  const [discovering, setDiscovering] = useState(false);
  const destinationHeading = useRef<HTMLHeadingElement>(null);
  const lastPlacedRoute = useRef(route);
  const lastFocusedRoute = useRef<MobileDestination>(destination);
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
    const saved = writeSettings(keys.history, next);
    setHistoryError(!saved);
    if (saved) setHistory(next);
  }, [history, keys.history, liveTransfers, preferences.rememberActivity]);

  async function syncNativeReceipts(enabled: boolean, clear = false) {
    if (!operations.configureReceiptHistory) return true;
    if (receiptOperation.current || !receiptReady) return false;
    receiptOperation.current = true;
    setReceiptBusy(true);
    if (clear || !enabled) setSavedReceipts(false);
    try {
      if (!(await operations.configureReceiptHistory(enabled, clear)).ok) {
        setHistoryError(true);
        return false;
      }
      setSavedReceipts(enabled);
      setReceiptRevision(value => value + 1);
      return true;
    } catch {
      setHistoryError(true);
      return false;
    } finally {
      receiptOperation.current = false;
      setReceiptBusy(false);
    }
  }

  useEffect(() => {
    // Hydrate the native store only under the already-consented preference.
    if (receiptReady && preferences.rememberActivity && operations.configureReceiptHistory)
      void syncNativeReceipts(true);
  }, [receiptReady, operations]);

  async function setRememberActivity(enabled: boolean) {
    if (await syncNativeReceipts(enabled)) updatePreferences("rememberActivity", enabled);
  }

  async function clearSavedActivity() {
    if (!(await syncNativeReceipts(preferences.rememberActivity, true))) return;
    if (!writeSettings(keys.history, [])) {
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

  useLayoutEffect(() => { lastPlacedRoute.current = route; }, [route]);

  const clearRouteMotion = (placed: typeof route) =>
    setRoute(current => current === placed && current.motion ? { destination: current.destination } : current);
  useEffect(() => {
    if (route.motion) return observeMobileMotionSuppression(appearance.motion === "reduce", () => clearRouteMotion(route));
  }, [route, appearance.motion]);

  useEffect(() => {
    if (settingsOpen || lastFocusedRoute.current === destination) return;
    lastFocusedRoute.current = destination;
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
    const placed = lastPlacedRoute.current;
    const from = placed.destination;
    setRoute(current => {
      const change = createNavigationChange(navigation, current.destination, next, "user");
      if (!change || change.to === "settings") return current;
      if (from === change.to) return placed;
      return { destination: change.to, motion: mobileMotionDirection(destinations, from, change.to) };
    });
  }

  function retryConnection() {
    setDiscoveryError(false);
    setWatchAttempt(attempt => attempt + 1);
  }

  async function discover() {
    setDiscovering(true);
    setDiscoveryError(false);
    const result = await operations.retryDiscovery();
    setDiscoveryError(!result.ok);
    setDiscovering(false);
  }

  useEffect(() => {
    if (!settingsOpen) return;
    let active = true;
    const refresh = async () => {
      if (cameraPermissionPending.current) return;
      const request = ++cameraPermissionRequest.current;
      const status = await mobileCameraPermission(platform);
      if (active && request === cameraPermissionRequest.current) setCameraPermission(status);
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [platform, settingsOpen]);

  async function requestCameraAccess() {
    if (cameraPermissionPending.current) return;
    cameraPermissionPending.current = true;
    cameraPermissionRequest.current++;
    setRequestingCamera(true);
    try {
      const status = await mobileCameraPermission(platform, true);
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
    setSettingsError(!writeSettings(keys.workspace, next));
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
      persistMobileObjects(localStorage, objects, next, keys);
      setObjects([...next]);
      return true;
    } catch {
      setObjectError("AeRift couldn't save this change. Your earlier saved items are still available.");
      return false;
    }
  }

  return <div className="aerift-ios" data-mobile-platform={platform} data-keyboard={keyboardOpen ? "open" : undefined} data-ios-route-motion={route.motion}>
    <ThemeProvider {...appearance}>
      <AppShell hideToolbar>
        <TransferWorkspace
          port={port}
          platform={platform}
          discovery={discovery}
          discoveryNotice={(discoveryUnavailable || discoveryDisabled) &&
            <div className="aerift-shell-notice aerift-ios-network">
              <p role="status">{copy.discoveryMessage}</p>
              <Button variant="quiet" loading={discovering} loadingLabel="Retrying discovery…"
                onClick={() => void discover()}>Retry discovery</Button>
            </div>}
          shellHeader={<header className="ae-experience-nav ae-compact-header" data-mobile-shell="true">
            <CompactHeaderMark />
            <CompactHeaderStatus camera={cameraStatus} enabled={preferences.gestures}
              connections={snapshot ? ordinaryDevices(snapshot.devices, snapshot.friends).filter(device => device.paired && device.online).length : undefined} service={connection.state} />
          </header>}
          connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
          activityLibrary={<MobileReceivedActivity transfers={recentTransfers} liveTransfers={liveTransfers ?? []} operations={operations}
            receivedTip={copy.receivedTip} savedReceipts={savedReceipts && preferences.rememberActivity} receiptRevision={receiptRevision} />}
          activityFooter={historyError && <p role="alert">AeRift couldn't update saved Activity.</p>}
          gesture={controls => <MobileGestureCamera platform={platform} controls={controls} enabled={preferences.gestures}
            actionsBlocked={settingsOpen} retryKey={cameraRetry} onStatus={setCameraStatus} />}
          mobile={{
            archivedTransfers: history,
            offerBlockedReason: selection => clipboardSelections.current.has(selection.selectionId) && !clipboardAllowed.current
              ? "Enable clipboard sharing in Control Center to offer this file." : undefined,
            view: destination === "rift" || destination === "activity" ? destination : "supplement",
            openRift: () => navigate("rift"),
            openActivity: () => navigate("activity"),
            render: regions => <div key={destination} className="ios-page" data-destination={destination} data-ae-route-enter={route.motion}
              onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName.startsWith("ae-route-")) clearRouteMotion(route); }}>
              {summary.pairRequests > 0 && destination !== "devices" &&
                <Button className="ios-pair-notice" variant="quiet" onClick={() => navigate("devices")}>
                  <SpatialIcon name="pair" size={17} />Review pairing requests ({summary.pairRequests})
                </Button>}
              <div className="ios-destination-heading">
                <h2 ref={destinationHeading} tabIndex={-1}>{DESTINATIONS[destination].label}</h2>
                {destinationIntent[destination] && <p className="ae-destination-intent">{destinationIntent[destination]}</p>}
              </div>
              {destination === "home" && <>
                <GlassSurface material="content" className="ios-overview" data-ae-lens-role="control" role="region" aria-label="Connection overview">
                  <span className="ios-overview-symbol" aria-hidden="true"><SpatialIcon name="desktop" size={21} /></span>
                  <div className="ios-overview-copy">
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
                    <Button data-ae-lens-role="control" onClick={() => navigate("workspace")}>Open Workspace</Button>
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
                <p className="ios-footnote">{summary.trustedOnline > 0 && "Paired transfers are encrypted. "}
                  {preferences.gestures ? "Camera gestures are enabled in Rift." : "Camera gestures are off."}</p>
              </>}
              {destination === "workspace" && <>
                <MobileWorkspace regions={regions} modules={preferences} reducedMotion={appearance.motion === "reduce"}
                  pick={pick ?? operations.pick} media={library} operations={operations} copy={copy} received={summary.received} openRift={() => navigate("rift")}
                  objects={objects} save={saveObjects} clipboardSharing={canShareClipboard}
                  markClipboardSelection={id => { clipboardSelections.current.add(id); }} />
                {objectError && <p role="alert">{objectError}</p>}
              </>}
              {destination === "friends" && snapshot?.friends?.version === 1 && port.friends &&
                <FriendsWorkspace snapshot={snapshot.friends} port={port.friends} mobile />}
              {destination === "devices" && <DeviceTrust snapshot={snapshot} port={port} actions={regions.pairingAction} />}
            </div>,
          }}
        />
        <MobileNavigation destinations={destinations} destination={destination} navigate={navigate}
          settingsOpen={settingsOpen} openSettings={() => setSettingsOpen(true)}
          attention={{ devices: summary.pairRequests > 0, activity: summary.active.length > 0 }} />
      </AppShell>
      <Sheet open={settingsOpen} title="Control Center" onClose={closeSettings}>
        {settingsOpen && <div className="aerift-control-center">
          <section aria-label="Appearance and accessibility">
          <h3>Appearance and accessibility</h3>
          <SettingsPanel value={appearance} themes={[{ id: "glass", label: "GLASS" }]}
            onChange={value => {
              setAppearance(value);
              setSettingsError(!writeSettings(keys.appearance, value));
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
            <p>The front camera listens in Rift with a selected file and recipient or an incoming offer while AeRift is open in portrait. Recognition stays on {copy.device}.</p>
            {preferences.gestures && <p role="status"><strong>{cameraStatus?.label ?? "Camera standby"}</strong> {cameraStatus?.detail}</p>}
            {preferences.gestures && <div>
              {cameraPermission === "denied" && <p>{copy.cameraDenied}</p>}
              {cameraPermission === "restricted" && <p>Camera access is restricted on {copy.device}.</p>}
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
              disabled={receiptBusy || (!!operations.configureReceiptHistory && !receiptReady)}
              onChange={event => void setRememberActivity(event.currentTarget.checked)} />
              Keep final transfer outcomes after restart</label>
            <p>AeRift can keep the last 60 outcomes on {copy.device}, including file names.</p>
            {(history.length > 0 || (savedReceipts && preferences.rememberActivity)) && (confirmClearHistory ? <div className="ae-actions">
              <Button variant="danger" disabled={receiptBusy} onClick={() => void clearSavedActivity()}>Clear saved outcomes</Button>
              <Button variant="quiet" onClick={() => setConfirmClearHistory(false)}>Keep outcomes</Button>
            </div> : <div>
              <Button variant="quiet" onClick={() => setConfirmClearHistory(true)}>Clear saved Activity</Button>
            </div>)}
            {historyError && <p role="alert">AeRift couldn't update saved Activity.</p>}
          </fieldset>
          <section aria-label="Privacy and storage">
            <p>Local network access lets AeRift find nearby devices. Keep AeRift open until your transfer finishes.</p>
            <p>Received files: {copy.receivedFolder}.</p>
            <Button variant="quiet" onClick={() => { closeSettings(); navigate("devices"); }}>Manage trusted devices</Button>
          </section>
          {settingsError && <p role="alert">AeRift could not save this preference for your next session.</p>}
        </div>}
      </Sheet>
    </ThemeProvider>
  </div>;
}


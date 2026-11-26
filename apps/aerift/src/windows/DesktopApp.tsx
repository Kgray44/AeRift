import { CompactHeaderMark, CompactHeaderStatus } from "../CompactHeader";
import { DesktopInbox } from "./DesktopInbox";
import { destinationIntent } from "../destination-intent";
import { Channel } from "@tauri-apps/api/core";
import type { FileSelection } from "@aerift/app-contract";
import { DESTINATIONS, getNavigation, type DestinationId } from "@aerift/app-contract/experience";
import {
  AppShell, Button, GlassSurface, Orbit, OrbitSurface,
  SpatialIcon, ThemeProvider, TransferWorkspace, type GestureCameraStatus, type WorkspaceConnection,
} from "@aerift/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { FriendsWorkspace } from "../FriendsWorkspace";
import { WindowsFriendsSetup, setupPort, type SetupView } from "./WindowsFriendsSetup";
import { ordinaryDevices, type FriendsSnapshot } from "@aerift/app-contract/friends";
import { WindowsFriendsFiles } from "./WindowsFriendsFiles";
import { WindowsFriendsMember } from "./WindowsFriendsMember";
import { DeviceTrust } from "../DeviceTrust";
import { command, nativeAppPort } from "../nativeAppPort";
import { DesktopHome } from "./DesktopHome";
import { DesktopSettings } from "./DesktopSettings";
import { DesktopWorkspace } from "./DesktopWorkspace";
import { GestureCamera } from "./GestureCamera";
import { useDesktopContentEnter } from "./desktopContentMotion";
import { desktopSettings, watchFileSelection, type ReceiveFolder } from "./nativeAppPort";
import { ambientExcludedApps, readDesktopPreferences, settingsKey, type DesktopPreferences } from "./preferences";
import "./desktop.css";

export type AmbientCaptureView =
  | { state: "idle" | "working" | "paused" }
  | { state: "unavailable"; reason: string }
  | { state: "frozen"; id: string; canSendFile: boolean; entries: { kind: string; title: string; size: number }[] };

export function DesktopApp() {
  const [connection, setConnection] = useState<WorkspaceConnection>({ state: "connecting" });
  const [watchAttempt, setWatchAttempt] = useState(0);
  const [friendsView, setFriendsView] = useState<SetupView>();
  const friends: FriendsSnapshot | undefined = friendsView ? {
    version: 1, contacts: friendsView.contacts, offers: [], invitations: [], supportedObjects: [],
  } : undefined;
  const snapshot = connection.state === "ready" ? {
    ...connection.snapshot,
    devices: ordinaryDevices(connection.snapshot.devices, friends),
    friends,
  } : undefined;
  const refreshFriends = useCallback(() => {
    void command<SetupView>("friends_setup_view").then(answer => setFriendsView(answer.ok ? answer.value : undefined));
  }, []);
  useEffect(() => {
    if (connection.state === "ready") refreshFriends();
  }, [connection.state, refreshFriends]);
  const [settings, setSettings] = useState(readDesktopPreferences);
  const [keepWorkspaceMounted, setKeepWorkspaceMounted] = useState(settings.experience.windowMode === "full");
  const [dropError, setDropError] = useState<string>();
  const [folder, setFolder] = useState<ReceiveFolder>();
  const [folderError, setFolderError] = useState(false);
  const [openingFolderPicker, setOpeningFolderPicker] = useState(false);
  const [ambientAvailable, setAmbientAvailable] = useState(false);
  const [shortcutError, setShortcutError] = useState(false);
  const [ambientError, setAmbientError] = useState(false);
  const [ambientCaptureError, setAmbientCaptureError] = useState(false);
  const [ambientCapture, setAmbientCapture] = useState<AmbientCaptureView>();
  const [ambientSendError, setAmbientSendError] = useState(false);
  const [ambientSending, setAmbientSending] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<GestureCameraStatus>();
  const [cameraRetry, setCameraRetry] = useState(0);
  const [pairRequest, setPairRequest] = useState(0);
  const cameraActive = cameraStatus?.state === "listening" || cameraStatus?.state === "held" || cameraStatus?.state === "detected";
  const seenOffers = useRef(new Set<string>());
  const surfaceRef = useRef<HTMLElement>(null);
  const navigation = getNavigation("desktop", settings.experience, {
    ambient: ambientAvailable ? "available" : "unsupported", camera: "unknown",
    friends: friendsView !== undefined ? "available" : "unsupported",
  });
  const route = navigation.primary.some(item => item.id === settings.route) ? settings.route : "home";
  useDesktopContentEnter(route, surfaceRef, "orbit");
  useEffect(() => {
    if (route !== "friends") return;
    const timer = window.setInterval(refreshFriends, 1500);
    return () => window.clearInterval(timer);
  }, [route, refreshFriends]);

  useEffect(() => {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({ ...settings, appearance: settings.experience,
        gesturesEnabled: settings.gestures, cameraDeviceId: settings.cameraId }));
    } catch {
      // These preferences can still apply for this session.
    }
  }, [settings]);

  useEffect(() => {
    if (connection.state !== "ready") return;
    let disposed = false;
    void desktopSettings.folder().then(result => {
      if (!disposed && result.ok) setFolder(result.value);
    });
    return () => { disposed = true; };
  }, [connection.state]);

  const navigate = useCallback((destination: DestinationId) => {
    setSettings(current => current.route === destination ? current : { ...current, route: destination });
  }, []);

  useEffect(() => {
    const channel = new Channel<"rift" | "activity">(navigate);
    let disposed = false;
    void command<boolean>("watch_desktop_ambient", { route: channel }).then(result => {
      if (!disposed) setAmbientAvailable(result.ok && result.value);
    });
    return () => {
      disposed = true;
      channel.onmessage = () => {};
    };
  }, [navigate]);

  useEffect(() => {
    if (!ambientAvailable) return;
    let disposed = false;
    void command<void>("set_desktop_ambient", { enabled: navigation.ambient }).then(result => {
      if (!disposed) setAmbientError(!result.ok);
    });
    return () => { disposed = true; };
  }, [ambientAvailable, navigation.ambient]);

  useEffect(() => {
    if (!ambientAvailable) return;
    let disposed = false;
    void command<void>("set_desktop_shortcut", {
      choice: navigation.ambient ? settings.ambientShortcut : "off",
    }).then(result => {
      if (!disposed) setShortcutError(!result.ok);
    });
    return () => { disposed = true; };
  }, [ambientAvailable, navigation.ambient, settings.ambientShortcut]);

  const captureEnabled = navigation.ambient && settings.ambientContextEnabled;
  useEffect(() => {
    if (!ambientAvailable) return;
    const updates = new Channel<AmbientCaptureView>(setAmbientCapture);
    void command<void>("watch_ambient_capture", { updates });
    return () => { updates.onmessage = () => {}; };
  }, [ambientAvailable]);

  useEffect(() => {
    if (!ambientAvailable) return;
    let disposed = false;
    const excludedApps = ambientExcludedApps(settings.ambientExclusions);
    const valid = excludedApps.length <= 64 && excludedApps.every(app => /^[a-z0-9._-]{1,124}\.exe$/.test(app));
    // A malformed exclusion is fail-closed, not dropped from the configured list.
    void command<void>("set_ambient_capture", { enabled: captureEnabled && valid, excludedApps: valid ? excludedApps : [] }).then(result => {
      if (!disposed) setAmbientCaptureError(!result.ok || !valid);
    });
    return () => { disposed = true; };
  }, [ambientAvailable, captureEnabled, settings.ambientExclusions]);

  const nearbyCaptureTargets = snapshot?.devices.filter(device => device.paired && device.online) ?? [];
  async function offerAmbientCapture(captureId: string, deviceId: string) {
    if (ambientSending || !captureEnabled || !nearbyCaptureTargets.some(device => device.id === deviceId)) return;
    setAmbientSendError(false);
    setAmbientSending(true);
    try {
      const result = await command("send_ambient_file", { captureId, deviceId });
      if (result.ok) navigate("activity");
      else setAmbientSendError(true);
    } finally {
      setAmbientSending(false);
    }
  }

  const connected = snapshot?.devices.filter(device => device.online && device.paired).length;
  const pendingOffers = snapshot?.transfers.filter(transfer => transfer.direction === "incoming" && transfer.state === "pending").length ?? 0;
  const pendingPairs = snapshot?.pendingPairing.length ?? 0;
  const activeTransfers = snapshot?.transfers.filter(transfer =>
    transfer.state === "pending" || transfer.state === "accepted" || transfer.state === "transferring").length ?? 0;

  useEffect(() => {
    if (!navigation.ambient) return;
    void command<void>("update_desktop_ambient", {
      connected: connected ?? null,
      transfers: activeTransfers,
      gesture: cameraActive ? "active" : settings.gestures ? "enabled" : "off",
      previewCorner: settings.ambientPreviewCorner,
    });
  }, [navigation.ambient, connected, activeTransfers, cameraActive, settings.gestures, settings.ambientPreviewCorner]);

  useEffect(() => {
    if (!snapshot) return;
    const incoming = snapshot.transfers.filter(transfer => transfer.direction === "incoming" && transfer.state === "pending");
    const fresh = incoming.filter(transfer => !seenOffers.current.has(transfer.id));
    seenOffers.current = new Set(incoming.map(transfer => transfer.id));
    if (navigation.ambient && settings.ambientNotifications && fresh.length) {
      void command<void>("notify_desktop_incoming", { count: fresh.length });
    }
  }, [navigation.ambient, settings.ambientNotifications, snapshot]);

  const watchSelection = useCallback((listener: (file: FileSelection | null) => void) =>
    watchFileSelection(update => {
      if (update.kind === "changed") {
        listener(update.selection);
        setDropError(undefined);
        if (update.selection) navigate("rift");
      } else {
        setDropError(update.error.code === "invalid_request" ? "Drop one regular file." :
          update.error.code === "storage_failed" ? "AeRift could not read that file." :
          "AeRift could not update the file selection.");
      }
    }), [navigate]);

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

  const pairedOnline = snapshot?.devices.some(device => device.online && device.paired);
  const transferView = route === "rift" || route === "activity" ? route : "hidden";

  return <ThemeProvider {...settings.experience}>
    <AppShell hideToolbar>
      <header className="ae-experience-nav aerift-desktop-header ae-compact-header" data-destination={route}>
        <Orbit destinations={navigation.primary} active={route} onNavigate={navigate} surfaceRef={surfaceRef}
          presentation={navigation.presentation === "conventional" ? "conventional" : "orbit"}
          shortcut={settings.orbitShortcut} reducedMotion={settings.experience.motion === "reduce"}
          status={activeTransfers ? { activity: `${activeTransfers} active` } : undefined} />
        <CompactHeaderMark />
        <CompactHeaderStatus camera={cameraStatus} enabled={settings.gestures} connections={connected} service={connection.state} />
      </header>
      {(pendingOffers > 0 || pendingPairs > 0) && <div className="ae-offer-notice" role="status">
        {pendingOffers > 0 && <Button variant="quiet" onClick={() => navigate("activity")}>Incoming offers ({pendingOffers})</Button>}
        {pendingPairs > 0 && <Button variant="quiet" onClick={() => navigate("devices")}>Pairing requests ({pendingPairs})</Button>}
      </div>}
      <OrbitSurface className="aerift-desktop-surface" data-destination={route} ref={surfaceRef}
        aria-labelledby="aerift-desktop-destination">
        <div className="aerift-destination-heading">
          <div><h2 id="aerift-desktop-destination" data-orbit-focus tabIndex={-1}>{DESTINATIONS[route].label}</h2>
            {destinationIntent[route] && <p className="ae-destination-intent">{destinationIntent[route]}</p>}</div>
          {route === "rift" && <div className="ae-actions">
            {!pairedOnline && <Button variant="quiet" aria-label="Find devices" title="Find devices" onClick={() => navigate("devices")}><SpatialIcon name="devices" /></Button>}
            <Button variant="quiet" aria-label="Transfer activity" title="Transfer activity" onClick={() => navigate("activity")}><SpatialIcon name="activity" /></Button>
          </div>}
        </div>
        {dropError && <p role="alert">{dropError}</p>}
        {route === "home" && <DesktopHome connection={connection} gestures={settings.gestures} onNavigate={navigate} />}
        {route === "devices" && <DeviceTrust snapshot={snapshot} compactActions actions={<>
            <Button disabled={!snapshot} onClick={() => setPairRequest(request => request + 1)}>
              <SpatialIcon name="pair" size={17} />{pendingPairs ? `Review pairing (${pendingPairs})` : "Pair a device"}
            </Button>
            {connection.state === "disconnected" && <Button variant="quiet" aria-label="Retry connection" title="Retry connection" onClick={retryConnection}><SpatialIcon name="retry" /></Button>}
        </>} />}
        {route === "friends" && (friendsView && friends ?
          <FriendsWorkspace snapshot={friends} port={setupPort}
            setup={<WindowsFriendsSetup view={friendsView} refresh={refreshFriends} />}
            desktop={{
              pendingInvitation: !!friendsView.pendingRecipient,
              transfer: preferredContact => <WindowsFriendsFiles contacts={friends.contacts} preferredContact={preferredContact} />,
              enrollment: <WindowsFriendsMember contacts={friends.contacts} />,
            }} /> : <p role="status">Friends is unavailable. Reopen AeRift and try again.</p>)}
        {route === "settings" && <DesktopSettings value={settings} onChange={(next: DesktopPreferences) => {
          if (next.experience.windowMode === "full") setKeepWorkspaceMounted(true);
          setSettings(next);
        }}
          folder={folder} folderError={folderError} openingFolderPicker={openingFolderPicker}
          chooseFolder={() => void selectDestination()} ambientAvailable={ambientAvailable} ambientError={ambientError}
          shortcutError={shortcutError} ambientCapture={captureEnabled ? ambientCapture : undefined}
          ambientCaptureError={ambientCaptureError} ambientSendError={ambientSendError}
          ambientSending={ambientSending} ambientTargets={nearbyCaptureTargets} offerAmbientCapture={offerAmbientCapture} cameraStatus={cameraStatus} retryCamera={() => setCameraRetry(value => value + 1)} />}
        {keepWorkspaceMounted &&
          <div hidden={route !== "workspace"}>
            <DesktopWorkspace preferences={settings.experience} clipboardAllowed={settings.clipboard} active={route === "workspace"} />
          </div>}
        <TransferWorkspace
          port={nativeAppPort}
          desktopView={transferView}
          friendsRoster={friends}
          onOpenRift={() => navigate("rift")}
          pairRequest={pairRequest}
          platform="windows"
          allowDrop
          watchSelection={watchSelection}
          connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
          allowInbox
          activityLibrary={<DesktopInbox contextualEnabled={captureEnabled} />}
          activityFooter={route === "activity" && folder?.active && <p>The regular receive folder is {folder.active}.</p>}
          gesture={controls => <GestureCamera controls={controls} shortcut={settings.cameraShortcut}
            enabled={settings.gestures} actionsBlocked={route !== "rift"} source={settings.cameraId || undefined}
            retryKey={cameraRetry} onStatus={setCameraStatus} />}
        />
      </OrbitSurface>
    </AppShell>
  </ThemeProvider>;
}


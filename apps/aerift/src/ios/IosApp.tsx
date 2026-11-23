import {
  AppShell, Button, ConnectionStatus, SettingsPanel, Sheet, ThemeProvider,
  TransferProgress, TransferWorkspace, type AppearanceSettings, type WorkspaceConnection,
} from "@aerift/ui";
import type { AppPort, AppSnapshot, FileSelection } from "@aerift/app-contract";
import { createNavigationChange, DESTINATIONS, WORKSPACE_MODULES } from "@aerift/app-contract/experience";
import { useLayoutEffect, useRef, useState } from "react";
import { DeviceTrust } from "../DeviceTrust";
import { nativeAppPort, command } from "../nativeAppPort";
import { IosGestureCamera } from "./IosGestureCamera";
import { MobileNavigation } from "./MobileNavigation";
import { MobileWorkspace, type ModuleVisibility, type PickerSource } from "./MobileWorkspace";
import { localModules } from "./LocalObjectWorkspace";
import { decodeMobileObjects, objectStorageKey, type MobileObject } from "./local-objects";
import { mobileNavigation, summarizeMobile, type MobileDestination } from "./mobile-experience";
import "./ios.css";

type DiscoveryState = "disabled" | "starting" | "ready" | "suspended" | "unavailable";
type IosSnapshot = AppSnapshot & { localNetwork?: DiscoveryState };

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
    gestures: settings.gestures === true,
  };
}

function readObjects() {
  try {
    return decodeMobileObjects(localStorage.getItem(objectStorageKey) ?? "[]");
  } catch {
    return undefined;
  }
}

const pickNative = (source: PickerSource) => command<FileSelection | null>("select_app_file", { source });

export function IosApp({ port = nativeAppPort, pick = pickNative }: {
  port?: AppPort;
  pick?: (source: PickerSource) => ReturnType<AppPort["selectFile"]>;
} = {}) {
  const [connection, setConnection] = useState<WorkspaceConnection>({ state: "connecting" });
  const [watchAttempt, setWatchAttempt] = useState(0);
  const snapshot: IosSnapshot | undefined = connection.state === "ready" ? connection.snapshot : undefined;
  const [appearance, setAppearance] = useState(readAppearance);
  const [preferences, setPreferences] = useState(readWorkspace);
  const [objects, setObjects] = useState(readObjects);
  const [objectError, setObjectError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [destination, setDestination] = useState<MobileDestination>("home");
  const [discoveryError, setDiscoveryError] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const destinationHeading = useRef<HTMLHeadingElement>(null);
  const navigationRequested = useRef(false);
  const summary = summarizeMobile(snapshot);
  const discoveryUnavailable = discoveryError || snapshot?.localNetwork === "unavailable";
  const connectionFailed = connection.state === "disconnected";
  const searching = !connectionFailed && !discoveryUnavailable;

  useLayoutEffect(() => {
    if (!navigationRequested.current) return;
    destinationHeading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [destination]);

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

  function updatePreferences(key: keyof ModuleVisibility | "gestures", checked: boolean) {
    const next = { ...preferences, [key]: checked };
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
      localStorage.setItem(objectStorageKey, serialized);
      setObjects([...next]);
      return true;
    } catch {
      setObjectError("AeRift couldn't save this change. Your earlier saved items are still available.");
      return false;
    }
  }

  return <div className="aerift-ios">
    <ThemeProvider {...appearance}>
      <AppShell brand={<h1 className="aerift-title">AeRift</h1>} toolbar={
        <>
          <ConnectionStatus state={summary.trustedOnline ? "connected" : searching ? "searching" : "offline"}
            label={summary.trustedOnline ? "Connected" : !searching ? "Offline" : snapshot ? "Searching" : "Connecting"} />
          <Button variant="quiet" onClick={() => setSettingsOpen(true)}>Settings</Button>
        </>
      }>
        {connectionFailed && <div className="aerift-ios-network">
          <p role="status">AeRift lost its connection to the local transfer service.</p>
          <Button onClick={retryConnection}>Retry connection</Button>
        </div>}
        {discoveryUnavailable && <div className="aerift-ios-network">
          <p role="status">Check Local Network access in iPhone Settings to find nearby devices.</p>
          <Button loading={discovering} onClick={() => void discover()}>Retry discovery</Button>
        </div>}
        <div className="ios-alerts">
          {summary.incomingOffers > 0 && destination !== "activity" &&
            <Button onClick={() => navigate("activity")}>
              Review {summary.incomingOffers === 1 ? "incoming transfer" : "incoming transfers"} ({summary.incomingOffers})
            </Button>}
          {summary.pairRequests > 0 && destination !== "devices" &&
            <Button onClick={() => navigate("devices")}>Review pairing requests ({summary.pairRequests})</Button>}
        </div>
        <div className="ios-destination-heading">
          <h2 ref={destinationHeading} tabIndex={-1}>{DESTINATIONS[destination].label}</h2>
          {destination === "rift" && <p>Send an item to a paired device on your local network.</p>}
        </div>
        <TransferWorkspace
          port={port}
          connection={{ generation: watchAttempt, retry: retryConnection, onChange: setConnection }}
          activityFooter={<p>Delivered files are available in Files → On My iPhone → AeRift → Received.</p>}
          gesture={preferences.gestures && !settingsOpen ? controls => <IosGestureCamera controls={controls} enabled /> : undefined}
          layout={regions => <div key={destination} className="ios-page" data-destination={destination}>
            {destination === "home" && <>
              <section className="ios-overview" aria-label="Connection overview">
                <div>
                  <h3>{summary.trustedOnline ? "Connected space" : "Your portable workspace"}</h3>
                  <p>{snapshot ? `${summary.trustedOnline} trusted online · ${summary.available} nearby` :
                    connectionFailed ? "Transfer service disconnected" : "Connecting to AeRift…"}</p>
                </div>
                <Button variant="quiet" onClick={() => navigate("devices")}>View devices</Button>
              </section>
              <div className="ios-home-grid">
                <section className="ios-section" aria-labelledby="ios-home-workspace">
                  <h3 id="ios-home-workspace">Workspace</h3>
                  <p>{regions.selection ? regions.selection.name : objects?.[0]?.name ?? summary.received[0]?.file.name ?? "Start with a file, photo or video."}</p>
                  <Button onClick={() => navigate("workspace")}>Open Workspace</Button>
                </section>
                <section className="ios-section" aria-labelledby="ios-home-activity">
                  <h3 id="ios-home-activity">Activity</h3>
                  <p>{summary.active.length ? `${summary.active.length} in progress` : snapshot?.transfers.length ? "Recent transfers" : "No transfers yet."}</p>
                  {(summary.active.length ? summary.active : snapshot?.transfers)?.slice(0, 2).map(transfer =>
                    <TransferProgress key={transfer.id} transfer={transfer} />)}
                  <Button variant="quiet" onClick={() => navigate("activity")}>View Activity</Button>
                </section>
              </div>
              <p>{summary.trustedOnline > 0 && "Paired transfers are encrypted. "}
                {preferences.gestures ? "Camera gestures are available in Rift with a file and a device selected." : "Camera gestures are off."}</p>
            </>}
            {destination === "workspace" && <>
              <MobileWorkspace regions={regions} modules={preferences}
                pick={pick} received={summary.received} openRift={() => navigate("rift")}
                objects={objects} save={saveObjects} />
              {objectError && <p role="alert">{objectError}</p>}
            </>}
            {destination === "rift" && regions.composer}
            {destination === "devices" && <div className="ios-section">
              <DeviceTrust snapshot={snapshot} port={port} />
              {regions.pairingAction}
              <p>Pair only with devices you recognize. Removing trust stops future transfers until you pair again.</p>
            </div>}
            {destination === "activity" && regions.activity}
          </div>}
        />
        <MobileNavigation destination={destination} navigate={navigate}
          attention={{ devices: summary.pairRequests > 0, activity: summary.incomingOffers > 0 }} />
      </AppShell>
      <Sheet open={settingsOpen} title="Settings" onClose={() => setSettingsOpen(false)}>
        <SettingsPanel value={appearance} themes={[{ id: "glass", label: "GLASS" }]}
          onChange={value => {
            setAppearance(value);
            setSettingsError(!writeSettings(appearanceKey, value));
          }} />
        <fieldset className="ae-settings">
          <legend>Workspace modules</legend>
          {WORKSPACE_MODULES.filter(({ id }) => id === "files" || id === "photos" || localModules.includes(id as typeof localModules[number]))
            .map(({ id, label }) => <label key={id}><input type="checkbox" checked={preferences[id]}
              onChange={event => updatePreferences(id, event.currentTarget.checked)} />{label}</label>)}
          <p>Clipboard is off by default. Pinned text stays on this iPhone until you remove it or send a copy.</p>
        </fieldset>
        <fieldset className="ae-settings">
          <legend>Gesture recognition</legend>
          <label><input type="checkbox" checked={preferences.gestures}
            onChange={event => updatePreferences("gestures", event.currentTarget.checked)} />Enable camera gestures in Rift</label>
          <p>The camera starts only when you begin an attempt in Rift. Recognition runs on this iPhone.</p>
        </fieldset>
        <section aria-label="Privacy and storage">
          <p>Local Network access lets AeRift find nearby devices. Keep AeRift open until your transfer finishes.</p>
          <p>Find accepted transfers under AeRift → Received in the Files app.</p>
          <Button variant="quiet" onClick={() => { setSettingsOpen(false); navigate("devices"); }}>Manage trusted devices</Button>
        </section>
        {settingsError && <p role="alert">AeRift could not save this preference for your next session.</p>}
      </Sheet>
    </ThemeProvider>
  </div>;
}

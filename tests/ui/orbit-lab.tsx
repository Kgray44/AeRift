import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppBrand, AppShell, Button, ConnectionStatus, DeviceCard, GlassSurface, Orbit, OrbitSurface,
  SettingsPanel, SpatialScene, ThemeProvider, TransferProgress, type AppearanceSettings, type OrbitShortcut,
} from "../../packages/ui/src";
import { getNavigation, restorePreferences, type DestinationId } from "@aerift/app-contract/experience";
import type { Device, Transfer } from "@aerift/app-contract";
import { RiftExperience, TransferObject } from "../../packages/ui/src/RiftExperience";
import "../../packages/ui/src/styles.css";
import "./orbit-lab.css";

const devices: readonly Device[] = [
  { id: "phone", name: "Mira’s iPhone", platform: "ios", online: true, paired: true },
  { id: "studio", name: "Studio PC", platform: "windows", online: true, paired: true },
  { id: "travel", name: "Travel laptop", platform: "windows", online: false, paired: true },
];
const currentTransfer: Transfer = {
  id: "references", deviceId: "studio", file: { name: "Studio references.zip", sizeBytes: 32 * 1024 ** 2 },
  direction: "outgoing", state: "transferring", bytesTransferred: 19 * 1024 ** 2,
};
const completedTransfer: Transfer = {
  id: "notes", deviceId: "phone", file: { name: "Field notes.pdf", sizeBytes: 2 * 1024 ** 2 },
  direction: "incoming", state: "completed", bytesTransferred: 2 * 1024 ** 2,
};

function OrbitLab() {
  const params = new URLSearchParams(location.search);
  const [scheme, setScheme] = useState<AppearanceSettings["scheme"]>(params.get("scheme") === "light" ? "light" : "dark");
  const [full, setFull] = useState(params.get("mode") !== "simplified");
  const [reduced, setReduced] = useState(params.has("reduced"));
  const [conventional, setConventional] = useState(params.has("conventional"));
  const [shortcut, setShortcut] = useState<OrbitShortcut>("alt-o");
  const [route, setRoute] = useState<DestinationId>("home");
  const [inspectMorph, setInspectMorph] = useState(false);
  const [morphFrame, setMorphFrame] = useState(160);
  const frame = useRef(morphFrame);
  const [file, setFile] = useState("Field notes.pdf");
  const [device, setDevice] = useState("phone");
  const [transparency, setTransparency] = useState<AppearanceSettings["transparency"]>("system");
  const [contrast, setContrast] = useState<AppearanceSettings["contrast"]>("system");
  const [module, setModule] = useState("Files");
  const surface = useRef<HTMLElement>(null);
  const navigation = getNavigation("desktop", restorePreferences({
    version: 1, windowMode: full ? "full" : "simplified", desktopNavigation: conventional ? "conventional" : "orbit",
  }), { ambient: "unsupported", camera: "unsupported" });
  const destinations = navigation.primary;
  const active = destinations.find(item => item.id === route) ?? destinations[0];

  useEffect(() => {
    const element = surface.current;
    if (!inspectMorph || !element) return;
    const observer = new MutationObserver(() => {
      if (!element.dataset.morphing) return;
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = frame.current;
      }
    });
    observer.observe(element, { attributes: true, attributeFilter: ["data-morphing"] });
    return () => {
      observer.disconnect();
      for (const animation of element.getAnimations({ subtree: true })) animation.play();
    };
  }, [inspectMorph]);

  const appearance: AppearanceSettings = { theme: "glass", scheme, transparency, contrast, motion: reduced ? "reduce" : "system" };

  return <ThemeProvider {...appearance}>
    <AppShell hideToolbar>
    <div className="orbit-lab">
      <header className="ae-experience-nav orbit-lab-header">
        <Orbit destinations={destinations} active={active.id} onNavigate={setRoute} surfaceRef={surface}
          presentation={navigation.presentation === "conventional" ? "conventional" : "orbit"} shortcut={shortcut} reducedMotion={reduced}
          status={{ devices: "2 paired devices online", activity: "1 active transfer" }} />
        <GlassSurface material="chrome" className="ae-nav-brand"><AppBrand /></GlassSurface>
        <GlassSurface material="chrome" className="ae-nav-tools orbit-lab-online">
          <ConnectionStatus state="connected" label="Local network" />
        </GlassSurface>
      </header>
      <OrbitSurface ref={surface} aria-labelledby="orbit-lab-heading">
          <div className="orbit-lab-destination">
            <h2 id="orbit-lab-heading" data-orbit-focus tabIndex={-1}>{active.label}</h2>
            {route === "home" && <div className="ae-workspace-view">
              <SpatialScene devices={devices} platform="windows" discovery="available" selectedId={device}
                onSelect={setDevice} onPair={() => setRoute("devices")} />
              <GlassSurface material="chrome" className="ae-transfer-dock">
                <Button onClick={() => setRoute("rift")}>Open Rift</Button>
              </GlassSurface>
            </div>}
            {route === "rift" && <>
              <RiftExperience transfer={currentTransfer} deviceName="Studio PC" compactPath />
              <GlassSurface material="chrome" className="ae-transfer-dock">
                <TransferObject objectId="fixture" files={[{ name: file, sizeBytes: 2 * 1024 ** 2 }]} state="resting" />
                <div className="orbit-lab-rows">
                  <label>Selected file <input value={file} onChange={event => setFile(event.currentTarget.value)} /></label>
                  <label>Destination <select value={device} onChange={event => setDevice(event.currentTarget.value)}>
                    {devices.map(peer => <option key={peer.id} value={peer.id} disabled={!peer.online}>{peer.name}</option>)}
                  </select></label>
                </div>
              </GlassSurface>
            </>}
            {route === "devices" && <div className="orbit-lab-device-list">
              {devices.map(peer => <DeviceCard key={peer.id} device={peer} name={peer.name} selected={device === peer.id} onSelect={() => setDevice(peer.id)} />)}
            </div>}
            {route === "activity" && <div className="ae-activity-list">
              <TransferProgress transfer={currentTransfer} deviceName="Studio PC" />
              <TransferProgress transfer={completedTransfer} deviceName="Mira’s iPhone" />
            </div>}
            {route === "settings" && <div className="orbit-lab-rows">
              <SettingsPanel value={appearance} themes={[{ id: "glass", label: "GLASS" }]} onChange={settings => {
                setScheme(settings.scheme);
                setTransparency(settings.transparency);
                setContrast(settings.contrast);
                setReduced(settings.motion === "reduce");
              }} />
              <label>Orbit shortcut <select value={shortcut} onChange={event => setShortcut(event.currentTarget.value as OrbitShortcut)}>
                <option value="alt-o">Alt+O</option><option value="alt-shift-o">Alt+Shift+O</option><option value="off">Off</option>
              </select></label>
              <label>Conventional navigation <input type="checkbox" checked={conventional} onChange={event => setConventional(event.currentTarget.checked)} /></label>
            </div>}
            {route === "workspace" && <div className="orbit-lab-rows">
              <label>Module <select value={module} onChange={event => setModule(event.currentTarget.value)}>
                <option>Files</option><option>Photos</option><option>Notes</option>
              </select></label>
              <div><strong>{module}</strong><span>{module === "Files" ? file : module === "Photos" ? "Reference images.zip" : "Field notes"}</span></div>
            </div>}
          </div>
      </OrbitSurface>
      <footer className="orbit-lab-controls" aria-label="Orbit lab controls">
        <strong>Orbit lab</strong>
        <label>Light theme <input type="checkbox" checked={scheme === "light"} onChange={event => setScheme(event.currentTarget.checked ? "light" : "dark")} /></label>
        <label>Full mode <input type="checkbox" checked={full} onChange={event => {
          setFull(event.currentTarget.checked);
          if (!event.currentTarget.checked && route === "workspace") setRoute("home");
        }} /></label>
        <label>Reduced motion <input type="checkbox" checked={reduced} onChange={event => setReduced(event.currentTarget.checked)} /></label>
        <label>Conventional <input type="checkbox" checked={conventional} onChange={event => setConventional(event.currentTarget.checked)} /></label>
        <label>Inspect morph <input type="checkbox" checked={inspectMorph} onChange={event => setInspectMorph(event.currentTarget.checked)} /></label>
        {inspectMorph && <label>Morph frame <input type="range" min={0} max={459} value={morphFrame}
          onChange={event => {
            frame.current = event.currentTarget.valueAsNumber;
            setMorphFrame(frame.current);
            for (const animation of surface.current?.getAnimations({ subtree: true }) ?? []) {
              animation.currentTime = frame.current;
            }
          }} /></label>}
      </footer>
    </div>
    </AppShell>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<OrbitLab />);

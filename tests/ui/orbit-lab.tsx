import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Orbit, OrbitSurface, ThemeProvider, type OrbitShortcut } from "../../packages/ui/src";
import { getNavigation, restorePreferences, type DestinationId } from "@aerift/app-contract/experience";
import { GlassOptics } from "../../packages/ui/src/GlassOptics";
import "../../packages/ui/src/styles.css";
import "./orbit-lab.css";

function OrbitLab() {
  const params = new URLSearchParams(location.search);
  const [scheme, setScheme] = useState<"dark" | "light">(params.get("scheme") === "light" ? "light" : "dark");
  const [full, setFull] = useState(params.get("mode") !== "simplified");
  const [reduced, setReduced] = useState(params.has("reduced"));
  const [conventional, setConventional] = useState(params.has("conventional"));
  const [shortcut, setShortcut] = useState<OrbitShortcut>("alt-o");
  const [route, setRoute] = useState<DestinationId>("home");
  const [inspectMorph, setInspectMorph] = useState(false);
  const [morphFrame, setMorphFrame] = useState(160);
  const frame = useRef(morphFrame);
  const [file, setFile] = useState("Field notes.pdf");
  const [device, setDevice] = useState("Mira’s iPhone");
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

  return <ThemeProvider scheme={scheme} motion={reduced ? "reduce" : "system"}>
    <div className="ae-shell orbit-lab">
      <GlassOptics />
      <header className="orbit-lab-header">
        <Orbit destinations={destinations} active={active.id} onNavigate={setRoute} surfaceRef={surface}
          presentation={navigation.presentation === "conventional" ? "conventional" : "orbit"} shortcut={shortcut} reducedMotion={reduced}
          status={{ devices: "2 paired devices online", activity: "1 active transfer" }} />
        <h1>AeRift</h1>
        <span className="orbit-lab-online"><i /> Local network</span>
      </header>
      <main>
        <OrbitSurface ref={surface} aria-labelledby="orbit-lab-heading">
          <div className="orbit-lab-destination">
            <h2 id="orbit-lab-heading" data-orbit-focus tabIndex={-1}>{active.label}</h2>
            {route === "home" && <>
              <p>Send and receive across your paired devices.</p>
              <div className="orbit-lab-rows">
                <div><strong>Recent transfer</strong><span>Reference images.zip</span></div>
                <div><strong>Paired devices</strong><span>Mira’s iPhone · Studio PC</span></div>
              </div>
              <Button onClick={() => setRoute("rift")}>Open Rift</Button>
            </>}
            {route === "rift" && <>
              <p>Choose what to send and where it should arrive.</p>
              <div className="orbit-lab-rows">
                <label>Selected file <input value={file} onChange={event => setFile(event.currentTarget.value)} /></label>
                <label>Destination <select value={device} onChange={event => setDevice(event.currentTarget.value)}>
                  <option>Mira’s iPhone</option><option>Studio PC</option>
                </select></label>
              </div>
            </>}
            {route === "devices" && <div className="orbit-lab-rows">
              <div><strong>Mira’s iPhone</strong><span>Paired · Online</span></div>
              <div><strong>Studio PC</strong><span>Paired · Online</span></div>
              <div><strong>Travel laptop</strong><span>Paired · Offline</span></div>
            </div>}
            {route === "activity" && <div className="orbit-lab-rows">
              <div><strong>Studio references.zip</strong><span>19 of 32 MB sent</span><progress max={32} value={19} /></div>
              <div><strong>Field notes.pdf</strong><span>Received from Mira’s iPhone</span></div>
            </div>}
            {route === "settings" && <div className="orbit-lab-rows">
              <label>Theme <select value={scheme} onChange={event => setScheme(event.currentTarget.value === "light" ? "light" : "dark")}>
                <option value="dark">Dark</option><option value="light">Light</option>
              </select></label>
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
      </main>
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
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<OrbitLab />);

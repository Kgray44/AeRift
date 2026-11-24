import { useEffect, useRef, useState } from "react";
import { WORKSPACE_MODULES } from "@aerift/app-contract/experience";
import { MobileMediaTray } from "./MobileMediaTray";
import type { MediaSource } from "./mobile-media";
import type { ObservedMediaPort } from "./mobile-media-observer";
import { LocalObjectWorkspace, type LocalModule } from "./LocalObjectWorkspace";
import type { MobileObject } from "./local-objects";
import type { MobileOperations, MobilePlatformCopy, ReceivedCopy } from "./mobile-platform";
import type { AppPort, Transfer } from "@aerift/app-contract";
import { mobileMotionDirection, observeMobileMotionSuppression, type MobileMotionDirection } from "./mobile-motion";
import { Button, SpatialIcon, TransferObject, type TransferWorkspaceRegions } from "@aerift/ui";

export type PickerSource = MediaSource;
export type ModuleVisibility = Record<PickerSource | LocalModule, boolean>;

export function MobileWorkspace({ regions, modules, pick, media, received, openRift, objects, save, clipboardSharing, markClipboardSelection, operations, copy, reducedMotion = false }: {
  regions: TransferWorkspaceRegions;
  modules: ModuleVisibility;
  pick: (source: PickerSource) => ReturnType<AppPort["selectFile"]>;
  media: ObservedMediaPort;
  received: readonly Transfer[];
  openRift: () => void;
  objects: readonly MobileObject[] | undefined;
  save: (next: readonly MobileObject[]) => boolean;
  clipboardSharing: boolean;
  markClipboardSelection: (id: string) => void;
  operations: MobileOperations;
  copy: MobilePlatformCopy;
  reducedMotion?: boolean;
}) {
  const initialSelection = useRef(regions.selection?.selectionId);
  const [presenting, setPresenting] = useState<"preview" | "export">();
  const [presentationError, setPresentationError] = useState("");
  const [receivedAction, setReceivedAction] = useState<string>();
  const [receivedError, setReceivedError] = useState("");
  async function presentReceived(transferId: string, action: "preview" | "share") {
    if (!operations.presentReceived || receivedAction) return;
    setReceivedError("");
    setReceivedAction(transferId);
    try {
      const result = await operations.presentReceived(transferId, action);
      if (!result.ok) setReceivedError(action === "preview" ? "AeRift couldn't open this received copy." : "AeRift couldn't share this received copy.");
    } finally {
      setReceivedAction(undefined);
    }
  }
  const [picked, setPicked] = useState<{ id: PickerSource | LocalModule; motion?: MobileMotionDirection }>();
  const visible = WORKSPACE_MODULES.filter(({ id }) => modules[id]);
  const ordered = visible.map(({ id }) => id);
  const current = picked && ordered.includes(picked.id) ? picked.id : ordered[0];
  const [catalog, setCatalog] = useState<readonly ReceivedCopy[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [catalogLimit, setCatalogLimit] = useState(20);
  // A transfer can complete out of order. Observe the completed-ID set, not
  // its first element or snapshot object identity, to avoid polling on progress.
  const latestArrival = JSON.stringify(received.map(item => item.id).sort());
  useEffect(() => {
    if (current !== "files" || !operations.listReceived) return;
    let active = true;
    setCatalogState("loading");
    void operations.listReceived().then(result => {
      if (!active) return;
      if (result.ok) {
        setCatalog(result.value);
        setCatalogState("ready");
      } else {
        setCatalogState("error");
      }
    }).catch(() => { if (active) setCatalogState("error"); });
    return () => { active = false; };
  }, [catalogRefresh, current, latestArrival, operations]);
  const visibleReceived = operations.listReceived
    ? catalog.slice(0, catalogLimit)
    : received.slice(0, 5).map(item => ({ id: item.id, ...item.file }));

  const moduleMotion = picked?.id === current ? picked?.motion : undefined;
  const clearModuleMotion = (placed: typeof picked) =>
    setPicked(latest => latest === placed && latest?.motion ? { id: latest.id } : latest);
  useEffect(() => {
    if (moduleMotion) return observeMobileMotionSuppression(reducedMotion, () => clearModuleMotion(picked));
  }, [moduleMotion, picked, reducedMotion]);
  function selectModule(id: PickerSource | LocalModule) {
    setPicked(previous => {
      const active = previous && ordered.includes(previous.id) ? previous.id : ordered[0];
      return active === id ? previous : { id, motion: mobileMotionDirection(ordered, active, id) };
    });
  }
  async function present(action: "preview" | "export") {
    if (!regions.selection || presenting) return;
    setPresentationError("");
    setPresenting(action);
    const result = await operations.presentSelection(regions.selection.selectionId, action);
    setPresenting(undefined);
    if (!result.ok) setPresentationError(action === "preview" ? `${copy.previewer} couldn't preview this item.` : "AeRift couldn't open sharing for this item.");
  }

  return <>
    {regions.selection && <section key={regions.selection.selectionId} className="ios-section" aria-label="Selected object"
      data-ae-route-enter={regions.selection.selectionId !== initialSelection.current ? "neutral" : undefined}>
      <h3>Ready for Rift</h3>
      <TransferObject files={[regions.selection]} objectId={regions.selection.selectionId} state="resting" />
      <p>Temporary Rift selection. The source item stays where it is.</p>
      <div className="ae-actions">
        <Button variant="quiet" disabled={!!presenting} onClick={() => void present("preview")}>Preview</Button>
        <Button variant="quiet" disabled={!!presenting} onClick={() => void present("export")}>Export copy</Button>
        <Button onClick={openRift}>Open Rift</Button>
      </div>
      {presentationError && <p role="alert">{presentationError}</p>}
    </section>}
    {visible.length ? <nav className="ios-module-picker" aria-label="Workspace modules">
      {visible.map(({ id, label, icon }) => <Button key={id} variant="quiet" aria-pressed={id === current}
        data-ae-lens-role={id === current ? "control" : undefined} onClick={() => selectModule(id)}>
        <SpatialIcon name={icon} size={16} /><span>{label}</span>
      </Button>)}
    </nav> : <p>Enable a workspace module in Settings.</p>}
    {current && <div className="ios-module-moment" key={current} data-ae-route-enter={moduleMotion}
      onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName.startsWith("ae-route-")) clearModuleMotion(picked); }}>
    {current === "files" && <section className="ios-section" aria-labelledby="ios-files">
      <div className="ios-section-head">
        <div><h3 id="ios-files">Files</h3><p>{copy.fileSources}</p></div>
        <Button data-ae-lens-role="control" disabled={!regions.canSelect} onClick={() => void regions.select(() => pick("files"))}>Choose for Rift</Button>
      </div>
      {(operations.listReceived || visibleReceived.length > 0) && <h4>Received on {copy.device}</h4>}
      {operations.listReceived && catalogState === "loading" && !catalog.length &&
        <p role="status">Loading received copies…</p>}
      {operations.listReceived && catalogState === "error" && <div className="ae-actions">
        <p role="alert">AeRift couldn't refresh received copies.</p>
        <Button variant="quiet" onClick={() => setCatalogRefresh(value => value + 1)}>Retry received list</Button>
      </div>}
      {operations.listReceived && catalogState === "ready" && !catalog.length && <p>No received files yet.</p>}
      {visibleReceived.length > 0 && <ul className="ios-list">{visibleReceived.map(item => <li key={item.id}>
        {item.name}
        {operations.presentReceived && <div className="ae-actions">
          <Button variant="quiet" aria-label={`Open received ${item.name}`} disabled={!!receivedAction}
            onClick={() => void presentReceived(item.id, "preview")}>Open</Button>
          <Button variant="quiet" aria-label={`Share received ${item.name}`} disabled={!!receivedAction}
            onClick={() => void presentReceived(item.id, "share")}>Share copy</Button>
        </div>}
      </li>)}</ul>}
      {operations.listReceived && catalogLimit < catalog.length &&
        <Button variant="quiet" onClick={() => setCatalogLimit(limit => limit + 20)}>Show more received copies</Button>}
      {receivedError && <p role="alert">{receivedError}</p>}
      <p>Delivered files are saved in {copy.receivedFolder}.</p>
    </section>}
    {current === "photos" && <section className="ios-section" aria-labelledby="ios-photos">
      <div className="ios-section-head">
        <div><h3 id="ios-photos">Photos and videos</h3>
          <p>AeRift can only access items you choose in the system picker.</p></div>
        <Button data-ae-lens-role="control" disabled={!regions.canSelect} onClick={() => void regions.select(() => pick("photos"))}>Choose for Rift</Button>
      </div>
    </section>}
    {(current === "files" || current === "photos") &&
      <MobileMediaTray key={current} source={current} port={media} regions={regions} copy={copy} />}
    {current && current !== "files" && current !== "photos" && (objects
      ? <LocalObjectWorkspace key={current} module={current} objects={objects} save={save} media={media}
        regions={regions} openRift={openRift} clipboardSharing={clipboardSharing}
        markClipboardSelection={markClipboardSelection} operations={operations} copy={copy} />
      : <p role="alert">AeRift couldn't read the saved workspace. Files and Photos are still available.</p>)}
    </div>}
    {regions.selecting && <p role="status">Opening picker or preparing item…</p>}
  </>;
}

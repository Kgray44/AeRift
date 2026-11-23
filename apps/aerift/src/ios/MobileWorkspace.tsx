import { useState } from "react";
import { WORKSPACE_MODULES } from "@aerift/app-contract/experience";
import { MobileMediaTray } from "./MobileMediaTray";
import type { MediaSource } from "./mobile-media";
import type { ObservedMediaPort } from "./mobile-media-observer";
import { LocalObjectWorkspace, type LocalModule } from "./LocalObjectWorkspace";
import type { MobileObject } from "./local-objects";
import { command } from "../nativeAppPort";
import type { AppPort, Transfer } from "@aerift/app-contract";
import { Button, TransferObject, type TransferWorkspaceRegions } from "@aerift/ui";

export type PickerSource = MediaSource;
export type ModuleVisibility = Record<PickerSource | LocalModule, boolean>;

export function MobileWorkspace({ regions, modules, pick, media, received, openRift, objects, save, clipboardSharing, markClipboardSelection }: {
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
}) {
  const [presenting, setPresenting] = useState<"preview" | "export">();
  const [presentationError, setPresentationError] = useState("");
  const [selected, setSelected] = useState<PickerSource | LocalModule>();
  const visible = WORKSPACE_MODULES.filter(({ id }) => modules[id]);
  const current = visible.some(({ id }) => id === selected) ? selected : visible[0]?.id;
  async function present(action: "preview" | "export") {
    if (!regions.selection || presenting) return;
    setPresentationError("");
    setPresenting(action);
    const result = await command("present_ios_selection", { selectionId: regions.selection.selectionId, action });
    setPresenting(undefined);
    if (!result.ok) setPresentationError(action === "preview" ? "Quick Look couldn't preview this item." : "AeRift couldn't open sharing for this item.");
  }

  return <>
    {regions.selection && <section className="ios-section" aria-label="Selected object">
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
      {visible.map(({ id, label }) => <Button key={id} variant="quiet" aria-pressed={id === current}
        onClick={() => setSelected(id)}>{label}</Button>)}
    </nav> : <p>Enable a workspace module in Settings.</p>}
    {current === "files" && <section className="ios-section" aria-labelledby="ios-files">
      <div className="ios-section-head">
        <div><h3 id="ios-files">Files</h3><p>Browse Files, cloud providers and On My iPhone.</p></div>
        <Button disabled={!regions.canSelect} onClick={() => void regions.select(() => pick("files"))}>Choose for Rift</Button>
      </div>
      {received.length > 0 && <>
        <h4>Received on this iPhone</h4>
        <ul className="ios-list">{received.slice(0, 5).map(item => <li key={item.id}>{item.file.name}</li>)}</ul>
      </>}
      <p>Delivered files are saved in Files → On My iPhone → AeRift → Received.</p>
    </section>}
    {current === "photos" && <section className="ios-section" aria-labelledby="ios-photos">
      <div className="ios-section-head">
        <div><h3 id="ios-photos">Photos and videos</h3>
          <p>AeRift can only access items you choose in the system picker.</p></div>
        <Button disabled={!regions.canSelect} onClick={() => void regions.select(() => pick("photos"))}>Choose for Rift</Button>
      </div>
    </section>}
    {(current === "files" || current === "photos") &&
      <MobileMediaTray key={current} source={current} port={media} regions={regions} />}
    {current && current !== "files" && current !== "photos" && (objects
      ? <LocalObjectWorkspace key={current} module={current} objects={objects} save={save}
        regions={regions} openRift={openRift} clipboardSharing={clipboardSharing}
        markClipboardSelection={markClipboardSelection} />
      : <p role="alert">AeRift couldn't read the saved workspace. Files and Photos are still available.</p>)}
    {regions.selecting && <p role="status">Opening picker or preparing item…</p>}
  </>;
}

import { useState } from "react";
import { WORKSPACE_MODULES } from "@aerift/app-contract/experience";
import { LocalObjectWorkspace, type LocalModule } from "./LocalObjectWorkspace";
import type { MobileObject } from "./local-objects";
import type { AppPort, Transfer } from "@aerift/app-contract";
import { Button, FileCard, type TransferWorkspaceRegions } from "@aerift/ui";

export const pickerSources = ["files", "photos"] as const;
export type PickerSource = typeof pickerSources[number];
export type ModuleVisibility = Record<PickerSource | LocalModule, boolean>;

export function MobileWorkspace({ regions, modules, pick, received, openRift, objects, save }: {
  regions: TransferWorkspaceRegions;
  modules: ModuleVisibility;
  pick: (source: PickerSource) => ReturnType<AppPort["selectFile"]>;
  received: readonly Transfer[];
  openRift: () => void;
  objects: readonly MobileObject[] | undefined;
  save: (next: readonly MobileObject[]) => boolean;
}) {
  const [selected, setSelected] = useState<PickerSource | LocalModule>();
  const visible = WORKSPACE_MODULES.filter(({ id }) => modules[id]);
  const current = visible.some(({ id }) => id === selected) ? selected : visible[0]?.id;
  return <>
    {regions.selection && <section className="ios-section" aria-label="Selected object">
      <h3>Ready for Rift</h3>
      <FileCard file={regions.selection} action={<Button variant="quiet" onClick={openRift}>Open Rift</Button>} />
    </section>}
    {visible.length ? <nav className="ios-module-picker" aria-label="Workspace modules">
      {visible.map(({ id, label }) => <Button key={id} variant="quiet" aria-pressed={id === current}
        onClick={() => setSelected(id)}>{label}</Button>)}
    </nav> : <p>Enable a workspace module in Settings.</p>}
    {current === "files" && <section className="ios-section" aria-labelledby="ios-files">
      <div className="ios-section-head">
        <div><h3 id="ios-files">Files</h3><p>Browse Files, cloud providers and On My iPhone.</p></div>
        <Button disabled={!regions.canSelect} onClick={() => void regions.select(() => pick("files"))}>Choose file</Button>
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
          <p>The system picker shares only the item you choose.</p></div>
        <Button disabled={!regions.canSelect} onClick={() => void regions.select(() => pick("photos"))}>Choose media</Button>
      </div>
    </section>}
    {current && current !== "files" && current !== "photos" && (objects
      ? <LocalObjectWorkspace key={current} module={current} objects={objects} save={save}
        regions={regions} openRift={openRift} />
      : <p role="alert">AeRift couldn't read the saved workspace. Files and Photos are still available.</p>)}
    {regions.selecting && <p role="status">Opening picker or preparing item…</p>}
  </>;
}

import { isTauri } from "@tauri-apps/api/core";
import type { DigitalObject } from "@aerift/app-contract/digital-objects";
import { getVisibleModules, type ExperiencePreferences, type ModuleId } from "@aerift/app-contract/experience";
import { Button, IconAction, Popover, SpatialIcon } from "@aerift/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { command } from "../nativeAppPort";
import { DesktopNotesWorkspace } from "./DesktopNotesWorkspace";
import { WorkspaceChosenFolder } from "./WorkspaceChosenFolder";
import { useWorkspaceFileTools, WorkspaceFileTools } from "../WorkspaceFileTools";
import { WorkspaceBrowserTools } from "../WorkspaceBrowserTools";
import { useWorkspaceClipboardTools, WorkspaceClipboardCopy, WorkspaceClipboardDetails, WorkspaceClipboardTools } from "../WorkspaceClipboardTools";
import { WorkspaceCollectionTools } from "../WorkspaceCollectionTools";
import { readWorkspaceBrowserHistory, recordWorkspaceBrowserLaunch } from "../workspace-browser-tools";
import { useDesktopContentEnter } from "./desktopContentMotion";
import { WorkspaceCategoryHeading, WorkspaceLibrary, useWorkspaceLibrary } from "../WorkspaceLibrary";
import { isWorkspaceDocument, workspaceSections, type WorkspaceSectionId } from "../workspace-categories";
import { applyWorkspaceChanges, loadWorkspace, loadWorkspaceAsset, type WorkspaceEntry, type WorkspaceMetadata } from "./workspaceStore";

function newObject(name: string) {
  return { schemaVersion: 1, id: crypto.randomUUID(), name, ownership: "local" } as const;
}

function belongsTo(object: DigitalObject, moduleId: ModuleId) {
  switch (moduleId) {
    case "files": return object.kind === "file";
    case "photos": return object.kind === "photo" || object.kind === "video";
    case "browser": return object.kind === "url";
    case "notes": return object.kind === "note";
    case "clipboard": return object.kind === "clipboard";
    case "collections": return object.kind === "collection";
  }
}

function AssetPreview({ object }: { object: DigitalObject }) {
  const [url, setUrl] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let current = true;
    let objectUrl: string | undefined;
    void loadWorkspaceAsset(object.id).then(asset => {
      if (!current) return;
      if (!asset) { setUnavailable(true); return; }
      objectUrl = URL.createObjectURL(asset);
      setUrl(objectUrl);
    }).catch(() => { if (current) setUnavailable(true); });
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [object.id]);
  if (unavailable) return <p role="alert">AeRift could not open this saved copy.</p>;
  if (!url) return <p role="status">Opening saved copy…</p>;
  return <>
    {object.kind === "photo" && <img src={url} alt={object.name} />}
    {object.kind === "video" && <video src={url} aria-label={object.name} controls preload="metadata" />}
    <a href={url} download={object.name}>Save a copy</a>
  </>;
}

const pageSize = 48;
const browserHistoryKey = "aerift.desktop.workspace.browser-history.v1";

export function DesktopWorkspace({ preferences, clipboardAllowed, active }: {
  preferences: ExperiencePreferences;
  clipboardAllowed: boolean;
  active: boolean;
}) {
  const modules = getVisibleModules(preferences);
  const workspace = useWorkspaceLibrary(id => modules.some(module => module.id === id));
  const section = workspace.section;
  const current = section ? { id: section.module, label: section.label } : undefined;
  const fileTools = useWorkspaceFileTools(`desktop:${section?.id ?? "all"}`);
  const fileCategory = current?.id === "files" || current?.id === "photos";
  const itemsRef = useRef<HTMLElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  useDesktopContentEnter(section?.id, itemsRef);
  const [entries, setEntries] = useState<WorkspaceMetadata[]>();
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [editingCollection, setEditingCollection] = useState<string>();
  const clipboardTools = useWorkspaceClipboardTools({ copyAllowed: clipboardAllowed });
  const [selected, setSelected] = useState<readonly string[]>([]);
  const items = entries ?? [];
  const byId = new Map(items.map(({ object }) => [object.id, object]));
  const candidates = items.map(({ object }) => object).filter(object => object.kind !== "collection");
  const selectedCollection = editingCollection ? byId.get(editingCollection) : undefined;
  const inCategory = (object: DigitalObject, id: WorkspaceSectionId, module: ModuleId) =>
    belongsTo(object, module) && (id !== "documents" || (object.kind === "file" && isWorkspaceDocument(object.name, object.mediaType)));
  const categoryItems = section ? items.filter(({ object }) => inCategory(object, section.id, section.module)) : [];
  const visible = fileCategory ? fileTools.browse(categoryItems, ({ object }) => ({
      name: object.name,
      ...(object.kind === "file" || object.kind === "photo" || object.kind === "video" ? {
        mediaType: object.mediaType, sizeBytes: object.sizeBytes,
        kind: object.kind === "file" && isWorkspaceDocument(object.name, object.mediaType) ? "document" as const : object.kind,
      } : {}),
    })) : section?.id === "clipboard" ? clipboardTools.browse(categoryItems, ({ object }) => {
      const saved = object.kind === "clipboard" ? byId.get(object.objectId) : undefined;
      return saved?.kind === "text" ? { name: object.name, text: saved.text, format: saved.format } : undefined;
    }) : categoryItems;
  const counts = entries && Object.fromEntries(workspaceSections.map(({ id, module }) =>
    [id, entries.filter(({ object }) => inCategory(object, id, module)).length]));
  function openSection(id: WorkspaceSectionId) {
    setError(undefined); setStatus(undefined); setPreview(undefined); setEditingCollection(undefined);
    setPageIndex(0); clipboardTools.reset(); workspace.open(id);
  }

  useEffect(() => { setPageIndex(0); }, [fileTools.query, fileTools.kind, fileTools.sort, clipboardTools.options]);

  useEffect(() => {
    let disposed = false;
    void loadWorkspace().then(result => {
      if (!disposed) setEntries(result);
    }, () => {
      if (!disposed) setError("AeRift could not open the local workspace. Try restarting the app.");
    });
    return () => { disposed = true; };
  }, []);

  async function change(prepare: () => Promise<WorkspaceEntry[]> | WorkspaceEntry[],
    message: string, removed: readonly string[] = []) {
    if (busy || !entries) return false;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const prepared = await prepare();
      await applyWorkspaceChanges(prepared, removed);
      const replaced = new Set([...removed, ...prepared.map(({ object }) => object.id)]);
      setEntries([...prepared.map(({ object, asset }) => ({ object, hasAsset: !!asset })),
        ...entries.filter(({ object }) => !replaced.has(object.id))]);
      setStatus(message);
      return true;
    } catch {
      setError("AeRift could not save this change. Check permissions and available storage, then try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function importFiles(files: File[], mediaOnly: boolean) {
    const additions: WorkspaceEntry[] = [];
    for (const file of files) {
      const kind = file.type.startsWith("image/") ? "photo" : file.type.startsWith("video/") ? "video" : "file";
      if ((mediaOnly && kind === "file") || (section?.id === "documents" && !isWorkspaceDocument(file.name, file.type))) continue;
      additions.push({ object: { ...newObject(file.name), kind: mediaOnly ? kind : "file",
        sizeBytes: file.size, mediaType: file.type || undefined }, asset: file });
    }
    if (additions.length) void change(() => additions, `Imported ${additions.length} ${additions.length === 1 ? "item" : "items"}.`);
    else if (files.length) setError(section?.id === "documents" ? "Choose a supported document." : "Choose an image or video file.");
  }

  async function submit(event: FormEvent<HTMLFormElement>, kind: "url" | "collection") {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    const base = newObject(name);
    let object: DigitalObject;
    if (kind === "url") {
      try {
        const url = new URL(String(data.get("url") ?? ""));
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
        object = { ...base, kind, url: url.href };
      } catch {
        setError("Enter an HTTP or HTTPS address without sign-in credentials.");
        return;
      }
    } else {
      if (selected.length === 0) return;
      object = { ...base, kind, itemIds: selected };
    }
    if (await change(() => [{ object }], "Saved to Workspace.")) {
      form.reset();
      if (kind === "collection") { setSelected([]); setEditingCollection(object.id); }
    }
  }

  async function openWorkspaceLink(url: string, saved = false): Promise<boolean> {
    const remember = saved && readWorkspaceBrowserHistory(browserHistoryKey).enabled;
    setError(undefined);
    try {
      const result = await command<void>("open_workspace_url", { url });
      if (!result.ok) {
        setError("AeRift could not open this page in your browser.");
        return false;
      }
      if (remember && !recordWorkspaceBrowserLaunch(browserHistoryKey, url)) {
        setError("The page opened, but AeRift could not save this visit.");
      }
      return true;
    } catch {
      setError("AeRift could not open this page in your browser.");
      return false;
    }
  }

  async function captureClipboard() {
    if (!clipboardAllowed || busy || !entries) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError("Clipboard access was denied or is unavailable.");
      return;
    }
    if (!text.trim()) {
      setError("The clipboard contains no text.");
      return;
    }
    const record = { ...newObject("Clipboard text"), kind: "text", format: "plain", text } as const;
    await change(() => [{ object: record }, { object: {
      ...newObject("Clipboard text"), kind: "clipboard", objectId: record.id,
    } }], "Saved clipboard text on this device.");
  }

  function removeObjects(removed: readonly string[]) {
    const deleted = new Set(removed);
    for (const { object } of items) {
      if (object.kind === "clipboard" && deleted.has(object.id)) deleted.add(object.objectId);
    }
    const updated = items.flatMap(entry => {
      const { object } = entry;
      return object.kind === "collection" && !deleted.has(object.id) && object.itemIds.some(id => deleted.has(id))
        ? [{ object: { ...object, itemIds: object.itemIds.filter(id => !deleted.has(id)) } }] : [];
    });
    return change(() => updated, "Removed from Workspace.", [...deleted]).then(result => {
      if (result) {
        setSelected(current => current.filter(id => !deleted.has(id)));
        if (preview && deleted.has(preview)) setPreview(undefined);
        if (editingCollection && deleted.has(editingCollection)) setEditingCollection(undefined);
      }
      return result;
    });
  }

  function select(id: string, checked: boolean) {
    setSelected(current => checked ? [...current, id] : current.filter(item => item !== id));
  }

  function label(id: string) {
    return items.find(({ object }) => object.id === id)?.object.name ?? "Unavailable object";
  }

  const disabled = busy || !entries;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const page = Math.min(pageIndex, pages - 1);
  const visiblePage = visible.slice(page * pageSize, (page + 1) * pageSize);
  const importLabel = current?.id === "photos" ? "Import photos and videos" :
    section?.id === "documents" ? "Import documents" : "Import files";
  const selectedVisible = visible.filter(({ object }) => selected.includes(object.id)).map(({ object }) => object.id);

  return <div className="aerift-workspace">
    {!section && <WorkspaceLibrary sections={workspace.sections} open={openSection} cardRef={workspace.cardRef} counts={counts} desktop />}
    {section && section.id !== "notes" && <WorkspaceCategoryHeading section={section} heading={workspace.heading} onBack={() => { clipboardTools.reset(); workspace.back(); }} desktop />}
    {!entries && !error && <p>Opening Workspace…</p>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {section?.id === "notes" && <DesktopNotesWorkspace notes={items.flatMap(({ object }) => object.kind === "note" ? [object] : [])}
      disabled={disabled} onSave={object => change(() => [{ object }], "")} onRemove={id => removeObjects([id])}
      onBack={workspace.back} heading={back => <WorkspaceCategoryHeading section={section} heading={workspace.heading} onBack={back} desktop />}
      collectionSelection={selected} onCollectionSelect={select} />}
    {current && section?.id !== "notes" && <div className="aerift-workspace-content">
      {current.id === "browser" && <WorkspaceBrowserTools storageKey={browserHistoryKey}
        onOpen={openWorkspaceLink} labels={{ open: "Open in system browser", description: "Opens pages in your default browser." }} />}
      <div className="aerift-workspace-controls">
        {(current?.id === "files" || current?.id === "photos") &&
          <div className="aerift-workspace-import">
            <IconAction variant="secondary" icon="add" label={importLabel} disabled={disabled}
              onClick={() => importInput.current?.click()} />
            <input ref={importInput} hidden aria-label={importLabel} type="file" multiple disabled={disabled} accept={current.id === "photos" ? "image/*,video/*" : section?.id === "documents" ? ".pdf,.doc,.docx,.odt,.rtf,.txt,.md,.pages,.ppt,.pptx,.key,.odp,.xls,.xlsx,.ods,.numbers,.csv,.tsv,.epub" : undefined}
              onChange={event => {
                importFiles(Array.from(event.currentTarget.files ?? []), current.id === "photos");
                event.currentTarget.value = "";
              }} />
          </div>}
        {current?.id === "browser" && <details className="aerift-workspace-create"><summary><SpatialIcon name="pair" size={18} />Save a link</summary><form onSubmit={event => void submit(event, "url")}>
          <label>Title<input name="name" required maxLength={180} /></label>
          <label>Web address<input name="url" type="url" required /></label>
          <div><Button type="submit" disabled={disabled}>Save link</Button></div>
        </form></details>}
        {current?.id === "clipboard" && <div>
          {clipboardAllowed ? <IconAction variant="secondary" label="Capture clipboard text" icon="clipboard" disabled={disabled} onClick={() => void captureClipboard()} />
            : <p>Enable manual capture in Settings to save clipboard text.</p>}
        </div>}
        {current?.id === "collections" && <details className="aerift-workspace-create" open={selected.length ? true : undefined}><summary><SpatialIcon name="collection" size={18} />Create a collection{selected.length > 0 ? ` (${selected.length} selected)` : ""}</summary><form onSubmit={event => void submit(event, "collection")}>
          <label>Name<input name="name" required maxLength={180} /></label>
          <p>Select files, notes, media, links, or clipboard entries in their modules to group them here.</p>
          {!!selected.length && <ol>{selected.map(id => <li key={id}>{label(id)}
            <IconAction label={`Remove ${label(id)} from selection`} icon="close" onClick={() => select(id, false)} /></li>)}</ol>}
          <div><Button type="submit" disabled={disabled || !selected.length}>Create collection</Button></div>
        </form></details>}
      </div>
      {current.id === "clipboard" && <WorkspaceClipboardTools tools={clipboardTools} count={visible.length} total={categoryItems.length} />}
      {current.id === "collections" && selectedCollection?.kind === "collection" &&
        <WorkspaceCollectionTools key={selectedCollection.id} name={selectedCollection.name}
          objects={candidates} memberIds={selectedCollection.itemIds} disabled={disabled}
          onChange={(next, previous) => previous.length === selectedCollection.itemIds.length &&
            previous.every((id, index) => id === selectedCollection.itemIds[index]) &&
            change(() => [{ object: { ...selectedCollection, itemIds: next } }], "Collection updated.")} />}
      {active && section?.id === "files" && isTauri() && <WorkspaceChosenFolder />}
      {fileCategory && <section className="ae-surface aw-file-filter" data-material="control" aria-label="Find in imported library">
        <WorkspaceFileTools tools={fileTools}
          label={section?.id === "documents" ? "Search imported documents" : current.id === "photos" ? "Search imported media" : "Search imported files"}
          kinds={section?.id === "documents" ? [] : current.id === "photos" ? ["photo", "video"] : ["document", "photo", "video", "other"]} />
      </section>}
      <section ref={itemsRef} aria-label={`Saved ${current.label.toLowerCase()}`} className="aerift-workspace-items">
        {entries && fileCategory && !visible.length && categoryItems.length > 0 && <p>No imported items match your search.</p>}
        {entries && current && categoryItems.length === 0 && <div className="aerift-empty-state"><SpatialIcon name="workspace" size={32} /><h4>No saved {current.id === "photos" ? "media" : "items"} yet</h4>{(current.id === "files" || current.id === "photos") && <p>Use the add button above to import.</p>}</div>}
        {selectedVisible.length > 0 && <div>
          <Button variant="quiet" disabled={disabled} onClick={() => removeObjects(selectedVisible)}>
            Remove selected ({selectedVisible.length})
          </Button>
        </div>}
        {visible.length > 0 && <ol>{visiblePage.map(entry => {
          const { object } = entry;
          const captured = object.kind === "clipboard" ? byId.get(object.objectId) : undefined;
          return <li key={object.id} className="ae-surface aerift-workspace-object" data-material="content" data-selected={selected.includes(object.id)}><div>
            <span className="aerift-object-glyph"><SpatialIcon name={object.kind === "url" ? "pair" : object.kind === "collection" ? "workspace" : "file"} size={24} /></span>
            <span className="aerift-object-kind">{object.kind}</span>
            {object.kind === "collection" ? <strong>{object.name}</strong> :
              <label className="aerift-check"><input type="checkbox" checked={selected.includes(object.id)}
                onChange={event => select(object.id, event.currentTarget.checked)} />{object.name}</label>}
            {captured?.kind === "text" && <>
              <p className="aerift-note-text">{captured.text}</p>
              <WorkspaceClipboardDetails text={captured.text} format={captured.format} />
              <WorkspaceClipboardCopy tools={clipboardTools} name={object.name} text={captured.text} />
            </>}
            {object.kind === "collection" && (object.itemIds.length
              ? <ol>{object.itemIds.map(id => <li key={id}>{label(id)}</li>)}</ol> : <p>This collection is empty.</p>)}
            <Popover label={`Actions for ${object.name}`} actions={[
              ...(entry.hasAsset ? [{ id: "preview", label: preview === object.id ? "Close file details" : "File details",
                onSelect: () => setPreview(preview === object.id ? undefined : object.id) }] : []),
              ...(object.kind === "collection" ? [{ id: "members", label: "Manage collection",
                onSelect: () => setEditingCollection(object.id) }] : []),
              ...(object.kind === "url" ? [{ id: "open-link", label: "Open in browser", onSelect: () =>
                void openWorkspaceLink(object.url, true) }] : []),
              { id: "remove", label: "Remove", disabled, onSelect: () => removeObjects([object.id]) },
            ]} />
            {preview === object.id && <AssetPreview object={object} />}
          </div></li>;
        })}</ol>}
        {pages > 1 && <nav aria-label="Workspace pages" className="ae-actions">
          <IconAction label="Previous page" icon="back" disabled={page === 0} onClick={() => setPageIndex(page - 1)} />
          <span role="status">Page {page + 1} of {pages}</span>
          <IconAction label="Next page" icon="chevron" disabled={page >= pages - 1} onClick={() => setPageIndex(page + 1)} />
        </nav>}
      </section>
    </div>}
  </div>;
}

import type { DigitalObject } from "@aerift/app-contract/digital-objects";
import { getVisibleModules, type ExperiencePreferences, type ModuleId } from "@aerift/app-contract/experience";
import { Button, Popover, SpatialIcon } from "@aerift/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { command } from "../nativeAppPort";
import { applyWorkspaceChanges, loadWorkspace, type WorkspaceEntry } from "./workspaceStore";

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

function AssetPreview({ entry }: { entry: WorkspaceEntry }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!entry.asset) return;
    const objectUrl = URL.createObjectURL(entry.asset);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [entry.asset]);
  if (!url) return null;
  return <>
    {entry.object.kind === "photo" && <img src={url} alt={entry.object.name} />}
    {entry.object.kind === "video" && <video src={url} aria-label={entry.object.name} controls preload="metadata" />}
    <a href={url} download={entry.object.name}>Save a copy</a>
  </>;
}

export function DesktopWorkspace({ preferences, clipboardAllowed }: {
  preferences: ExperiencePreferences;
  clipboardAllowed: boolean;
}) {
  const modules = getVisibleModules(preferences);
  const [moduleId, setModuleId] = useState<ModuleId>("files");
  const current = modules.find(module => module.id === moduleId) ?? modules[0];
  const [entries, setEntries] = useState<WorkspaceEntry[]>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const noteEditor = useRef<HTMLDetailsElement>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const items = entries ?? [];
  const visible = current ? items.filter(({ object }) => belongsTo(object, current.id)) : [];

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
      setEntries([...prepared, ...entries.filter(({ object }) => !replaced.has(object.id))]);
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
      if (mediaOnly && kind === "file") continue;
      additions.push({ object: { ...newObject(file.name), kind: mediaOnly ? kind : "file",
        sizeBytes: file.size, mediaType: file.type || undefined }, asset: file });
    }
    if (additions.length) void change(() => additions, `Imported ${additions.length} ${additions.length === 1 ? "item" : "items"}.`);
    else if (files.length) setError("Choose an image or video file.");
  }

  async function submit(event: FormEvent<HTMLFormElement>, kind: "note" | "url" | "collection") {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    const base = editing && kind === "note" ? { ...newObject(name), id: editing } : newObject(name);
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
    } else if (kind === "note") {
      object = { ...base, kind, format: "plain", text: String(data.get("text") ?? "") };
    } else {
      if (selected.length === 0) return;
      object = { ...base, kind, itemIds: selected };
    }
    if (await change(() => [{ object }], "Saved to Workspace.")) {
      form.reset();
      setEditing(undefined);
      if (kind === "collection") setSelected([]);
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
    void change(() => updated, "Removed from Workspace.", [...deleted]).then(result => {
      if (result) {
        setSelected(current => current.filter(id => !deleted.has(id)));
        if (preview && deleted.has(preview)) setPreview(undefined);
        if (editing && deleted.has(editing)) setEditing(undefined);
      }
    });
  }

  function select(id: string, checked: boolean) {
    setSelected(current => checked ? [...current, id] : current.filter(item => item !== id));
  }

  function label(id: string) {
    return items.find(({ object }) => object.id === id)?.object.name ?? "Unavailable object";
  }

  const note = items.find(({ object }) => object.id === editing)?.object;
  const disabled = busy || !entries;
  const selectedVisible = visible.filter(({ object }) => selected.includes(object.id)).map(({ object }) => object.id);

  return <div className="aerift-workspace">
    <nav className="aerift-desktop-nav" aria-label="Workspace modules">
      {modules.map(module => <Button key={module.id} variant={module.id === current?.id ? "primary" : "quiet"}
        aria-current={module.id === current?.id ? "page" : undefined}
        onClick={() => { setModuleId(module.id); setError(undefined); setStatus(undefined); }}>{module.label}</Button>)}
    </nav>
    {!current && <p>Enable workspace modules in Settings.</p>}
    {current && <div className="aerift-section-heading"><h3>{current.label}</h3><span>{visible.length} {visible.length === 1 ? "object" : "objects"} · On this device</span></div>}
    {!entries && !error && <p>Opening Workspace…</p>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {current && <div className="aerift-workspace-content">
      <div className="aerift-workspace-controls">
        {(current?.id === "files" || current?.id === "photos") &&
          <label>Import {current.id === "photos" ? "photos and videos" : "files"}
            <input type="file" multiple disabled={disabled} accept={current.id === "photos" ? "image/*,video/*" : undefined}
              onChange={event => {
                importFiles(Array.from(event.currentTarget.files ?? []), current.id === "photos");
                event.currentTarget.value = "";
              }} />
          </label>}
        {current?.id === "notes" && <details className="aerift-workspace-create" ref={noteEditor}><summary>{editing ? "Edit note" : "Create a note"}</summary><form key={editing ?? "new"} onSubmit={event => void submit(event, "note")}>
          <label>Title<input name="name" required maxLength={180} defaultValue={note?.name} /></label>
          <label>Note<textarea name="text" defaultValue={note?.kind === "note" ? note.text : undefined} /></label>
          <div className="ae-actions"><Button type="submit" disabled={disabled}>{editing ? "Save changes" : "Add note"}</Button>
            {editing && <Button onClick={() => setEditing(undefined)}>Cancel editing</Button>}</div>
        </form></details>}
        {current?.id === "browser" && <details className="aerift-workspace-create"><summary>Save a link</summary><form onSubmit={event => void submit(event, "url")}>
          <label>Title<input name="name" required maxLength={180} /></label>
          <label>Web address<input name="url" type="url" required /></label>
          <div><Button type="submit" disabled={disabled}>Save link</Button></div>
        </form></details>}
        {current?.id === "clipboard" && <div>
          {clipboardAllowed ? <Button disabled={disabled} onClick={() => void captureClipboard()}>Capture clipboard text</Button>
            : <p>Enable manual capture in Settings to save clipboard text.</p>}
        </div>}
        {current?.id === "collections" && <details className="aerift-workspace-create" open={selected.length ? true : undefined}><summary>Create a collection{selected.length > 0 ? ` (${selected.length} selected)` : ""}</summary><form onSubmit={event => void submit(event, "collection")}>
          <label>Name<input name="name" required maxLength={180} /></label>
          <p>Select files, notes, media, links, or clipboard entries in their modules to group them here.</p>
          {!!selected.length && <ol>{selected.map(id => <li key={id}>{label(id)}
            <Button variant="quiet" onClick={() => select(id, false)}>Remove from selection</Button></li>)}</ol>}
          <div><Button type="submit" disabled={disabled || !selected.length}>Create collection</Button></div>
        </form></details>}
      </div>
      <section aria-label={`Saved ${current.label.toLowerCase()}`} className="aerift-workspace-items">
        {entries && current && visible.length === 0 && <div className="aerift-empty-state"><SpatialIcon name="workspace" size={32} /><h4>A space for your {current.id === "photos" ? "media" : current.label.toLowerCase()}</h4><p>No saved {current.id === "photos" ? "media" : "items"} here yet. Add an object to keep it on this device.</p></div>}
        {selectedVisible.length > 0 && <div>
          <Button variant="quiet" disabled={disabled} onClick={() => removeObjects(selectedVisible)}>
            Remove selected ({selectedVisible.length})
          </Button>
        </div>}
        {visible.length > 0 && <ol>{visible.map(entry => {
          const { object } = entry;
          const captured = object.kind === "clipboard" ? items.find(item => item.object.id === object.objectId)?.object : undefined;
          return <li key={object.id} className="aerift-workspace-object" data-selected={selected.includes(object.id)}><div>
            <span className="aerift-object-glyph"><SpatialIcon name={object.kind === "url" ? "pair" : object.kind === "collection" ? "workspace" : "file"} size={24} /></span>
            <span className="aerift-object-kind">{object.kind}</span>
            {object.kind === "collection" ? <strong>{object.name}</strong> :
              <label className="aerift-check"><input type="checkbox" checked={selected.includes(object.id)}
                onChange={event => select(object.id, event.currentTarget.checked)} />{object.name}</label>}
            {object.kind === "note" && <p className="aerift-note-text">{object.text}</p>}
            {captured?.kind === "text" && <p className="aerift-note-text">{captured.text}</p>}
            {object.kind === "collection" && (object.itemIds.length
              ? <ol>{object.itemIds.map(id => <li key={id}>{label(id)}</li>)}</ol> : <p>This collection is empty.</p>)}
            <Popover label={`Actions for ${object.name}`} actions={[
              ...(entry.asset ? [{ id: "preview", label: preview === object.id ? "Close file details" : "File details",
                onSelect: () => setPreview(preview === object.id ? undefined : object.id) }] : []),
              ...(object.kind === "note" ? [{ id: "edit", label: "Edit note",
                onSelect: () => { setEditing(object.id); if (noteEditor.current) noteEditor.current.open = true; } }] : []),
              ...(object.kind === "url" ? [{ id: "open-link", label: "Open in browser", onSelect: () => {
                setError(undefined);
                void command<void>("open_workspace_url", { url: object.url }).then(result => {
                  if (!result.ok) setError("AeRift could not open the saved link in your browser.");
                });
              } }] : []),
              { id: "remove", label: "Remove", disabled, onSelect: () => removeObjects([object.id]) },
            ]} />
            {preview === object.id && <AssetPreview entry={entry} />}
          </div></li>;
        })}</ol>}
      </section>
    </div>}
  </div>;
}

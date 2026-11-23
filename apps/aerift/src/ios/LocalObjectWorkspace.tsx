import type { TransferWorkspaceRegions } from "@aerift/ui";
import { Button } from "@aerift/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { command } from "../nativeAppPort";
import type { FileSelection } from "@aerift/app-contract";
import {
  maxTextLength, normalWebUrl, portableCollection, portableText, removeMobileObject, type MobileObject,
} from "./local-objects";

export const localModules = ["notes", "browser", "clipboard", "collections"] as const;
export type LocalModule = typeof localModules[number];

type Entry = Exclude<MobileObject, { kind: "collection" }>;
type Collection = Extract<MobileObject, { kind: "collection" }>;

function newObject(name: string) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
  return { id, name, ownership: "local", schemaVersion: 1 } as const;
}

export function LocalObjectWorkspace({ module, objects, save, regions, openRift, clipboardSharing, markClipboardSelection }: {
  module: LocalModule;
  objects: readonly MobileObject[];
  save: (next: readonly MobileObject[]) => boolean;
  regions: TransferWorkspaceRegions;
  openRift: () => void;
  clipboardSharing: boolean;
  markClipboardSelection: (id: string) => void;
}) {
  const workspaceOpen = useRef(false);
  useLayoutEffect(() => {
    workspaceOpen.current = true;
    return () => { workspaceOpen.current = false; };
  }, []);
  const [imagePasteSupported, setImagePasteSupported] = useState<boolean>();
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [markdown, setMarkdown] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [member, setMember] = useState("");
  const [feedback, setFeedback] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState<string>();
  const notes = module === "notes";
  const browser = module === "browser";
  const clips = module === "clipboard";
  const collections = module === "collections";
  const kind = notes ? "note" : browser ? "url" : clips ? "text" : "collection";
  const entries = objects.filter(item => item.kind === kind);
  const selected = entries.find(item => item.id === editing);
  const candidates = objects.filter(item => item.kind !== "collection");

  useEffect(() => {
    if (!clips) return;
    let current = true;
    void command<boolean>("ios_clipboard_image_available").then(result => {
      if (current && result.ok) setImagePasteSupported(result.value);
    });
    return () => { current = false; };
  }, [clips]);

  function includesClipboard(object: MobileObject) {
    return object.kind === "text" || (object.kind === "collection" &&
      object.itemIds.some(id => candidates.some(item => item.id === id && item.kind === "text")));
  }

  async function pasteImage() {
    if (!clipboardSharing || !imagePasteSupported) return;
    let pasted = false;
    const selected = await regions.select(async () => {
      const result = await command<FileSelection | null>("stage_ios_clipboard_image");
      if (result.ok && result.value) {
        markClipboardSelection(result.value.selectionId);
        pasted = true;
      }
      return result;
    });
    if (pasted && selected && workspaceOpen.current) openRift();
  }

  function upsert(object: MobileObject) {
    return save(objects.some(item => item.id === object.id)
      ? objects.map(item => item.id === object.id ? object : item) : [object, ...objects]);
  }

  function reset() {
    setEditing(undefined);
    setTitle("");
    setDraft("");
    setMarkdown(false);
    setMember("");
  }

  function edit(object: MobileObject) {
    setEditing(object.id);
    setTitle(object.name);
    setDraft(object.kind === "url" ? object.url : "text" in object ? object.text : "");
    setMarkdown("format" in object && object.format === "markdown");
    setMember("");
    setFeedback("");
  }

  function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    const name = title.trim();
    const base = selected ? { id: selected.id, name, ownership: "local", schemaVersion: 1 } as const : newObject(name);
    let object: MobileObject;
    if (browser) {
      const url = normalWebUrl(draft);
      if (!url) { setFeedback("Enter a valid web address."); return; }
      object = { ...base, name: name || new URL(url).hostname, kind: "url", url };
    } else if (collections) {
      if (!name) return;
      object = { ...base, kind: "collection", itemIds: selected?.kind === "collection" ? selected.itemIds : [] };
    } else {
      if (!name || !draft.trim()) return;
      object = { ...base, kind: notes ? "note" : "text", format: notes && markdown ? "markdown" : "plain", text: draft };
    }
    if (upsert(object)) {
      if (collections) edit(object);
      else reset();
      setFeedback("Saved on this iPhone.");
    }
  }

  async function browse(value: string) {
    const url = normalWebUrl(value);
    if (!url) { setFeedback("Enter a valid web address."); return; }
    const result = await command("open_ios_browser", { url });
    setFeedback(result.ok ? "" : "The browser couldn't open this address.");
  }

  async function stage(object: Entry | Collection) {
    const clipboardCopy = includesClipboard(object);
    if (clipboardCopy && !clipboardSharing) return;
    const payload = object.kind === "collection" ? portableCollection(object, objects) : portableText(object);
    if (!payload) {
      setFeedback("This collection is too large to send as one file. Remove some items and try again.");
      return;
    }
    const result = await regions.select(async () => {
      const result = await command<FileSelection | null>("stage_ios_text", payload);
      if (clipboardCopy && result.ok && result.value) markClipboardSelection(result.value.selectionId);
      return result.ok && !result.value ? { ok: false, error: { code: "storage_failed" } } : result;
    });
    if (result && workspaceOpen.current) openRift();
  }

  function updateMembers(collection: Collection, itemIds: readonly string[]) {
    if (upsert({ ...collection, itemIds })) setFeedback("Collection updated.");
  }

  function move(collection: Collection, index: number, direction: -1 | 1) {
    const next = [...collection.itemIds];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    updateMembers(collection, next);
  }

  return <section className="ios-section ios-object-editor" aria-label={module}>
    {notes && <p>Save plain text or Markdown on this iPhone. Send a copy through Rift.</p>}
    {browser && <p>Open a page in Safari’s in-app browser or collect its address to send later.</p>}
    {clips && <>
      <p>Use the system Paste menu for text. AeRift keeps text only when you pin it.</p>
      {imagePasteSupported === true &&
        <Button disabled={!regions.canSelect || !clipboardSharing} onClick={() => void pasteImage()}>Paste image for Rift</Button>}
      {imagePasteSupported === false && <p>Image paste requires iOS 16 or later.</p>}
      {!clipboardSharing && <p>Enable clipboard sharing in Control Center to send a copy.</p>}
    </>}
    {collections && <p>Group saved notes, links and pinned text. A transfer copy contains the saved items in one text file.</p>}
    <form className="ios-object-form" onSubmit={saveDraft}>
      <label><span>{browser ? "Link label (optional)" : "Name"}</span>
        <input value={title} required={!browser} maxLength={100} onChange={event => setTitle(event.currentTarget.value)} />
      </label>
      {browser ? <label><span>Address</span><input value={draft} required maxLength={4000}
        inputMode="url" autoCapitalize="none" spellCheck={false} onChange={event => setDraft(event.currentTarget.value)} /></label>
        : !collections && <label><span>{clips ? "Text to pin" : "Note"}</span>
          <textarea value={draft} required rows={4} maxLength={maxTextLength}
            onChange={event => setDraft(event.currentTarget.value)} /></label>}
      {notes && <label className="ios-check"><input type="checkbox" checked={markdown}
        onChange={event => setMarkdown(event.currentTarget.checked)} />Save as Markdown</label>}
      <div className="ae-actions">
        <Button type="submit">{editing ? "Save changes" : clips ? "Pin text" : browser ? "Collect link" :
          collections ? "Create collection" : "Save note"}</Button>
        {browser && <Button variant="quiet" disabled={!draft.trim()} onClick={() => void browse(draft)}>Open page</Button>}
        {editing && <Button variant="quiet" onClick={reset}>Done editing</Button>}
      </div>
    </form>
    {selected?.kind === "collection" && <div className="ios-collection">
      <h4>Collection contents</h4>
      <ol className="ios-list">
        {selected.itemIds.map((id, index) => {
          const item = candidates.find(entry => entry.id === id);
          if (!item) return null;
          return <li key={id}>
            <strong>{item.name}</strong>
            <div className="ae-actions">
              <Button variant="quiet" aria-label={`Move ${item.name} up`} disabled={index === 0}
                onClick={() => move(selected, index, -1)}>↑</Button>
              <Button variant="quiet" aria-label={`Move ${item.name} down`} disabled={index === selected.itemIds.length - 1}
                onClick={() => move(selected, index, 1)}>↓</Button>
              <Button variant="quiet" aria-label={`Remove ${item.name} from collection`}
                onClick={() => updateMembers(selected, selected.itemIds.filter(memberId => memberId !== id))}>Remove</Button>
            </div>
          </li>;
        })}
      </ol>
      <label className="ios-add-member">Add an item <select value={member} onChange={event => setMember(event.currentTarget.value)}>
        <option value="">Choose a saved item</option>
        {candidates.filter(item => !selected.itemIds.includes(item.id)).map(item =>
          <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <Button disabled={!member} onClick={() => { updateMembers(selected, [...selected.itemIds, member]); setMember(""); }}>Add</Button>
    </div>}
    {feedback && <p role="status">{feedback}</p>}
    {entries.length > 0 && <ul className="ios-object-list">
      {entries.map(object => <li key={object.id}>
        <strong>{object.name}</strong>
        {object.kind === "collection" ? <small>{object.itemIds.length} saved items</small> :
          object.kind === "url" ? <small>{new URL(object.url).hostname}</small> :
          <small className="ios-preview">{object.kind === "text" ? "Pinned text" : object.text.slice(0, 180)}</small>}
        {object.kind === "collection" && includesClipboard(object) && !clipboardSharing &&
          <small>Enable clipboard sharing to offer the pinned text in this collection.</small>}
        <div className="ae-actions">
          {object.kind === "collection" ?
            <Button disabled={!regions.canSelect || !object.itemIds.length || (includesClipboard(object) && !clipboardSharing)} onClick={() => void stage(object)}>Send collection copy</Button> :
            <Button disabled={!regions.canSelect || (includesClipboard(object) && !clipboardSharing)} onClick={() => void stage(object)}>Send copy</Button>}
          {object.kind === "url" && <Button variant="quiet" onClick={() => void browse(object.url)}>Open</Button>}
          <Button variant="quiet" onClick={() => edit(object)}>Edit</Button>
          {confirmRemoval === object.id ? <>
            <Button variant="danger" onClick={() => {
              if (save(removeMobileObject(objects, object.id))) {
                if (editing === object.id) reset();
                setConfirmRemoval(undefined);
                setFeedback("Removed from this iPhone.");
              }
            }}>Remove {object.name}</Button>
            <Button variant="quiet" onClick={() => setConfirmRemoval(undefined)}>Keep</Button>
          </> : <Button variant="quiet" onClick={() => setConfirmRemoval(object.id)}>Remove</Button>}
        </div>
      </li>)}
    </ul>}
  </section>;
}

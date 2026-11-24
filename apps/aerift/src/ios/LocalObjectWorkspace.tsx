import type { TransferWorkspaceRegions } from "@aerift/ui";
import { Button } from "@aerift/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { command } from "../nativeAppPort";
import type { FileSelection } from "@aerift/app-contract";
import type { ObservedMediaPort } from "./mobile-media-observer";
import type { ImportedMedia } from "./mobile-media";
import {
  addBrowserLinks, maxTextLength, normalWebUrl, portableCollection, portableText, removeMobileObject, type BrowserLink, type MobileObject,
} from "./local-objects";

export const localModules = ["notes", "browser", "clipboard", "collections"] as const;
export type LocalModule = typeof localModules[number];

type Entry = Exclude<MobileObject, { kind: "collection" }>;
type Collection = Extract<MobileObject, { kind: "collection" }>;

function newObject(name: string) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
  return { id, name, ownership: "local", schemaVersion: 1 } as const;
}

export function LocalObjectWorkspace({ module, objects, save, regions, openRift, media, clipboardSharing, markClipboardSelection }: {
  module: LocalModule;
  objects: readonly MobileObject[];
  save: (next: readonly MobileObject[]) => boolean;
  regions: TransferWorkspaceRegions;
  openRift: () => void;
  media: ObservedMediaPort;
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
  const [attachmentIds, setAttachmentIds] = useState<readonly string[]>([]);
  const [pendingAttachment, setPendingAttachment] = useState("");
  const [mediaItems, setMediaItems] = useState<readonly ImportedMedia[]>();
  const [mediaFailed, setMediaFailed] = useState(false);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState<string>();
  const [composerOpen, setComposerOpen] = useState(false);
  const notes = module === "notes";
  const browser = module === "browser";
  const clips = module === "clipboard";
  const collections = module === "collections";
  const kind = notes ? "note" : browser ? "url" : clips ? "text" : "collection";
  const entries = objects.filter(item => item.kind === kind);
  const selected = entries.find(item => item.id === editing);
  const candidates = objects.filter(item => item.kind !== "collection");

  useEffect(() => {
    if (!notes) return;
    let active = true;
    setMediaFailed(false);
    const unsubscribe = media.subscribe(items => {
      setMediaItems(items);
      setMediaFailed(false);
    });
    void media.list().then(result => {
      if (!active) return;
      if (result.ok) setMediaItems(result.value);
      else setMediaFailed(true);
    }).catch(() => {
      if (active) setMediaFailed(true);
    });
    return () => { active = false; unsubscribe(); };
  }, [media, mediaRetry, notes]);

  const mediaById = new Map(mediaItems?.map(item => [item.id, item]));
  const attachmentOptions = mediaItems?.filter(item => !attachmentIds.includes(item.id));

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
    setAttachmentIds([]);
    setPendingAttachment("");
  }

  function edit(object: MobileObject) {
    setComposerOpen(true);
    setEditing(object.id);
    setTitle(object.name);
    setDraft(object.kind === "url" ? object.url : "text" in object ? object.text : "");
    setMarkdown("format" in object && object.format === "markdown");
    setAttachmentIds(object.kind === "note" ? object.attachmentIds ?? [] : []);
    setPendingAttachment("");
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
      object = notes
        ? { ...base, kind: "note", format: markdown ? "markdown" : "plain", text: draft,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}) }
        : { ...base, kind: "text", format: "plain", text: draft };
    }
    if (upsert(object)) {
      if (collections) edit(object);
      else reset();
      setFeedback("Saved on this iPhone.");
    }
  }

  async function browse(value: string) {
    if (browsing) return;
    const url = normalWebUrl(value);
    if (!url) { setFeedback("Enter a valid web address."); return; }
    setFeedback("");
    setBrowsing(true);
    const result = await command<BrowserLink[]>("open_ios_browser", { url });
    setBrowsing(false);
    if (!result.ok) {
      setFeedback("The browser couldn't open this address.");
      return;
    }
    const next = addBrowserLinks(objects, result.value, () => newObject("").id);
    const added = next.length - objects.length;
    if (added > 0 && save(next)) setFeedback(added === 1 ? "Link collected." : `${added} links collected.`);
    else if (result.value.length > 0 && added === 0) setFeedback("These links are already saved.");
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

  async function previewAttachment(item: ImportedMedia) {
    setPreviewing(true);
    setFeedback("");
    try {
      const result = await media.present(item.assetId, "preview");
      if (!result.ok) setFeedback("Quick Look couldn’t preview this attachment.");
    } catch {
      setFeedback("Quick Look couldn’t preview this attachment.");
    } finally {
      setPreviewing(false);
    }
  }

  async function selectAttachment(item: ImportedMedia) {
    setFeedback("");
    const result = await regions.select(() => media.select(item.assetId));
    if (result && workspaceOpen.current) openRift();
  }

  function attachmentLabel(id: string, index: number) {
    return mediaById.get(id)?.name ?? `Attachment ${index + 1}`;
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
    {notes && <p>Save plain text or Markdown and attach imported files, photos, or videos.</p>}
    {browser && <p>In the in-app browser, choose Share → Collect in AeRift, then Done. You can also enter an address here.</p>}
    {clips && <>
      <p>Use the system Paste menu for text. AeRift keeps text only when you pin it.</p>
      {imagePasteSupported === true &&
        <Button disabled={!regions.canSelect || !clipboardSharing} onClick={() => void pasteImage()}>Paste image for Rift</Button>}
      {imagePasteSupported === false && <p>Image paste requires iOS 16 or later.</p>}
      {!clipboardSharing && <p>Enable clipboard sharing in Control Center to send a copy.</p>}
    </>}
    {collections && <p>Group saved notes, links and pinned text. A transfer copy contains the saved items in one text file.</p>}
    <details className="ios-object-composer" open={composerOpen} onToggle={event => setComposerOpen(event.currentTarget.open)}>
    <summary>{editing ? "Edit saved item" : notes ? "New note" : browser ? "Add an address" : clips ? "New text pin" : "New collection"}</summary>
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
      {notes && <fieldset className="ios-object-form ios-note-attachments">
        <legend>Attachments</legend>
        {attachmentIds.length > 0 && <ol className="ios-list">
          {attachmentIds.map((id, index) => <li key={id}>
            {attachmentLabel(id, index)}
            {mediaItems && !mediaFailed && !mediaById.has(id) && <small> · Imported copy unavailable</small>}
            <Button type="button" variant="quiet" aria-label={`Detach ${attachmentLabel(id, index)}`}
              onClick={() => setAttachmentIds(ids => ids.filter(candidate => candidate !== id))}>Detach</Button>
          </li>)}
        </ol>}
        {mediaFailed ? <Button type="button" variant="quiet"
          onClick={() => setMediaRetry(attempt => attempt + 1)}>Retry loading imported copies</Button>
          : !mediaItems ? <p>Loading imported copies…</p>
          : attachmentOptions?.length ? <>
            <label htmlFor="ios-note-attachment">Imported copy</label>
            <select id="ios-note-attachment" value={pendingAttachment}
              onChange={event => setPendingAttachment(event.currentTarget.value)}>
              <option value="">Choose a file, photo, or video</option>
              {attachmentOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <Button type="button" variant="quiet"
              disabled={!attachmentOptions.some(item => item.id === pendingAttachment)}
              onClick={() => {
                setAttachmentIds(ids => ids.includes(pendingAttachment) ? ids : [...ids, pendingAttachment]);
                setPendingAttachment("");
              }}>Attach</Button>
          </> : <p>{mediaItems.length ? "All imported copies are attached."
            : "Import a copy from Files or Photos and videos to attach it."}</p>}
      </fieldset>}
      <div className="ae-actions">
        <Button type="submit">{editing ? "Save changes" : clips ? "Pin text" : browser ? "Collect link" :
          collections ? "Create collection" : "Save note"}</Button>
        {browser && <Button variant="quiet" disabled={browsing || !draft.trim()} onClick={() => void browse(draft)}>Open page</Button>}
        {editing && <Button variant="quiet" onClick={reset}>Done editing</Button>}
      </div>
    </form>
    </details>
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
        {object.kind === "note" && !!object.attachmentIds?.length && <details>
          <summary>{object.attachmentIds.length === 1 ? "1 attachment" : `${object.attachmentIds.length} attachments`}</summary>
          <ol className="ios-list">
            {object.attachmentIds.map((id, index) => {
              const item = mediaById.get(id);
              return <li key={id}>
                <strong>{attachmentLabel(id, index)}</strong>
                {item ? <div className="ae-actions">
                  <Button variant="quiet" disabled={previewing} onClick={() => void previewAttachment(item)}>Preview</Button>
                  <Button variant="quiet" disabled={!regions.canSelect}
                    onClick={() => void selectAttachment(item)}>Select for Rift</Button>
                </div> : <small>{mediaFailed ? "Imported copies couldn’t load" : mediaItems
                  ? "Imported copy unavailable" : "Loading imported copy…"}</small>}
              </li>;
            })}
          </ol>
        </details>}
        <div className="ae-actions">
          {object.kind === "collection" ?
            <Button disabled={!regions.canSelect || !object.itemIds.length || (includesClipboard(object) && !clipboardSharing)} onClick={() => void stage(object)}>Send collection copy</Button> :
            <Button disabled={!regions.canSelect || (includesClipboard(object) && !clipboardSharing)} onClick={() => void stage(object)}>
              {object.kind === "note" && object.attachmentIds?.length ? "Send note text" : "Send copy"}
            </Button>}
          {object.kind === "url" && <Button variant="quiet" disabled={browsing} onClick={() => void browse(object.url)}>Open</Button>}
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

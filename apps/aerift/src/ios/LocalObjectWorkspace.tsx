import type { TransferWorkspaceRegions } from "@aerift/ui";
import { Button } from "@aerift/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { WorkspaceNoteEditor, WorkspaceNoteSearch } from "../WorkspaceNoteTools";
import { WorkspaceBrowserTools } from "../WorkspaceBrowserTools";
import { readWorkspaceBrowserHistory, recordWorkspaceBrowserLaunch } from "../workspace-browser-tools";
import { matchesWorkspaceNote, type NoteFilter } from "../workspace-note-tools";
import type { MobileOperations, MobilePlatformCopy } from "./mobile-platform";
import type { ObservedMediaPort } from "./mobile-media-observer";
import type { ImportedMedia } from "./mobile-media";
import {
  addBrowserLinks, maxTextLength, normalWebUrl, portableCollection, portableText, removeMobileObject, type MobileObject,
} from "./local-objects";

export const localModules = ["notes", "browser", "clipboard", "collections"] as const;
export type LocalModule = typeof localModules[number];

type Entry = Exclude<MobileObject, { kind: "collection" }>;
type Collection = Extract<MobileObject, { kind: "collection" }>;
const browserHistoryKey = "aerift.mobile.workspace.browser-history.v1";

function newObject(name: string) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
  return { id, name, ownership: "local", schemaVersion: 1 } as const;
}

export function LocalObjectWorkspace({ module, objects, save, regions, openRift, media, clipboardSharing, markClipboardSelection, operations, copy }: {
  module: LocalModule;
  objects: readonly MobileObject[];
  save: (next: readonly MobileObject[]) => boolean;
  regions: TransferWorkspaceRegions;
  openRift: () => void;
  media: ObservedMediaPort;
  clipboardSharing: boolean;
  markClipboardSelection: (id: string) => void;
  operations: MobileOperations;
  copy: MobilePlatformCopy;
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
  const [noteFilter, setNoteFilter] = useState<NoteFilter>({ query: "", format: "any" });
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
  const [justAdded, setJustAdded] = useState<string>();
  const [confirmRemoval, setConfirmRemoval] = useState<string>();
  const [composerOpen, setComposerOpen] = useState(false);
  const notes = module === "notes";
  const browser = module === "browser";
  const clips = module === "clipboard";
  const collections = module === "collections";
  const kind = notes ? "note" : browser ? "url" : clips ? "text" : "collection";
  const entries = objects.filter(item => item.kind === kind);
  const visibleEntries = notes ? entries.filter(item => item.kind === "note" && matchesWorkspaceNote(item, noteFilter)) : entries;
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
    void operations.clipboardImageAvailable().then(result => {
      if (current && result.ok) setImagePasteSupported(result.value);
    });
    return () => { current = false; };
  }, [clips, operations]);

  function includesClipboard(object: MobileObject) {
    return object.kind === "text" || (object.kind === "collection" &&
      object.itemIds.some(id => candidates.some(item => item.id === id && item.kind === "text")));
  }

  async function pasteImage() {
    if (!clipboardSharing || !imagePasteSupported) return;
    let pasted = false;
    const selected = await regions.select(async () => {
      const result = await operations.stageClipboardImage();
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
      if (!selected) setJustAdded(object.id);
      if (collections) edit(object);
      else reset();
      setFeedback(`Saved on ${copy.device}.`);
    }
  }

  async function browse(value: string, saved = false): Promise<boolean> {
    if (browsing) return false;
    const url = normalWebUrl(value);
    if (!url) { setFeedback("Enter a valid web address."); return false; }
    const remember = saved && readWorkspaceBrowserHistory(browserHistoryKey).enabled;
    setFeedback("");
    setBrowsing(true);
    try {
      const result = await operations.openBrowser(url);
      if (!result.ok) {
        setFeedback("The browser couldn't open this address.");
        return false;
      }
      const next = addBrowserLinks(objects, result.value, () => newObject("").id);
      const added = next.length - objects.length;
      if (added > 0 && save(next)) setFeedback(added === 1 ? "Link collected." : `${added} links collected.`);
      else if (result.value.length > 0 && added === 0) setFeedback("These links are already saved.");
      if (remember && !recordWorkspaceBrowserLaunch(browserHistoryKey, url)) {
        setFeedback("The page opened, but AeRift could not save this visit.");
      }
      return true;
    } catch {
      setFeedback("The browser couldn't open this address.");
      return false;
    } finally {
      setBrowsing(false);
    }
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
      const result = await operations.stageText(payload);
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
      if (!result.ok) setFeedback(`${copy.previewer} couldn’t preview this attachment.`);
    } catch {
      setFeedback(`${copy.previewer} couldn’t preview this attachment.`);
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

  return <section className="ae-surface ios-section ios-object-editor aw-focused-surface" data-material="content" aria-label={module}>
    {notes && <WorkspaceNoteSearch filter={noteFilter} onChange={setNoteFilter} count={visibleEntries.length} />}
    {browser && <WorkspaceBrowserTools storageKey={browserHistoryKey} onOpen={browse} disabled={browsing}
      labels={{ description: copy.browserTip }} />}
    {clips && <>
      <p>Use the system Paste menu for text. AeRift keeps text only when you pin it.</p>
      {imagePasteSupported === true &&
        <Button disabled={!regions.canSelect || !clipboardSharing} onClick={() => void pasteImage()}>Paste image for Rift</Button>}
      {imagePasteSupported === false && <p>{copy.clipboardImageUnavailable}</p>}
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
        : notes ? <WorkspaceNoteEditor key={editing ?? "new"} value={draft}
          format={markdown ? "markdown" : "plain"} onChange={setDraft} onFormat={format => setMarkdown(format === "markdown")} />
        : !collections && <label><span>Text to pin</span>
          <textarea value={draft} required rows={4} maxLength={maxTextLength}
            onChange={event => setDraft(event.currentTarget.value)} /></label>}
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
    {notes && !visibleEntries.length && <p>{entries.length ? "No notes match your search." : "Start with a new note."}</p>}
    {visibleEntries.length > 0 && <ul className="ios-object-list">
      {visibleEntries.map(object => <li key={object.id} data-ae-route-enter={justAdded === object.id ? "neutral" : undefined}>
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
          {object.kind === "url" && <Button variant="quiet" disabled={browsing} onClick={() => void browse(object.url, true)}>Open</Button>}
          <Button variant="quiet" onClick={() => edit(object)}>Edit</Button>
          {confirmRemoval === object.id ? <div className="ae-actions" data-ae-route-enter="neutral">
            <Button variant="danger" onClick={() => {
              if (save(removeMobileObject(objects, object.id))) {
                if (editing === object.id) reset();
                setConfirmRemoval(undefined);
                setFeedback(`Removed from ${copy.device}.`);
              }
            }}>Remove {object.name}</Button>
            <Button variant="quiet" onClick={() => setConfirmRemoval(undefined)}>Keep</Button>
          </div> : <Button variant="quiet" onClick={() => setConfirmRemoval(object.id)}>Remove</Button>}
        </div>
      </li>)}
    </ul>}
  </section>;
}

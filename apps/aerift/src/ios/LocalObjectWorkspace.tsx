import type { TransferWorkspaceRegions } from "@aerift/ui";
import { Button } from "@aerift/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NoteIconButton } from "../WorkspaceNoteTools";
import { DesktopNotesWorkspace } from "../windows/DesktopNotesWorkspace";
import { MobileNoteAttachments } from "./MobileNoteAttachments";
import { WorkspaceBrowserTools } from "../WorkspaceBrowserTools";
import { useWorkspaceClipboardTools, WorkspaceClipboardCopy, WorkspaceClipboardDetails, WorkspaceClipboardTools } from "../WorkspaceClipboardTools";
import { WorkspaceCollectionsGallery } from "../WorkspaceCollectionsGallery";
import { useCollectionGalleryAppearance } from "../useCollectionGalleryAppearance";
import { availableCollectionMembers, selectedCollectionMembers, canUpdateCollectionMembers, collectionIncludesClipboard } from "../collection-gallery-adapter";
import { readWorkspaceBrowserHistory, recordWorkspaceBrowserLaunch } from "../workspace-browser-tools";
import { mobilePlatformCopy, type MobileOperations, type MobilePlatformCopy } from "./mobile-platform";
import type { ObservedMediaPort } from "./mobile-media-observer";
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
  const [editing, setEditing] = useState<string>();
  const clipboardTools = useWorkspaceClipboardTools({ copyAllowed: clipboardSharing });
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
  const visibleEntries = clips ? clipboardTools.browse(entries, item => item.kind === "text" ? item : undefined) : entries;
  const selected = entries.find(item => item.id === editing);
  const candidates = objects.filter(item => item.kind !== "collection");
  const collectionRows = collections
    ? entries.flatMap(item => item.kind === "collection" ? [{ id: item.id, name: item.name, memberIds: item.itemIds }] : [])
    : [];
  const availableMembers = availableCollectionMembers(candidates);
  const clipboardIds = new Set(candidates.filter(item => item.kind === "text").map(item => item.id));
  const collectionAppearance = useCollectionGalleryAppearance(
    copy.device === mobilePlatformCopy.android.device ? "android" : "ios", collections ? collectionRows.map(row => row.id) : undefined);
  const stagingCollection = useRef(false);
  const [preparingCollection, setPreparingCollection] = useState(false);

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
      collectionIncludesClipboard(object.itemIds, clipboardIds));
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
  }

  function edit(object: MobileObject) {
    setComposerOpen(true);
    setEditing(object.id);
    setTitle(object.name);
    setDraft(object.kind === "url" ? object.url : "text" in object ? object.text : "");
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
    } else {
      if (!name || !draft.trim()) return;
      object = { ...base, kind: "text", format: "plain", text: draft };
    }
    if (upsert(object)) {
      if (!selected) setJustAdded(object.id);
      reset();
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

  function createCollection(name: string, initialIds: readonly string[]) {
    const object: Collection = { ...newObject(name), kind: "collection", itemIds: selectedCollectionMembers(initialIds, availableMembers) };
    return upsert(object) ? object.id : null;
  }

  function renameCollection(id: string, name: string) {
    const object = objects.find(item => item.id === id);
    return object?.kind === "collection" && upsert({ ...object, name });
  }

  function updateCollection(id: string, next: readonly string[], previous: readonly string[]) {
    const object = objects.find(item => item.id === id);
    return object?.kind === "collection" && canUpdateCollectionMembers(object.itemIds, next, previous, availableMembers) &&
      upsert({ ...object, itemIds: next });
  }

  async function sendCollection(id: string) {
    if (stagingCollection.current || !regions.canSelect) return;
    const item = objects.find(value => value.id === id);
    if (item?.kind !== "collection" || !item.itemIds.length || (includesClipboard(item) && !clipboardSharing)) return;
    stagingCollection.current = true;
    setPreparingCollection(true); setFeedback("");
    try { await stage(item); }
    catch { if (workspaceOpen.current) setFeedback("AeRift couldn't prepare this collection for Rift."); }
    finally {
      stagingCollection.current = false;
      if (workspaceOpen.current) setPreparingCollection(false);
    }
  }

  if (collections) return <>
    <p>Group saved notes, links and pinned text. A transfer copy contains the saved items in one text file.</p>
    <WorkspaceCollectionsGallery collections={collectionRows} objects={candidates}
      appearance={collectionAppearance.appearance} onPersistAppearance={collectionAppearance.persist}
      disabled={!collectionAppearance.ready || preparingCollection}
      onCreate={createCollection} onRename={renameCollection} onChangeMembers={updateCollection}
      onRemove={id => collectionRows.some(row => row.id === id) && save(removeMobileObject(objects, id))}
      collectionActions={row => {
        const clipboardBlocked = !clipboardSharing && collectionIncludesClipboard(row.memberIds, clipboardIds);
        return <>
          <NoteIconButton label="Send collection copy to Rift" icon="send"
            disabled={!regions.canSelect || !row.memberIds.length || clipboardBlocked || preparingCollection}
            onClick={() => void sendCollection(row.id)} />
          {clipboardBlocked && <small>Enable clipboard sharing to offer the pinned text in this collection.</small>}
        </>;
      }} />
    {feedback && <p role="status">{feedback}</p>}
  </>;

  if (notes) return <><DesktopNotesWorkspace variant="mobile" titleLimit={100}
    notes={objects.filter(item => item.kind === "note")} disabled={false}
    onSave={async note => upsert(note)} onRemove={async id => save(removeMobileObject(objects, id))}
    onBack={() => {}} heading={() => null}
    noteActions={note => <NoteIconButton label="Send saved note to Rift" icon="send" disabled={!regions.canSelect}
      onClick={() => void stage(note)} />}
    attachments={(ids, onChange, disabled) => <MobileNoteAttachments ids={ids} onChange={onChange}
      media={media} regions={regions} openRift={openRift} copy={copy} disabled={disabled} />}
  />{feedback && <p role="status">{feedback}</p>}</>;
  return <section className="ae-surface ios-section ios-object-editor aw-focused-surface" data-material="content" aria-label={module}>
    {browser && <WorkspaceBrowserTools storageKey={browserHistoryKey} onOpen={browse} disabled={browsing}
      labels={{ description: copy.browserTip }} />}
    {clips && <>
      <p>Use the system Paste menu for text. AeRift keeps text only when you pin it.</p>
      <WorkspaceClipboardTools tools={clipboardTools} count={visibleEntries.length} total={entries.length} />
      {imagePasteSupported === true &&
        <Button disabled={!regions.canSelect || !clipboardSharing} onClick={() => void pasteImage()}>Paste image for Rift</Button>}
      {imagePasteSupported === false && <p>{copy.clipboardImageUnavailable}</p>}
      {!clipboardSharing && <p>Enable clipboard sharing in Control Center to send a copy.</p>}
    </>}
    <details className="ios-object-composer" open={composerOpen} onToggle={event => setComposerOpen(event.currentTarget.open)}>
    <summary>{editing ? "Edit saved item" : notes ? "New note" : browser ? "Add an address" : "New text pin"}</summary>
    <form className="ios-object-form" onSubmit={saveDraft}>
      <label><span>{browser ? "Link label (optional)" : "Name"}</span>
        <input value={title} required={!browser} maxLength={100} onChange={event => setTitle(event.currentTarget.value)} />
      </label>
      {browser ? <label><span>Address</span><input value={draft} required maxLength={4000}
        inputMode="url" autoCapitalize="none" spellCheck={false} onChange={event => setDraft(event.currentTarget.value)} /></label>
        : <label><span>Text to pin</span>
          <textarea value={draft} required rows={4} maxLength={maxTextLength}
            onChange={event => setDraft(event.currentTarget.value)} /></label>}
      <div className="ae-actions">
        <Button type="submit">{editing ? "Save changes" : clips ? "Pin text" : "Collect link"}</Button>
        {editing && <Button variant="quiet" onClick={reset}>Done editing</Button>}
      </div>
    </form>
    </details>
    {feedback && <p role="status">{feedback}</p>}
    {visibleEntries.length > 0 && <ul className="ios-object-list">
      {visibleEntries.map(object => <li key={object.id} data-ae-route-enter={justAdded === object.id ? "neutral" : undefined}>
        <strong>{object.name}</strong>
        {object.kind === "url" ? <small>{new URL(object.url).hostname}</small> :
          <small className="ios-preview">{object.kind === "text" ? "Pinned text" : object.kind === "note" ? object.text.slice(0, 180) : ""}</small>}
        {object.kind === "text" && <WorkspaceClipboardDetails text={object.text} format={object.format} />}
        <div className="ae-actions">
          {object.kind !== "collection" && <Button disabled={!regions.canSelect || (includesClipboard(object) && !clipboardSharing)} onClick={() => void stage(object)}>
            {object.kind === "note" && object.attachmentIds?.length ? "Send note text" : "Send copy"}
          </Button>}
          {object.kind === "text" && <WorkspaceClipboardCopy tools={clipboardTools} name={object.name} text={object.text} />}
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

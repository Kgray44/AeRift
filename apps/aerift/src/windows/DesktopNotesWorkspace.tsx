import type { DigitalObject } from "@aerift/app-contract/digital-objects";
import { GlassSurface, IconAction, SpatialIcon } from "@aerift/ui";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { NoteIconButton, WorkspaceNoteEditor } from "../WorkspaceNoteTools";
import { workspaceNoteLimit } from "../workspace-note-tools";
import {
  createDesktopNoteCategory, loadDesktopNoteLibrary, removeDesktopNoteCategory, removeDesktopNoteMetadata,
  renameDesktopNoteCategory, saveDesktopNoteLibrary, setDesktopNoteCategory, sortDesktopNotes, touchDesktopNote,
  type DesktopNoteLibrary,
} from "../desktop-note-library";
import { DesktopNotesSidebar, type DesktopNotesScope } from "./DesktopNotesSidebar";
import "./desktop-notes-workspace.css";

type Note = Extract<DigitalObject, { kind: "note" }>;
type Draft = { id: string; name: string; text: string; format: Note["format"]; category: string | null; attachmentIds: readonly string[] };
const defaultTitleLimit = 180;

function localNoteId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
}

function metadataStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

function fromNote(note: Note, category?: string): Draft {
  return { id: note.id, name: note.name, text: note.text, format: note.format, category: category ?? null, attachmentIds: note.attachmentIds ?? [] };
}

function noteTitle(draft: Draft, titleLimit: number) {
  return (draft.name.trim() || draft.text.split(/\r?\n/u).find(line => line.trim())?.trim() || "").slice(0, titleLimit);
}

export function DesktopNotesWorkspace({ notes, disabled, onSave, onRemove, onBack, heading, collectionSelection = [], onCollectionSelect,
  variant = "desktop", titleLimit = defaultTitleLimit, noteActions, attachments }: {
  notes: readonly Note[]; disabled: boolean;
  onSave: (note: Note) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onBack: () => void;
  heading: (back: () => void) => ReactNode;
  collectionSelection?: readonly string[];
  onCollectionSelect?: (id: string, active: boolean) => void;
  variant?: "desktop" | "mobile";
  titleLimit?: number;
  noteActions?: (note: Note) => ReactNode;
  attachments?: (ids: readonly string[], onChange: (ids: readonly string[]) => void, disabled: boolean) => ReactNode;
}) {
  const [library, updateLibrary] = useState(() => loadDesktopNoteLibrary(metadataStorage()));
  const latestLibrary = useRef(library);
  const [scope, setScope] = useState<DesktopNotesScope>({ kind: "all" });
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const processing = useRef(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [categoryForm, setCategoryForm] = useState<{ id?: string; name: string }>();
  const [removeCategory, setRemoveCategory] = useState(false);
  const [removeNote, setRemoveNote] = useState(false);
  const [leave, setLeave] = useState<(() => void)>();
  const title = useRef<HTMLInputElement>(null);
  const requestFocus = useRef(false);
  const saved = notes.find(note => note.id === draft?.id);
  const dirty = !!draft && (!saved
    ? !!(draft.name.trim() || draft.text)
    : [draft.name !== saved.name, draft.text !== saved.text, draft.format !== saved.format,
      draft.category !== (library.memberships[draft.id] ?? null),
      draft.attachmentIds.length !== (saved.attachmentIds?.length ?? 0),
      draft.attachmentIds.some((id, index) => id !== saved.attachmentIds?.[index])].some(Boolean));
  const category = scope.kind === "category" ? library.categories.find(item => item.id === scope.id) : undefined;
  const rows = sortDesktopNotes(notes, library, note => note.id).map(note => ({
    id: note.id,
    title: note.name,
    snippet: note.text.replace(/\s+/gu, " ").slice(0, 120),
    searchText: note.text,
    updatedAt: Date.parse(library.modifiedAt[note.id] ?? "") || 0,
    categoryId: library.memberships[note.id] ?? null,
  }));

  useEffect(() => {
    if (!draft?.id || !requestFocus.current) return;
    title.current?.focus();
    requestFocus.current = false;
  }, [draft?.id]);

  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  function persist(next: DesktopNoteLibrary) {
    if (next === latestLibrary.current) return true;
    if (!saveDesktopNoteLibrary(metadataStorage(), next, latestLibrary.current)) {
      setError("Could not save category or recent activity on this device.");
      return false;
    }
    latestLibrary.current = next;
    updateLibrary(next);
    return true;
  }

  function switchEditor(next: () => void) {
    if (processing.current) return;
    if (dirty) { setLeave(() => next); return; }
    next();
  }

  function newNote() {
    switchEditor(() => {
      requestFocus.current = true;
      setFeedback(""); setError(""); setRemoveNote(false);
      setDraft({ id: localNoteId(), name: "", text: "", format: "plain", category: category?.id ?? null, attachmentIds: [] });
    });
  }

  function chooseNote(id: string) {
    if (draft?.id === id) return;
    switchEditor(() => {
      const note = notes.find(item => item.id === id);
      if (!note) return;
      setFeedback(""); setError(""); setRemoveNote(false);
      setDraft(fromNote(note, library.memberships[note.id]));
    });
  }

  async function saveNote(then?: () => void) {
    if (!draft || processing.current || disabled) return;
    const name = noteTitle(draft, titleLimit);
    if (!name || !draft.text.trim() || draft.text.length > workspaceNoteLimit) {
      setError("Write some note text before saving.");
      return;
    }
    const pending: Note = { id: draft.id, kind: "note", ownership: "local", schemaVersion: 1, name,
      text: draft.text, format: draft.format, ...(draft.attachmentIds.length ? { attachmentIds: draft.attachmentIds } : {}) };
    setError(""); setFeedback("");
    processing.current = true; setBusy(true);
    try {
      if (!await onSave(pending)) { setError("Could not save the note. Your draft is still open."); return; }
      const next = touchDesktopNote(setDesktopNoteCategory(latestLibrary.current, pending.id, draft.category),
        pending.id, new Date().toISOString());
      const metaSaved = persist(next);
      setDraft(fromNote(pending, metaSaved ? next.memberships[pending.id] : latestLibrary.current.memberships[pending.id]));
      setFeedback(metaSaved ? "Note saved." : "Note saved without changing its category or recent activity.");
      setLeave(undefined);
      then?.();
    } finally {
      processing.current = false; setBusy(false);
    }
  }

  async function deleteNote() {
    if (!saved || processing.current || disabled) return;
    processing.current = true; setBusy(true);
    try {
      if (!await onRemove(saved.id)) { setError("Could not remove the note."); return; }
      persist(removeDesktopNoteMetadata(latestLibrary.current, saved.id));
      setDraft(undefined); setRemoveNote(false); setFeedback("Note deleted.");
    } finally {
      processing.current = false; setBusy(false);
    }
  }

  function commitCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!categoryForm || processing.current) return;
    const id = categoryForm.id ?? localNoteId();
    const prior = latestLibrary.current;
    const name = categoryForm.name.trim();
    if (!name) return;
    if (prior.categories.some(item => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError("A category with that name already exists.");
      return;
    }
    const next = categoryForm.id
      ? renameDesktopNoteCategory(prior, id, name) : createDesktopNoteCategory(prior, id, name);
    if (!next.categories.some(item => item.id === id)) {
      setError("Could not add another category.");
      return;
    }
    setError("");
    if (persist(next)) { setScope({ kind: "category", id }); setCategoryForm(undefined); }
  }

  function deleteCategory() {
    if (!category || processing.current) return;
    setError("");
    if (!persist(removeDesktopNoteCategory(latestLibrary.current, category.id))) return;
    setScope({ kind: "all" });
    setDraft(current => current?.category === category.id ? { ...current, category: null } : current);
    setRemoveCategory(false);
    setFeedback("Category removed. Its notes are still in All Notes.");
  }

  const locked = disabled || busy;
  const mobile = variant === "mobile";
  const mobileEditor = mobile && !!draft;
  function returnToList() {
    switchEditor(() => { setDraft(undefined); setLeave(undefined); setRemoveNote(false); });
  }
  return <>
    {heading(() => switchEditor(onBack))}
    <div className={mobile ? "aw-desktop-notes aw-mobile-notes" : "aw-desktop-notes"}
      data-view={mobileEditor ? "editor" : "list"} aria-label="Notes workspace">
      <div className="aw-desktop-notes-index" hidden={mobileEditor}>
        <DesktopNotesSidebar notes={rows} categories={library.categories} scope={scope} selectedNoteId={draft?.id ?? null}
          onScopeChange={next => { setScope(next); setCategoryForm(undefined); setRemoveCategory(false); }}
          onSelectNote={chooseNote} onNewNote={newNote} onNewCategory={() => { setRemoveCategory(false); setCategoryForm({ name: "" }); }} />
        {category && !categoryForm && <div className="aw-note-category-actions" aria-label="Category tools" role="group">
          <NoteIconButton label="Rename category" icon="edit" disabled={locked}
            onClick={() => setCategoryForm({ id: category.id, name: category.name })} />
          <NoteIconButton label="Remove category" icon="trash" disabled={locked} onClick={() => setRemoveCategory(true)} />
        </div>}
        {categoryForm && <form className="aw-note-category-form" onSubmit={commitCategory}>
          <label>Category name<input autoFocus value={categoryForm.name} required maxLength={48}
            onChange={event => setCategoryForm({ ...categoryForm, name: event.currentTarget.value })} /></label>
          <div className="aw-note-category-actions">
            <NoteIconButton type="submit" label="Save category" icon="save" disabled={locked || !categoryForm.name.trim()} />
            <NoteIconButton label="Cancel category edit" icon="close" onClick={() => setCategoryForm(undefined)} />
          </div>
        </form>}
        {removeCategory && <div className="aw-note-confirm" role="group" aria-label="Remove category confirmation">
          <p>Remove this category? Its notes will stay in All Notes.</p>
          <IconAction label="Confirm remove category" icon="check" onClick={deleteCategory} />
          <IconAction label="Keep category" icon="close" onClick={() => setRemoveCategory(false)} />
        </div>}
        {mobile && !draft && feedback && <p role="status">{feedback}</p>}
        {mobile && !draft && error && <p role="alert">{error}</p>}
      </div>
      <GlassSurface className="aw-desktop-note-sheet" material="content" aria-label="Note editor" role="region" hidden={mobile && !draft}>
        {mobileEditor && <div className="aw-mobile-note-back">
          <IconAction label="Back to notes" icon="back" onClick={returnToList} />
          <span>Notes</span>
        </div>}
        {feedback && <p role="status" className="aw-desktop-note-feedback">{feedback}</p>}
        {error && <p role="alert" className="aw-desktop-note-feedback">{error}</p>}
        {leave && <div className="aw-note-confirm" role="group" aria-label="Unsaved note">
          <p>Save your changes before leaving this note?</p>
          <NoteIconButton label="Save changes and continue" icon="save" disabled={locked} onClick={() => void saveNote(leave)} />
          <NoteIconButton label="Discard changes and continue" icon="trash" onClick={() => {
            setDraft(saved ? fromNote(saved, library.memberships[saved.id]) : undefined); setLeave(undefined); setError(""); leave();
          }} />
          <NoteIconButton label="Keep editing" icon="close" onClick={() => setLeave(undefined)} />
        </div>}
        {draft ? <form key={draft.id} className="aw-desktop-note-form" data-ae-route-enter="neutral"
          onSubmit={event => { event.preventDefault(); void saveNote(); }}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault(); if (dirty) void saveNote();
            }
          }}>
          <div className="aw-desktop-note-top">
            <label className="aw-note-title-field">Title<input ref={title} value={draft.name} maxLength={titleLimit}
              placeholder="Untitled note" disabled={locked} onChange={event => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
            <div className="ae-actions" role="group" aria-label="Note actions">
              <NoteIconButton type="submit" label="Save note" icon="save" disabled={locked || !dirty || !draft.text.trim()} />
              {saved && onCollectionSelect && <NoteIconButton label="Select note for collection" icon="folder" disabled={locked}
                aria-pressed={collectionSelection.includes(saved.id)}
                onClick={() => onCollectionSelect(saved.id, !collectionSelection.includes(saved.id))} />}
              {saved && !dirty && noteActions?.(saved)}
              {saved && <NoteIconButton label="Delete note" icon="trash" disabled={locked} onClick={() => setRemoveNote(true)} />}
            </div>
          </div>
          <label className="aw-note-category-select"><SpatialIcon name="folder" size={17} />Category
            <select value={draft.category ?? ""} disabled={locked} onChange={event => setDraft({ ...draft, category: event.currentTarget.value || null })}>
              <option value="">Uncategorized</option>
              {library.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <WorkspaceNoteEditor value={draft.text} format={draft.format} disabled={locked}
            onChange={text => setDraft(current => current ? { ...current, text } : current)}
            onFormat={format => setDraft(current => current ? { ...current, format } : current)} />
          {attachments?.(draft.attachmentIds, attachmentIds =>
            setDraft(current => current ? { ...current, attachmentIds } : current), locked)}
          {removeNote && <div className="aw-note-confirm" role="group" aria-label="Delete note confirmation">
            <p>Delete this note from your workspace?</p>
            <NoteIconButton label="Confirm delete note" icon="trash" disabled={locked} onClick={() => void deleteNote()} />
            <NoteIconButton label="Keep note" icon="close" onClick={() => setRemoveNote(false)} />
          </div>}
        </form> : <div className="aw-desktop-note-empty">
          <SpatialIcon name="note" size={37} /><h4>Select a note</h4>
          <p>Choose a note from the sidebar or start writing.</p>
          <IconAction label="Create a note" icon="edit" variant="secondary" disabled={locked} onClick={newNote} />
        </div>}
      </GlassSurface>
    </div>
  </>;
}

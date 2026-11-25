import { GlassSurface, IconAction, SpatialIcon } from "@aerift/ui";
import { useEffect, useRef, useState } from "react";
import { CategoryGlyph, CategoryStyleFields } from "./CategoryStyleFields";
import { defaultCategoryStyle, type CategoryStyle } from "./category-style";
import { NoteIconButton } from "./WorkspaceNoteTools";
import { documentPreviewAvailable, readDocumentText } from "./workspace-document-tools";
import {
  browseGalleryRows, forgetGalleryEntry, galleryCategoryNameLimit, gallerySearchLimit, readGalleryIndex,
  recordGalleryImports, updateGalleryCategory, writeGalleryIndex, type GalleryEdit, type GalleryEntry, type GalleryIndex,
} from "./workspace-gallery-index";
import "./workspace-documents-gallery.css";

const pageSize = 30;
const documentAccept = ".pdf,.doc,.docx,.odt,.rtf,.txt,.text,.md,.csv,.tsv,.log,.pages,.ppt,.pptx,.key,.odp,.xls,.xlsx,.ods,.numbers,.epub";
export type DocumentGalleryScope = "desktop" | "ios" | "android";
export type WorkspaceDocumentRow = GalleryEntry & { sizeBytes?: number };

function getStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function WorkspaceDocumentsGallery<T extends WorkspaceDocumentRow>({
  catalog, scope, disabled, readAsset, onImport, onPick, onRemove, onPreview, onExport, onSelect,
  selectLabel = "Select document", emptyText = "No imported documents yet.",
}: {
  catalog: readonly T[];
  scope: DocumentGalleryScope;
  disabled?: boolean;
  readAsset?: (id: string) => Promise<Blob | undefined>;
  onImport?: (files: File[]) => Promise<readonly string[]>;
  onPick?: () => Promise<readonly string[]>;
  onRemove?: (id: string) => Promise<boolean>;
  onPreview?: (row: T) => boolean | Promise<boolean>;
  onExport?: (row: T) => boolean | Promise<boolean>;
  onSelect?: (row: T) => boolean | Promise<boolean>;
  selectLabel?: string;
  emptyText?: string;
}) {
  const namespace = `documents:${scope}` as const;
  const [index, setIndex] = useState(() => readGalleryIndex(getStorage(), namespace));
  const [categoryId, setCategory] = useState<string>();
  const [edit, setEdit] = useState<{ id?: string; name: string; appearance: CategoryStyle }>();
  const [removeCategory, setRemoveCategory] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [activeId, setActive] = useState<string>();
  const [categoryPicker, setCategoryPicker] = useState(false);
  const [removeCopy, setRemoveCopy] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [textPreview, setTextPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fromTile = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const current = index.categories.find(category => category.id === categoryId);
  const rows = browseGalleryRows(index, catalog, current?.id, query);
  const active = activeId === undefined ? undefined : catalog.find(row => row.id === activeId);
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const thisPage = Math.min(page, lastPage);
  const locked = disabled || busy;
  const textEligible = !!readAsset && !!active && documentPreviewAvailable(active.name, active.sizeBytes);
  const rootFilter = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [active]);

  // If the underlying inventory no longer contains the selected copy (including
  // a successful native remove), don't retain stale handles in the viewer.
  useEffect(() => {
    if (activeId !== undefined && !active) {
      ++generation.current;
      setActive(undefined);
      setTextPreview(undefined);
      const target = fromTile.current?.isConnected ? fromTile.current : rootFilter.current;
      target?.focus();
    }
  }, [activeId, active]);

  function persist(next: GalleryIndex | null) {
    if (!next || !writeGalleryIndex(getStorage(), namespace, next)) {
      setMessage("Could not save this document category change.");
      return false;
    }
    setMessage(""); setIndex(next);
    return true;
  }

  function change(operation: GalleryEdit) {
    return persist(updateGalleryCategory(readGalleryIndex(getStorage(), namespace), operation, new Set(catalog.map(row => row.id))));
  }

  function selectCategory(id?: string) {
    setCategory(id); setPage(0); setEdit(undefined); setRemoveCategory(false); setQuery("");
  }

  function closeViewer() { dialog.current?.close(); }

  function resetViewer() {
    ++generation.current;
    setActive(undefined); setTextPreview(undefined); setMessage(""); setNotice("");
    const target = fromTile.current?.isConnected ? fromTile.current : rootFilter.current;
    target?.focus();
  }

  async function run(task: () => boolean | Promise<boolean>, failure: string, success = "") {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setMessage(""); setNotice("");
    const stamp = generation.current;
    try {
      const ok = await task();
      if (generation.current === stamp) {
        if (!ok) setMessage(failure);
        else if (success) setNotice(success);
      }
    } catch {
      if (generation.current === stamp) setMessage(failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function importDocuments(task: () => Promise<readonly string[]>) {
    await run(async () => {
      const ids = await task();
      if (ids.length) return persist(recordGalleryImports(readGalleryIndex(getStorage(), namespace), ids, Date.now()));
      return true;
    }, "Could not import the documents.");
  }

  return <div className="aw-documents" data-ae-route-enter="neutral">
    <GlassSurface className="aw-documents-sidebar" material="content" role="complementary" aria-label="Document categories">
      <header><h4>Documents</h4><GlassSurface className="aw-document-actions" material="raised" role="group" aria-label="Document category controls">
        <IconAction icon="add" label="New document category" disabled={locked} onClick={() => {
          setRemoveCategory(false); setEdit({ name: "", appearance: defaultCategoryStyle });
        }} />
        {current && <>
          <IconAction icon="edit" label="Edit document category" disabled={locked} onClick={() => {
            setRemoveCategory(false); setEdit({ id: current.id, name: current.name, appearance: { color: current.color, icon: current.icon } });
          }} />
          <NoteIconButton type="button" icon="trash" label="Remove document category" disabled={locked}
            onClick={() => { setEdit(undefined); setRemoveCategory(true); }} />
        </>}
      </GlassSurface></header>
      <nav aria-label="Document categories">
        <button type="button" aria-current={!current ? "page" : undefined} onClick={() => selectCategory()}>Recents</button>
        {index.categories.map(category => <button key={category.id} type="button"
          aria-current={current?.id === category.id ? "page" : undefined} onClick={() => selectCategory(category.id)}>
          <CategoryGlyph appearance={category} /><span>{category.name}</span>
        </button>)}
      </nav>
      {edit && <form className="aw-document-category-form" onSubmit={event => {
        event.preventDefault();
        if (locked) return;
        const id = edit.id ?? crypto.randomUUID();
        if (change(edit.id ? { type: "edit", categoryId: id, name: edit.name, ...edit.appearance } :
          { type: "create", id, name: edit.name, ...edit.appearance })) selectCategory(id);
      }}>
        <label>Category name<input required autoFocus maxLength={galleryCategoryNameLimit} value={edit.name}
          onChange={event => setEdit({ ...edit, name: event.currentTarget.value })} /></label>
        <CategoryStyleFields appearance={edit.appearance} disabled={locked} onChange={appearance =>
          setEdit(previous => previous ? { ...previous, appearance } : previous)} />
        <GlassSurface className="aw-document-actions" material="raised" role="group" aria-label="Save document category changes">
          <NoteIconButton type="submit" icon="save" label="Save document category" disabled={locked || !edit.name.trim()} />
          <IconAction icon="close" label="Cancel category edit" onClick={() => setEdit(undefined)} />
        </GlassSurface>
      </form>}
      {removeCategory && current && <div role="group" aria-label="Remove category confirmation">
        <p>Remove this category? Its documents will stay in Recents.</p>
        <GlassSurface className="aw-document-actions" material="raised">
          <IconAction icon="check" label="Confirm remove document category" disabled={locked} onClick={() => {
            if (change({ type: "remove", categoryId: current.id })) selectCategory();
          }} />
          <IconAction icon="close" label="Keep document category" onClick={() => setRemoveCategory(false)} />
        </GlassSurface>
      </div>}
    </GlassSurface>

    <GlassSurface className="aw-documents-main" material="content" role="region" aria-label="Document gallery">
      <header><h4>{current?.name ?? "Recents"}</h4>
        {(onImport || onPick) && <GlassSurface className="aw-document-actions" material="raised">
          <IconAction icon="add" label="Import documents" disabled={locked} onClick={() => {
            if (onPick) void importDocuments(onPick);
            else picker.current?.click();
          }} />
          {!onPick && onImport && <input ref={picker} type="file" accept={documentAccept} aria-label="Import documents"
            hidden multiple disabled={locked} onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length) void importDocuments(() => onImport(files));
            }} />}
        </GlassSurface>}
      </header>
      <label className="aw-document-search">Search imported documents
        <input ref={rootFilter} type="search" maxLength={gallerySearchLimit} value={query} autoComplete="off"
          spellCheck={false} onChange={event => { setQuery(event.currentTarget.value); setPage(0); }} />
      </label>
      {message && !active && <p role="alert">{message}</p>}
      {!rows.length && <p>{query.trim() ? "No documents match your search." :
        current ? "This category is empty. Open a document in Recents to add it." : emptyText}</p>}
      <ul className="aw-documents-grid">{rows.slice(thisPage * pageSize, (thisPage + 1) * pageSize).map(row => <li key={row.id}>
        <button type="button" className="aw-document-tile" aria-label={`View ${row.name}`} onClick={event => {
          fromTile.current = event.currentTarget; setCategoryPicker(false); setRemoveCopy(false);
          setTextPreview(undefined); setMessage(""); setNotice(""); setActive(row.id);
        }}>
          <span className="aw-document-thumb" aria-hidden="true"><SpatialIcon name="file" size={34} /></span>
          <span className="aw-document-caption" title={row.name}>{row.name}</span>
        </button>
      </li>)}</ul>
      {lastPage > 0 && <nav className="aw-document-actions" aria-label="Document pages">
        <IconAction icon="back" label="Previous documents" disabled={thisPage === 0} onClick={() => setPage(thisPage - 1)} />
        <span>{thisPage + 1} / {lastPage + 1}</span>
        <IconAction icon="back" className="aw-document-next" label="Next documents" disabled={thisPage === lastPage}
          onClick={() => setPage(thisPage + 1)} />
      </nav>}
    </GlassSurface>

    {active && <dialog className="aw-document-viewer" ref={dialog} aria-label={`Viewing ${active.name}`} onClose={resetViewer}>
      <header><h4>{active.name}</h4><GlassSurface className="aw-document-actions" material="raised" role="group" aria-label="Document controls">
        {textEligible && readAsset && <IconAction icon="maximize" label="Preview document text" disabled={locked}
          onClick={() => void run(async () => {
            const stamp = generation.current;
            setTextPreview(undefined);
            const text = await readDocumentText(active.name, await readAsset(active.id));
            if (text === undefined || generation.current !== stamp) return false;
            setTextPreview(text); return true;
          }, "A safe text preview is not available for this document.")} />}
        {onPreview && <IconAction icon="folder" label="Open document preview" disabled={locked}
          onClick={() => void run(() => onPreview(active), "Could not open the document preview.")} />}
        {onExport && <IconAction icon="drop" label="Export document copy" disabled={locked}
          onClick={() => void run(() => onExport(active), "Could not export this copy.")} />}
        {onSelect && <IconAction icon="send" label={selectLabel} disabled={locked}
          onClick={() => void run(() => onSelect(active), "Could not select this document.", "Document selected.")} />}
        <IconAction icon="collection" label="Add to document category" disabled={locked || !index.categories.length}
          onClick={() => setCategoryPicker(value => !value)} />
        {onRemove && <NoteIconButton type="button" icon="trash" label="Remove imported document copy" disabled={locked}
          onClick={() => setRemoveCopy(true)} />}
        <IconAction icon="close" label="Close document" onClick={closeViewer} />
      </GlassSurface></header>
      {message && <p role="alert">{message}</p>}
      {notice && <p role="status">{notice}</p>}
      {categoryPicker && <GlassSurface className="aw-document-category-picker" material="overlay" role="group" aria-label="Choose document category">
        {index.categories.map(category => <button key={category.id} type="button" aria-pressed={category.ids.includes(active.id)}
          disabled={locked} onClick={() => change({ type: "toggle", categoryId: category.id, itemId: active.id })}>
          <CategoryGlyph appearance={category} />{category.name}
        </button>)}
      </GlassSurface>}
      {removeCopy && onRemove && <div role="group" aria-label="Confirm remove document copy">
        <p>Remove this imported copy from AeRift? The original won’t be changed.</p>
        <GlassSurface className="aw-document-actions" material="raised">
          <NoteIconButton type="button" icon="trash" label="Confirm remove document copy" disabled={locked}
            onClick={() => void run(async () => {
              if (!await onRemove(active.id)) return false;
              persist(forgetGalleryEntry(readGalleryIndex(getStorage(), namespace), active.id));
              closeViewer();
              return true;
            }, "Could not remove the imported copy.")} />
          <IconAction icon="close" label="Keep document copy" onClick={() => setRemoveCopy(false)} />
        </GlassSurface>
      </div>}
      {typeof active.sizeBytes === "number" && Number.isSafeInteger(active.sizeBytes) && active.sizeBytes >= 0 &&
        <p>{active.sizeBytes.toLocaleString()} bytes</p>}
      {textPreview !== undefined ? <pre aria-label="Document text">{textPreview}</pre> :
        !textEligible && !onPreview && <p>In-app preview isn’t available for this document format.</p>}
    </dialog>}
  </div>;
}

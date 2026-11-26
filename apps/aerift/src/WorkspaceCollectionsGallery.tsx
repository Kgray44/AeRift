import { Button, GlassSurface, IconAction } from "@aerift/ui";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CategoryGlyph, CategoryStyleFields } from "./CategoryStyleFields";
import { defaultCategoryStyle, type CategoryStyle } from "./category-style";
import { NoteIconButton } from "./WorkspaceNoteTools";
import { WorkspaceCollectionTools } from "./WorkspaceCollectionTools";
import { collectionCandidates, type WorkspaceCollectionObject } from "./workspace-collection-tools";
import { changeCollectionGallery, collectionGalleryRows, collectionGalleryTitleLimit, normalizeCollectionTitle,
  type CollectionGalleryAppearance, type CollectionGalleryChange, type CollectionGalleryRow, type CollectionGalleryView } from "./workspace-collections-gallery";
import "./workspace-collections-gallery.css";

type MaybeSaved<T> = T | Promise<T>;
type Form = { mode: "create" | "rename"; name: string } |
  { mode: "category"; id?: string; name: string; appearance: CategoryStyle };

export function WorkspaceCollectionsGallery({ collections, objects, appearance, onPersistAppearance, onCreate, onRename,
  onChangeMembers, onRemove, preselectedIds = [], disabled = false, collectionActions }: {
  collections: readonly CollectionGalleryRow[];
  objects: readonly WorkspaceCollectionObject[];
  appearance: CollectionGalleryAppearance;
  onPersistAppearance: (value: CollectionGalleryAppearance) => MaybeSaved<boolean>;
  onCreate: (name: string, initialIds: readonly string[]) => MaybeSaved<string | null>;
  onRename: (id: string, name: string) => MaybeSaved<boolean>;
  onChangeMembers: (id: string, next: readonly string[], previous: readonly string[]) => MaybeSaved<boolean>;
  onRemove: (id: string) => MaybeSaved<boolean>;
  preselectedIds?: readonly string[];
  disabled?: boolean;
  collectionActions?: (collection: CollectionGalleryRow) => ReactNode;
}) {
  const [view, setView] = useState<CollectionGalleryView>("all");
  const [activeId, setActiveId] = useState<string>();
  const [form, setForm] = useState<Form>();
  const [useSelection, setUseSelection] = useState(false);
  const [confirm, setConfirm] = useState<"collection" | "category">();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const origin = useRef<HTMLButtonElement>(null);
  const live = new Set(collections.map(item => item.id));
  const active = collections.find(item => item.id === activeId);
  const selectedCategory = typeof view === "object" ? appearance.categories.find(category => category.id === view.categoryId) : undefined;
  const effectiveView = typeof view === "object" && !selectedCategory ? "all" : view;
  const rows = collectionGalleryRows(collections, appearance, effectiveView, query);
  const pageSize = 24;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const selected = new Set(preselectedIds);
  const usableSelected = collectionCandidates(objects, [], "").filter(item => selected.has(item.id)).map(item => item.id);
  const locked = disabled || saving;

  useEffect(() => { if (form) nameInput.current?.focus(); }, [form?.mode]); // Focus once when the form opens.
  useEffect(() => { if (active) heading.current?.focus(); }, [active?.id]);
  function dismissForm() {
    setForm(undefined);
    queueMicrotask(() => {
      if (origin.current?.isConnected && !origin.current.disabled) origin.current.focus();
      else add.current?.focus();
    });
  }
  function openForm(next: Form, control: HTMLButtonElement) {
    origin.current = control;
    setConfirm(undefined);
    setError("");
    setForm(next);
  }
  function switchView(next: CollectionGalleryView) {
    setView(next);
    setActiveId(undefined);
    setPage(0);
    setQuery("");
    setForm(undefined);
    setConfirm(undefined);
    setFeedback("");
    setError("");
  }
  async function persist(change: CollectionGalleryChange, known = live) {
    const next = changeCollectionGallery(appearance, change, known);
    if (!next) return false;
    return await onPersistAppearance(next);
  }
  async function mutate(task: () => Promise<void>) {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError(""); setFeedback("");
    try { await task(); } catch { setError("Could not save this change. Try again."); }
    finally { inFlight.current = false; setSaving(false); }
  }
  function visit(id: string, control: HTMLButtonElement) {
    origin.current = control;
    setActiveId(id); setConfirm(undefined); setForm(undefined);
    void mutate(async () => {
      if (!await persist({ type: "visit", id })) setError("Collection opened, but Recents could not be updated.");
    });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    const name = normalizeCollectionTitle(form.name);
    if (!name) { setError("Enter a name of 1 to 100 characters."); return; }
    void mutate(async () => {
      if (form.mode === "create") {
        const id = await onCreate(name, useSelection ? usableSelected : []);
        if (!id) throw new Error();
        setActiveId(id); setForm(undefined);
        setFeedback("Collection created. Add items when you’re ready.");
        const nextLive = new Set(live).add(id);
        const visited = changeCollectionGallery(appearance, { type: "visit", id }, nextLive);
        const next = visited && selectedCategory
          ? changeCollectionGallery(visited, { type: "assign", id, categoryId: selectedCategory.id }, nextLive) : visited;
        if (!next || !await onPersistAppearance(next)) setError("Collection created, but its category or Recents could not be saved.");
      } else if (form.mode === "rename") {
        if (!active || !await onRename(active.id, name)) throw new Error();
        setForm(undefined); setFeedback("Collection renamed.");
        heading.current?.focus();
      } else if (form.mode === "category") {
        const id = form.id ?? crypto.randomUUID();
        if (!await persist({ type: "putCategory", id, name, style: form.appearance })) {
          setError("Could not save this category. Check for a duplicate name or category limit.");
          return;
        }
        setView({ categoryId: id }); setQuery(""); setPage(0);
        setForm(undefined); setFeedback("Category saved.");
      }
    });
  }
  function remove() {
    void mutate(async () => {
      if (confirm === "collection" && active) {
        if (!await onRemove(active.id)) throw new Error();
        setActiveId(undefined); setConfirm(undefined);
        setFeedback("Collection removed. Its items were kept.");
        if (!await persist({ type: "forget", id: active.id })) setError("Collection removed, but its display history could not be updated.");
        queueMicrotask(() => add.current?.focus());
      } else if (confirm === "category" && selectedCategory) {
        if (!await persist({ type: "removeCategory", id: selectedCategory.id })) throw new Error();
        switchView("all"); setFeedback("Category removed. Its collections were kept.");
      }
    });
  }

  return <section className="aw-collections-gallery" aria-label="Collections workspace" aria-busy={saving}>
    {!active && <GlassSurface className="aw-collections-bar" material="chrome">
      <div className="ae-actions" aria-label="Collection views" role="group">
        <Button variant="quiet" type="button" aria-pressed={effectiveView === "all"} onClick={() => switchView("all")}>All collections</Button>
        <Button variant="quiet" type="button" aria-pressed={effectiveView === "recents"} onClick={() => switchView("recents")}>Recents</Button>
        {appearance.categories.map(category => <Button key={category.id} variant="quiet" type="button"
          aria-pressed={selectedCategory?.id === category.id} onClick={() => switchView({ categoryId: category.id })}>
          <CategoryGlyph appearance={category.style} />{category.name}
        </Button>)}
      </div>
      <div className="ae-actions">
        <label>Find a collection<input type="search" maxLength={collectionGalleryTitleLimit} value={query} autoComplete="off"
          onChange={event => { setQuery(event.currentTarget.value); setPage(0); }} /></label>
        <NoteIconButton type="button" icon="folder" label="New collection category" disabled={locked}
          onClick={event => openForm({ mode: "category", name: "", appearance: defaultCategoryStyle }, event.currentTarget)} />
        {selectedCategory && <>
          <NoteIconButton type="button" icon="edit" label="Edit collection category" disabled={locked}
            onClick={event => openForm({ mode: "category", id: selectedCategory.id, name: selectedCategory.name,
              appearance: selectedCategory.style }, event.currentTarget)} />
          <NoteIconButton type="button" icon="trash" label="Remove collection category" disabled={locked}
            onClick={() => { setForm(undefined); setConfirm("category"); }} />
        </>}
      </div>
    </GlassSurface>}
    <GlassSurface className="aw-collections-floating" material="chrome">
      <IconAction ref={add} icon="add" label="New collection" variant="primary" disabled={locked}
        onClick={event => { setUseSelection(false); openForm({ mode: "create", name: "" }, event.currentTarget); }} />
    </GlassSurface>
    {form && <GlassSurface material="raised" className="aw-collections-form">
      <form onSubmit={submit}>
        <label>{form.mode === "category" ? "Category name" : "Collection name"}
          <input ref={nameInput} required maxLength={collectionGalleryTitleLimit} value={form.name} disabled={locked}
            onChange={event => { const name = event.currentTarget.value; setForm(previous => previous ? { ...previous, name } : previous); }} />
        </label>
        {form.mode === "category" && <CategoryStyleFields appearance={form.appearance} disabled={locked}
          onChange={style => setForm(previous => previous?.mode === "category" ? { ...previous, appearance: style } : previous)} />}
        {form.mode === "create" && !!usableSelected.length && <label>
          <input type="checkbox" checked={useSelection} disabled={locked}
            onChange={event => setUseSelection(event.currentTarget.checked)} /> Add {usableSelected.length} selected items
        </label>}
        <div className="ae-actions">
          <Button type="submit" variant="primary" disabled={locked || !normalizeCollectionTitle(form.name)}>
            {form.mode === "create" ? "Create collection" : form.mode === "category" ? "Save category" : "Rename collection"}
          </Button>
          <NoteIconButton type="button" icon="close" label="Cancel" disabled={locked} onClick={dismissForm} />
        </div>
      </form>
    </GlassSurface>}
    {confirm && <GlassSurface material="raised" className="aw-collections-confirm">
      <p>{confirm === "collection" ? "Remove this collection? Its items stay in Workspace." :
        "Remove this category? Its collections stay in Workspace."}</p>
      <div className="ae-actions">
        <Button type="button" variant="danger" disabled={locked} onClick={remove}>Remove {confirm}</Button>
        <Button type="button" variant="quiet" disabled={locked} onClick={() => setConfirm(undefined)}>Keep</Button>
      </div>
    </GlassSurface>}
    {error && <p role="alert">{error}</p>}{feedback && <p role="status">{feedback}</p>}
    {active ? <>
      <GlassSurface material="raised" className="aw-collections-active">
        <div className="ae-actions">
          <IconAction icon="back" label="Back to collections" onClick={() => {
            setActiveId(undefined); setForm(undefined); setConfirm(undefined); setError(""); setFeedback("");
            queueMicrotask(() => { if (origin.current?.isConnected) origin.current.focus(); else add.current?.focus(); });
          }} />
          <h3 ref={heading} tabIndex={-1}>{active.name}</h3>
          <NoteIconButton type="button" icon="edit" label="Rename collection" disabled={locked}
            onClick={event => openForm({ mode: "rename", name: active.name }, event.currentTarget)} />
          <NoteIconButton type="button" icon="trash" label="Remove collection" disabled={locked}
            onClick={() => { setForm(undefined); setConfirm("collection"); }} />
          {collectionActions?.(active)}
        </div>
        {!!appearance.categories.length && <label>Collection category
          <select value={appearance.assignments.find(item => item.id === active.id)?.categoryId ?? ""}
            disabled={locked} onChange={event => {
              const categoryId = event.currentTarget.value || undefined;
              void mutate(async () => { if (!await persist({ type: "assign", id: active.id, categoryId })) throw new Error(); });
            }}>
            <option value="">None</option>
            {appearance.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>}
      </GlassSurface>
      <WorkspaceCollectionTools key={active.id} name={active.name} memberIds={active.memberIds}
        objects={objects} disabled={locked} onChange={(next, previous) => onChangeMembers(active.id, next, previous)} />
    </> : <>
      {!!rows.length ? <ul className="aw-collections-grid">
        {rows.slice(currentPage * pageSize, currentPage * pageSize + pageSize).map(item => {
          const category = appearance.categories.find(row => row.id === appearance.assignments.find(a => a.id === item.id)?.categoryId);
          return <li key={item.id}><GlassSurface material="content" className="aw-collections-card">
            <button type="button" className="aw-collections-card-open" disabled={locked} onClick={event => visit(item.id, event.currentTarget)}>
              <CategoryGlyph appearance={category?.style ?? defaultCategoryStyle} />
              <strong>{item.name}</strong>
              <small>{item.memberIds.length} {item.memberIds.length === 1 ? "item" : "items"}{category ? " · " + category.name : ""}</small>
            </button>
          </GlassSurface></li>;
        })}
      </ul> : <p>{query.trim() ? "No collections match your search." : effectiveView === "recents" ? "Collections you open appear here." :
        typeof effectiveView === "object" ? "No collections in this category yet." : "Use the plus button to make your first collection."}</p>}
      {pageCount > 1 && <nav className="ae-actions" aria-label="Collection pages">
        <Button type="button" variant="quiet" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</Button>
        <span>{currentPage + 1} of {pageCount}</span>
        <Button type="button" variant="quiet" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>Next</Button>
      </nav>}
    </>}
  </section>;
}

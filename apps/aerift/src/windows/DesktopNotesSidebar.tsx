import { IconAction } from "@aerift/ui";
import { useId, useMemo, useState } from "react";
import "./desktop-notes-sidebar.css";

export type DesktopNotesScope = { kind: "all" | "recent" } | { kind: "category"; id: string };
export type DesktopNotesCategory = { id: string; name: string };
export type DesktopNotesListItem = {
  id: string;
  title: string;
  snippet: string;
  searchText?: string;
  updatedAt: number;
  categoryId?: string | null;
};

type DesktopNotesSidebarProps = {
  notes: readonly DesktopNotesListItem[];
  categories: readonly DesktopNotesCategory[];
  scope: DesktopNotesScope;
  selectedNoteId: string | null;
  onScopeChange: (scope: DesktopNotesScope) => void;
  onSelectNote: (id: string) => void;
  onNewNote: () => void;
  onNewCategory: () => void;
  recentLimit?: number;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timestampFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function orderNotes(notes: readonly DesktopNotesListItem[]) {
  return [...notes].sort((a, b) => (Number.isFinite(b.updatedAt) ? b.updatedAt : 0)
    - (Number.isFinite(a.updatedAt) ? a.updatedAt : 0));
}

function scopeNotes(notes: readonly DesktopNotesListItem[], scope: DesktopNotesScope, recentLimit: number) {
  if (scope.kind === "category") return notes.filter(note => note.categoryId === scope.id);
  if (scope.kind === "recent") return notes.slice(0, recentLimit);
  return notes;
}

function searchNotes(notes: readonly DesktopNotesListItem[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return notes;
  return notes.filter(note => [note.title.trim() || "Untitled note", note.snippet, note.searchText]
    .some(value => value?.toLocaleLowerCase().includes(needle)));
}

export function filterDesktopNotes(
  notes: readonly DesktopNotesListItem[], scope: DesktopNotesScope, query: string, recentLimit: number,
) {
  return searchNotes(scopeNotes(orderNotes(notes), scope, recentLimit), query);
}

function NotesScopeIcon({ kind }: { kind: DesktopNotesScope["kind"] }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
    {kind === "recent" ? <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5l3.5 2" /></>
      : kind === "all" ? <><rect x="5" y="3.5" width="14" height="17" rx="2.5" /><path d="M8 8h8m-8 4h8m-8 4h5" /></>
        : <path d="M3.5 17.5v-11A2 2 0 0 1 5.5 4.5h4l2.4 2.5h6.6a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />}
  </svg>;
}

export function DesktopNotesSidebar({
  notes, categories, scope, selectedNoteId, onScopeChange, onSelectNote,
  onNewNote, onNewCategory, recentLimit = 20,
}: DesktopNotesSidebarProps) {
  const headingId = useId();
  const searchId = useId();
  const resultsId = useId();
  const [query, setQuery] = useState("");
  const results = useMemo(() => filterDesktopNotes(notes, scope, query, recentLimit), [notes, scope, query, recentLimit]);
  const counts = useMemo(() => {
    const byCategory = new Map<string, number>();
    for (const { categoryId } of notes) {
      if (categoryId) byCategory.set(categoryId, (byCategory.get(categoryId) ?? 0) + 1);
    }
    return byCategory;
  }, [notes]);

  const scopeLabel = scope.kind === "category" ? categories.find(category => category.id === scope.id)?.name ?? "Category"
    : scope.kind === "recent" ? "Recents" : "All Notes";

  function scopeRow(target: DesktopNotesScope, label: string, count: number, active: boolean) {
    return <button type="button" className="ae-note-scope" aria-current={active ? "true" : undefined}
      onClick={() => onScopeChange(target)} title={label}>
      <NotesScopeIcon kind={target.kind} />
      <span className="ae-note-sidebar-truncate">{label}</span>
      <span className="ae-note-sidebar-count">{count}</span>
    </button>;
  }

  return <aside className="ae-notes-sidebar" aria-labelledby={headingId}>
    <header className="ae-notes-sidebar-head">
      <h4 id={headingId}>Notes</h4>
      <div className="ae-notes-sidebar-actions" role="group" aria-label="Create in Notes">
        <IconAction variant="secondary" icon="collection" label="New category" onClick={onNewCategory} />
        <IconAction variant="secondary" icon="add" label="New note" onClick={onNewNote} />
      </div>
    </header>
    <nav className="ae-notes-sidebar-scopes" aria-label="Note categories">
      <ul>
        <li>{scopeRow({ kind: "all" }, "All Notes", notes.length, scope.kind === "all")}</li>
        <li>{scopeRow({ kind: "recent" }, "Recents", Math.min(notes.length, recentLimit), scope.kind === "recent")}</li>
        {categories.map(category => <li key={category.id}>
          {scopeRow({ kind: "category", id: category.id }, category.name, counts.get(category.id) ?? 0,
            scope.kind === "category" && scope.id === category.id)}
        </li>)}
      </ul>
    </nav>
    <section className="ae-notes-sidebar-results" aria-labelledby={resultsId}>
      <div className="ae-notes-sidebar-search">
        <label className="ae-note-sidebar-visually-hidden" htmlFor={searchId}>Search notes</label>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
          strokeWidth="1.7" strokeLinecap="round"><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15 15 4.5 4.5" /></svg>
        <input id={searchId} type="search" value={query} maxLength={180} placeholder="Search notes"
          onChange={event => setQuery(event.currentTarget.value)} />
      </div>
      <header className="ae-notes-sidebar-result-head">
        <h5 id={resultsId} title={scopeLabel} className="ae-note-sidebar-truncate">{scopeLabel}</h5>
        <span className="ae-note-sidebar-count" role="status">{results.length} {results.length === 1 ? "note" : "notes"}</span>
      </header>
      <ul className="ae-notes-sidebar-list">
        {results.map(note => {
          const date = note.updatedAt > 0 ? new Date(note.updatedAt) : undefined;
          const stamp = date && Number.isFinite(date.getTime()) ? date : undefined;
          const title = note.title.trim() || "Untitled note";
          const snippet = note.snippet.trim().replace(/\s+/g, " ");
          return <li key={note.id}>
            <button className="ae-note-sidebar-note" type="button" aria-current={note.id === selectedNoteId ? "page" : undefined}
              onClick={() => onSelectNote(note.id)}>
              <strong className="ae-note-sidebar-truncate" title={title}>{title}</strong>
              {stamp && <time dateTime={stamp.toISOString()} title={timestampFormat.format(stamp)}>{dateFormat.format(stamp)}</time>}
              <span className="ae-note-sidebar-truncate">{snippet || "No additional text"}</span>
            </button>
          </li>;
        })}
      </ul>
      {!results.length && <p className="ae-notes-sidebar-empty">{query.trim() ? "No notes match this search."
        : scope.kind === "category" ? "No notes in this category yet." : "No notes yet."}</p>}
    </section>
  </aside>;
}

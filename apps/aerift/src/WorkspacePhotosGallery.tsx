import { GlassSurface, IconAction } from "@aerift/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CategoryGlyph, CategoryStyleFields } from "./CategoryStyleFields";
import { defaultCategoryStyle, type CategoryStyle } from "./category-style";
import { NoteIconButton } from "./WorkspaceNoteTools";
import { changePhotoAlbums, forgetPhotoReferences, listAlbumPhotos, listRecentPhotos, loadPhotoAlbumIndex, photoAlbumNameLimit,
  recordPhotoImports, savePhotoAlbumIndex, type PhotoAlbumChange, type PhotoAlbumIndex, type PhotoAlbumScope } from "./workspace-photo-albums";
import "./workspace-photos-gallery.css";

type PhotoRow = { id: string; name: string; kind: "photo" | "video" };
const rowLimit = 24;
const previewBytes = 32 * 1024 * 1024;
const inlineImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/bmp", "image/gif"]);

function albumStorage() {
  try { return window.localStorage; } catch { return undefined; }
}

function Thumbnail({ row, asset }: { row: PhotoRow; asset?: (id: string) => Promise<Blob | undefined> }) {
  const target = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!asset || row.kind !== "photo") return;
    let live = true, started = false;
    let objectUrl: string | undefined;
    const load = () => {
      if (started) return;
      started = true;
      void asset(row.id).then(blob => {
        if (!live || !blob || blob.size > previewBytes || !inlineImageTypes.has(blob.type)) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }).catch(() => { /* The original remains available through the explicit viewer. */ });
    };
    const node = target.current;
    const observer = node && typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: "160px" }) : undefined;
    if (observer && node) observer.observe(node);
    else load();
    return () => {
      live = false; observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset, row.id, row.kind]);

  return <span ref={target} className="aw-photo-thumb" aria-hidden="true">
    {url && !failed ? <img src={url} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} /> :
      <><CategoryGlyph appearance={{ color: "default", icon: "camera" }} />
        {row.kind === "video" && <span className="aw-photo-video-mark">▶</span>}</>}
  </span>;
}

export function WorkspacePhotosGallery<T extends PhotoRow>({ catalog, scope, disabled, readAsset, onImport, onRemove, viewer, emptyText }: {
  catalog: readonly T[];
  scope: PhotoAlbumScope;
  disabled?: boolean;
  readAsset?: (id: string) => Promise<Blob | undefined>;
  onImport?: (files: File[]) => Promise<readonly string[]>;
  onRemove?: (id: string) => Promise<boolean>;
  viewer: (photo: T) => ReactNode;
  emptyText: string;
}) {
  const [index, setIndex] = useState(() => loadPhotoAlbumIndex(albumStorage(), scope));
  const [albumId, setAlbumId] = useState<string>();
  const [editing, setEditing] = useState<{ id?: string; name: string; style: CategoryStyle }>();
  const [removeAlbum, setRemoveAlbum] = useState(false);
  const [active, setActive] = useState<T>();
  const [page, setPage] = useState(0);
  const [issue, setIssue] = useState("");
  const [removePhoto, setRemovePhoto] = useState(false);
  const [addToAlbum, setAddToAlbum] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fromTile = useRef<HTMLButtonElement>(null);
  const current = index.albums.find(item => item.id === albumId);
  const browse = current ? listAlbumPhotos(index, current.id, catalog, item => item) :
    listRecentPhotos(index, catalog, item => item);
  const lastPage = Math.max(0, Math.ceil(browse.length / rowLimit) - 1);
  const thisPage = Math.min(page, lastPage);

  function store(next: PhotoAlbumIndex | null) {
    if (!next || !savePhotoAlbumIndex(albumStorage(), scope, next)) { setIssue("Could not save this album change."); return false; }
    setIssue(""); setIndex(next); return true;
  }

  function edit(change: PhotoAlbumChange) {
    return store(changePhotoAlbums(loadPhotoAlbumIndex(albumStorage(), scope), change, new Set(catalog.map(row => row.id))));
  }

  function selectAlbum(id?: string) { setAlbumId(id); setPage(0); setEditing(undefined); setRemoveAlbum(false); }
  function closeViewer() { if (dialog.current?.open) dialog.current.close(); }
  useEffect(() => {
    if (active && !dialog.current?.open) dialog.current?.showModal();
  }, [active]);

  return <div className="aw-photos" data-ae-route-enter="neutral">
    <GlassSurface className="aw-photos-sidebar" material="content" role="complementary" aria-label="Photo albums">
      <header><h4>Photos</h4><GlassSurface className="aw-photos-icons" material="raised" role="group" aria-label="Album controls">
        <IconAction icon="add" label="New album" disabled={disabled} onClick={() => {
          setRemoveAlbum(false); setEditing({ name: "", style: { ...defaultCategoryStyle, icon: "camera" } });
        }} />
        {current && <>
          <IconAction icon="edit" label="Edit album" disabled={disabled} onClick={() => {
            setRemoveAlbum(false); setEditing({ id: current.id, name: current.name, style: { color: current.color, icon: current.icon } });
          }} />
          <NoteIconButton type="button" icon="trash" label="Remove album" disabled={disabled} onClick={() => setRemoveAlbum(true)} />
        </>}
      </GlassSurface></header>
      <nav aria-label="Albums">
        <button type="button" aria-current={!current ? "page" : undefined} onClick={() => selectAlbum()}>Recents</button>
        {index.albums.map(album => <button key={album.id} type="button" aria-current={current?.id === album.id ? "page" : undefined}
          onClick={() => selectAlbum(album.id)}><CategoryGlyph appearance={album} /><span>{album.name}</span></button>)}
      </nav>
      {editing && <form className="aw-photo-album-form" onSubmit={event => {
        event.preventDefault();
        const id = editing.id ?? crypto.randomUUID();
        if (edit(editing.id ? { type: "rename", albumId: id, name: editing.name, ...editing.style } :
          { type: "create", id, name: editing.name, ...editing.style })) selectAlbum(id);
      }}>
        <label>Album name<input required autoFocus value={editing.name} maxLength={photoAlbumNameLimit}
          onChange={event => setEditing({ ...editing, name: event.currentTarget.value })} /></label>
        <CategoryStyleFields appearance={editing.style} disabled={disabled}
          onChange={style => setEditing(previous => previous ? { ...previous, style } : previous)} />
        <GlassSurface className="aw-photos-icons" material="raised" role="group" aria-label="Save album changes">
          <NoteIconButton type="submit" icon="save" label="Save album" disabled={disabled || !editing.name.trim()} />
          <IconAction icon="close" label="Cancel album edit" onClick={() => setEditing(undefined)} />
        </GlassSurface>
      </form>}
      {removeAlbum && current && <div role="group" aria-label="Remove album confirmation">
        <p>Remove this album? Its photos will stay in Recents.</p>
        <GlassSurface className="aw-photos-icons" material="raised">
          <IconAction icon="check" label="Confirm remove album" onClick={() => {
            if (edit({ type: "remove", albumId: current.id })) selectAlbum();
          }} />
          <IconAction icon="close" label="Keep album" onClick={() => setRemoveAlbum(false)} />
        </GlassSurface>
      </div>}
    </GlassSurface>
    <GlassSurface className="aw-photos-main" material="content" role="region" aria-label="Photo gallery">
      <header><h4>{current?.name ?? "Recents"}</h4>
        {onImport && <GlassSurface className="aw-photos-icons" material="raised">
          <IconAction icon="add" label="Import photos and videos" disabled={disabled} onClick={() => picker.current?.click()} />
          <input ref={picker} type="file" accept="image/*,video/*" aria-label="Import photos and videos" hidden multiple disabled={disabled}
            onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (!files.length) return;
              void onImport(files).then(ids => {
                if (ids.length) store(recordPhotoImports(loadPhotoAlbumIndex(albumStorage(), scope), ids, Date.now()));
              }).catch(() => setIssue("Could not import these photos."));
            }} />
        </GlassSurface>}</header>
      {issue && !active && <p role="alert">{issue}</p>}
      {!browse.length && <p>{current ? "This album is empty. Open a photo from Recents to add it." : emptyText}</p>}
      <ul className="aw-photos-grid">{browse.slice(thisPage * rowLimit, (thisPage + 1) * rowLimit).map(row => <li key={row.id}>
        <button type="button" className="aw-photo-tile" aria-label={`Open ${row.name}`} onClick={event => {
          fromTile.current = event.currentTarget; setAddToAlbum(false); setRemovePhoto(false); setActive(row);
        }}>
          <Thumbnail row={row} asset={readAsset} />
          <span className="aw-photo-caption" title={row.name}>{row.name}</span>
        </button>
      </li>)}</ul>
      {lastPage > 0 && <nav className="aw-photos-icons" aria-label="Photo pages">
        <IconAction icon="back" label="Previous photos" disabled={thisPage === 0} onClick={() => setPage(thisPage - 1)} />
        <span>{thisPage + 1} / {lastPage + 1}</span>
        <IconAction icon="back" className="aw-photos-next" label="Next photos" disabled={thisPage === lastPage} onClick={() => setPage(thisPage + 1)} />
      </nav>}
    </GlassSurface>
    {active && <dialog className="aw-photo-viewer" ref={dialog} aria-label={`Viewing ${active.name}`} onClose={() => {
      setActive(undefined); fromTile.current?.focus();
    }}>
      <header><h4>{active.name}</h4><GlassSurface className="aw-photos-icons" material="raised" role="group" aria-label="Photo controls">
        <IconAction icon="collection" label="Add to album" disabled={!index.albums.length} onClick={() => setAddToAlbum(value => !value)} />
        {onRemove && <NoteIconButton type="button" icon="trash" label="Remove imported copy" disabled={disabled}
          onClick={() => setRemovePhoto(true)} />}
        <IconAction icon="close" label="Close photo" onClick={closeViewer} />
      </GlassSurface></header>
      {issue && <p role="alert">{issue}</p>}
      {removePhoto && onRemove && <div role="group" aria-label="Confirm remove imported copy">
        <p>Remove this copy from AeRift? The original file isn’t changed.</p>
        <GlassSurface className="aw-photos-icons" material="raised">
          <NoteIconButton type="button" icon="trash" label="Confirm remove imported copy" disabled={disabled} onClick={() => {
            void onRemove(active.id).then(ok => {
              if (ok) {
                store(forgetPhotoReferences(loadPhotoAlbumIndex(albumStorage(), scope), [active.id]));
                closeViewer();
              } else setIssue("Could not remove this imported copy.");
            }).catch(() => setIssue("Could not remove this imported copy."));
          }} />
          <IconAction icon="close" label="Keep photo" onClick={() => setRemovePhoto(false)} />
        </GlassSurface>
      </div>}
      {addToAlbum && <GlassSurface className="aw-photo-add-albums" material="overlay" role="group" aria-label="Choose photo album">
        {index.albums.map(album => <button type="button" key={album.id} aria-pressed={album.photoIds.includes(active.id)}
          onClick={() => edit({ type: album.photoIds.includes(active.id) ? "remove-photo" : "add-photo", albumId: album.id, photoId: active.id })}>
          <CategoryGlyph appearance={album} />{album.name}
        </button>)}
      </GlassSurface>}
      <div className="aw-photo-viewer-content">{viewer(active)}</div>
    </dialog>}
  </div>;
}

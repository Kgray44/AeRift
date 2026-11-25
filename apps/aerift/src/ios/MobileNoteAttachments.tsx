import { Button, IconAction, type TransferWorkspaceRegions } from "@aerift/ui";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { NoteIconButton } from "../WorkspaceNoteTools";
import type { ObservedMediaPort } from "./mobile-media-observer";
import type { ImportedMedia } from "./mobile-media";
import type { MobilePlatformCopy } from "./mobile-platform";

type AttachmentLibrary = { kind: "pending" | "failed" } | { kind: "ready"; items: readonly ImportedMedia[] };

export function MobileNoteAttachments({ ids, onChange, media, regions, openRift, copy, disabled = false }: {
  ids: readonly string[];
  onChange: (ids: readonly string[]) => void;
  media: ObservedMediaPort;
  regions: TransferWorkspaceRegions;
  openRift: () => void;
  copy: MobilePlatformCopy;
  disabled?: boolean;
}) {
  const chooserId = useId();
  const [library, setLibrary] = useState<AttachmentLibrary>({ kind: "pending" });
  const [retry, setRetry] = useState(0);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const open = useRef(false);
  const running = useRef(false);

  useLayoutEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let observedUpdate = false;
    setLibrary({ kind: "pending" });
    const unsubscribe = media.subscribe(items => {
      if (!active) return;
      observedUpdate = true;
      setLibrary({ kind: "ready", items });
    });
    void media.list().then(result => {
      if (!active || observedUpdate) return;
      setLibrary(result.ok ? { kind: "ready", items: result.value } : { kind: "failed" });
    }).catch(() => {
      if (active && !observedUpdate) setLibrary({ kind: "failed" });
    });
    return () => { active = false; unsubscribe(); };
  }, [media, retry]);

  const items = library.kind === "ready" ? library.items : [];
  const itemById = new Map(items.map(item => [item.id, item]));
  const attached = new Set(ids);
  const available = items.filter(item => !attached.has(item.id));
  const chosen = available.find(item => item.id === choice);

  async function act(item: ImportedMedia, action: "preview" | "rift") {
    if (disabled || !open.current || running.current || (action === "rift" && !regions.canSelect)) return;
    running.current = true;
    setBusy(true);
    setFeedback("");
    const message = action === "preview" ? `${copy.previewer} couldn’t preview this attachment.`
      : "AeRift couldn’t select this attachment for Rift.";
    try {
      if (action === "preview") {
        const result = await media.present(item.assetId, "preview");
        if (open.current && !result.ok) setFeedback(message);
      } else {
        const ready = await regions.select(async () => {
          const result = await media.select(item.assetId);
          return result.ok && !result.value ? { ok: false, error: { code: "cancelled" } } : result;
        });
        if (open.current) {
          if (ready) openRift();
          else setFeedback(message);
        }
      }
    } catch {
      if (open.current) setFeedback(message);
    } finally {
      running.current = false;
      if (open.current) setBusy(false);
    }
  }

  return <fieldset className="ios-object-form ios-note-attachments" disabled={disabled}
    aria-busy={busy || library.kind === "pending"}>
    <legend>Attachments</legend>
    {ids.length > 0 && <ul className="ios-list">
      {ids.map((id, index) => {
        const item = itemById.get(id);
        const label = item?.name ?? `Attachment ${index + 1}`;
        return <li key={id}>
          <span>{label}</span>
          {!item && library.kind === "ready" && <small>Imported copy unavailable.</small>}
          <div className="ae-actions" role="group" aria-label={`Actions for ${label}`}>
            {item && <NoteIconButton type="button" icon="preview" label={`Preview ${label}`} disabled={busy}
              onClick={() => act(item, "preview")} />}
            {item && <IconAction type="button" icon="chevron" label={`Select ${label} for Rift`} disabled={busy || !regions.canSelect}
              onClick={() => act(item, "rift")} />}
            <IconAction type="button" icon="close" label={`Detach ${label}`} disabled={busy}
              onClick={() => onChange(ids.filter(candidate => candidate !== id))} />
          </div>
        </li>;
      })}
    </ul>}
    {library.kind === "pending" ? <p role="status">Loading imported copies…</p>
      : library.kind === "failed" ? <div className="ae-actions">
        <p role="status">Imported copies couldn’t load.</p>
        <Button type="button" variant="quiet" className="ae-icon-action aw-note-tool"
          aria-label="Retry loading imported copies" title="Retry loading imported copies" onClick={() => {
          setLibrary({ kind: "pending" });
          setRetry(attempt => attempt + 1);
        }}>
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.65"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M20.5 9A8.5 8.5 0 1 0 20 16m.5-7V4m0 5H16" />
          </svg>
        </Button>
      </div> : available.length > 0 ? <>
        <label htmlFor={chooserId}>Imported copy</label>
        <div className="ae-actions">
          <select id={chooserId} value={chosen?.id ?? ""} disabled={busy}
            onChange={event => setChoice(event.currentTarget.value)}>
            <option value="">Choose a file, photo, or video</option>
            {available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <IconAction type="button" icon="add" label="Attach imported copy" disabled={!chosen || busy}
            onClick={() => {
              if (!chosen) return;
              onChange([...ids, chosen.id]);
              setChoice("");
            }} />
        </div>
      </> : <p>{items.length ? "All imported copies are attached."
        : "Import a copy from Files or Photos and videos to attach it."}</p>}
    {feedback && <p role="status">{feedback}</p>}
  </fieldset>;
}

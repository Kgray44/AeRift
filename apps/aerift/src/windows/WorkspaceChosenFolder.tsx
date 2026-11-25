import { listen } from "@tauri-apps/api/event";
import { Button } from "@aerift/ui";
import { useEffect, useRef, useState } from "react";
import { command } from "../nativeAppPort";

type Grant = { grant: string; cursor: string };
type Entry = { name: string; sizeBytes: number | null };
type Page = { entries: Entry[]; next: string | null };
type OpenFolder = { request: string; grant: string; page: Page; number: number };

function sizeLabel(value: number | null) {
  if (value === null) return "Folder";
  return Number.isSafeInteger(value) ? `${value.toLocaleString()} bytes` : "Size unavailable";
}

function close(request: string) {
  void command<void>("workspace_close_chosen_folder", { request });
}

export function WorkspaceChosenFolder() {
  const mounted = useRef(false);
  const pending = useRef<string | undefined>(undefined);
  const active = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [folder, setFolder] = useState<OpenFolder>();

  function clear() {
    if (pending.current) close(pending.current);
    if (active.current) close(active.current);
    pending.current = undefined;
    active.current = undefined;
    setError(false);
    setFolder(undefined);
  }

  useEffect(() => {
    mounted.current = true;
    let subscribed = true;
    let stop: (() => void) | undefined;
    void listen("workspace-folder-cleared", () => {
      if (subscribed) clear();
    }).then(unlisten => {
      if (subscribed) stop = unlisten;
      else unlisten();
    }).catch(() => {});
    const onVisibility = () => { if (document.visibilityState === "hidden") clear(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      subscribed = false;
      stop?.();
      mounted.current = false;
      if (pending.current) close(pending.current);
      if (active.current) close(active.current);
      pending.current = undefined;
      active.current = undefined;
    };
  }, []);

  async function choose() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    const request = crypto.randomUUID();
    pending.current = request;
    try {
      const chosen = await command<Grant | null>("workspace_choose_folder", { request });
      if (!mounted.current || pending.current !== request) {
        close(request);
        return;
      }
      if (!chosen.ok) {
        setError(true);
        return;
      }
      if (!chosen.value) return;
      const { grant, cursor } = chosen.value;
      active.current = request;
      setFolder(undefined);
      const page = await command<Page>("workspace_list_chosen_folder", { grant, cursor });
      if (!mounted.current || active.current !== request) return;
      if (!page.ok) {
        active.current = undefined;
        close(request);
        setError(true);
        return;
      }
      setFolder({ request, grant, page: page.value, number: 1 });
    } finally {
      if (pending.current === request) pending.current = undefined;
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function next() {
    if (inFlight.current || !folder?.page.next || active.current !== folder.request) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await command<Page>("workspace_list_chosen_folder", { grant: folder.grant, cursor: folder.page.next });
      if (!mounted.current || active.current !== folder.request) return;
      if (!result.ok) {
        active.current = undefined;
        close(folder.request);
        setFolder(undefined);
        setError(true);
        return;
      }
      setFolder({ ...folder, page: result.value, number: folder.number + 1 });
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }


  return <section className="ae-surface aw-file-filter" data-material="control" aria-label="Browse a local folder">
    <h4>Browse a local folder</h4>
    <p>See names and sizes from one folder on this Windows PC. Nothing is imported or sent.</p>
    <div className="ae-actions">
      <Button variant="secondary" disabled={busy} onClick={() => void choose()}>{folder ? "Choose another folder" : "Choose folder"}</Button>
      {(folder || busy) && <Button variant="quiet" onClick={clear}>Clear folder</Button>}
      {folder?.page.next && <Button variant="quiet" disabled={busy} onClick={() => void next()}>Next folder page</Button>}
    </div>
    {busy && <p role="status">Waiting for folder access…</p>}
    {error && <p role="alert">Folder unavailable. Choose a folder on a fixed NTFS drive, or choose it again if access expired.</p>}
    {folder && <>
      <p role="status">Folder page {folder.number}{!folder.page.next && " · End of list"}</p>
      {folder.page.entries.length > 0
        ? <ul>{folder.page.entries.map((entry, index) => <li key={index}>
            <bdi>{entry.name}</bdi> <span>· {sizeLabel(entry.sizeBytes)}</span>
          </li>)}</ul>
        : <p>No visible entries on this page.</p>}
    </>}
  </section>;
}

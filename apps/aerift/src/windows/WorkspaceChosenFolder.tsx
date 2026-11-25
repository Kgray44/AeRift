import { invoke } from "@tauri-apps/api/core";
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

type PickerFailure = "origin" | "owner" | "focus" | "request" | "revoked" | "folder" | "bridge";

const failureMessage: Record<PickerFailure, string> = {
  origin: "Folder browsing is available only in the installed AeRift window.",
  owner: "Close and reopen AeRift to restore folder browsing.",
  focus: "Bring AeRift to the front, then choose a folder again.",
  request: "Finish the open selection or try choosing again.",
  revoked: "Folder access was closed. Choose the folder again.",
  folder: "Choose an accessible folder on a fixed NTFS drive.",
  bridge: "AeRift couldn’t open folder browsing. Try reopening the app.",
};

function pickerFailure(error: unknown): PickerFailure {
  // Never display raw IPC errors, arguments, or native file paths.
  switch (error) {
    case "origin": case "owner": case "focus": case "request": case "revoked": case "folder":
      return error;
    default:
      return "bridge";
  }
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
  const [error, setError] = useState<PickerFailure>();
  const [folder, setFolder] = useState<OpenFolder>();

  function clear() {
    if (pending.current) close(pending.current);
    if (active.current) close(active.current);
    pending.current = undefined;
    active.current = undefined;
    setError(undefined);
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
    setError(undefined);
    const request = crypto.randomUUID();
    pending.current = request;
    try {
      const chosen = await invoke<Grant | null>("workspace_choose_folder", { request });
      if (!mounted.current || pending.current !== request) {
        close(request);
        return;
      }
      if (!chosen) return;
      const { grant, cursor } = chosen;
      active.current = request;
      setFolder(undefined);
      const page = await command<Page>("workspace_list_chosen_folder", { grant, cursor });
      if (!mounted.current || active.current !== request) return;
      if (!page.ok) {
        active.current = undefined;
        close(request);
        setError("revoked");
        return;
      }
      setFolder({ request, grant, page: page.value, number: 1 });
    } catch (error) {
      if (mounted.current && pending.current === request) setError(pickerFailure(error));
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
    setError(undefined);
    try {
      const result = await command<Page>("workspace_list_chosen_folder", { grant: folder.grant, cursor: folder.page.next });
      if (!mounted.current || active.current !== folder.request) return;
      if (!result.ok) {
        active.current = undefined;
        close(folder.request);
        setFolder(undefined);
        setError("revoked");
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
    {error && <p role="alert" data-folder-error={error}>{failureMessage[error]}</p>}
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

import { useEffect, useRef, useState } from "react";
import { Button, GlassSurface } from "@aerift/ui";
import { command } from "../nativeAppPort";

type Candidate = {
  peer: string;
  id: string;
  name: string;
  sizeBytes: number;
  requestedDestination: "inbox" | "external_requires_authorization";
};
type Page = { entries: Candidate[]; truncated: boolean };
const keyOf = (entry: Candidate) => `${entry.peer}:${entry.id}`;

type ExplorerDelivery = { state: "idle" | "armed" | "resolving" | "saving" } |
  { state: "review"; id: string; name: string; folder: string };

export function DesktopInbox({ contextualEnabled = false }: { contextualEnabled?: boolean }) {
  const [explorerBusy, setExplorerBusy] = useState(false);
  const [explorerView, setExplorerView] = useState<ExplorerDelivery>();
  const [explorerNotice, setExplorerNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<Page>();
  const [listing, setListing] = useState(true);
  const [listError, setListError] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [saved, setSaved] = useState<{ key: string; ok: boolean }>();
  const [result, setResult] = useState<{ key: string; ok: boolean }>();
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    let stale = false;
    setListing(true);
    setList(undefined);
    setListError(false);
    setResult(undefined);
    setSaved(undefined);
    void command<Page>("list_ambient_inbox", { query: filter }).then(response => {
      if (stale) return;
      setListing(false);
      if (response.ok) setList(response.value);
      else setListError(true);
    });
    return () => { stale = true; };
  }, [filter, refresh]);

  useEffect(() => {
    if (!explorerView || explorerView.state === "idle" || !contextualEnabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refreshExplorer() {
      const result = await command<ExplorerDelivery>("view_explorer_receive");
      if (disposed) return;
      if (result.ok && result.value.state === "idle") {
        setExplorerView(undefined);
        setExplorerNotice("No Explorer destination is available. The Inbox copy is unchanged.");
      } else if (result.ok) {
        setExplorerView(result.value);
      } else {
        timer = setTimeout(refreshExplorer, 350);
      }
    }
    timer = setTimeout(refreshExplorer, 350);
    return () => { disposed = true; clearTimeout(timer); };
  }, [explorerView, contextualEnabled]);

  async function armExplorer(entry: Candidate) {
    setExplorerBusy(true);
    setExplorerNotice("");
    const result = await command("arm_explorer_receive", { peer: entry.peer, receipt: entry.id });
    setExplorerBusy(false);
    if (result.ok) setExplorerView({ state: "armed" });
    else setExplorerNotice("Couldn't arm that Inbox item. Check the receipt and confirm the shortcut is available.");
  }

  async function confirmExplorer(id: string) {
    setExplorerBusy(true);
    const result = await command("confirm_explorer_receive", { id });
    setExplorerBusy(false);
    setExplorerView(undefined);
    setExplorerNotice(result.ok ? "Verified copy saved to the confirmed Explorer folder." :
      "No copy was saved. The Inbox original is unchanged.");
  }

  async function cancelExplorer() {
    setExplorerView(undefined);
    await command("cancel_explorer_receive");
    setExplorerNotice("Cancellation requested. The Inbox original is unchanged.");
  }

  async function verify(entry: Candidate) {
    if (checking || saving) return;
    const key = keyOf(entry);
    setChecking(key);
    setResult(undefined);
    const verified = await command<void>("verify_ambient_inbox_entry", { peer: entry.peer, id: entry.id });
    if (!live.current) return;
    setChecking(undefined);
    setResult({ key, ok: verified.ok });
  }

  async function save(entry: Candidate) {
    if (saving || checking) return;
    const key = keyOf(entry);
    setSaving(key);
    setSaved(undefined);
    const response = await command<boolean>("save_ambient_inbox_entry", { peer: entry.peer, id: entry.id });
    if (!live.current) return;
    setSaving(undefined);
    if (!response.ok || response.value) setSaved({ key, ok: response.ok });
  }

  return <GlassSurface material="content">
    <section aria-label="Inbox">
      <h2>Inbox</h2>
      <p>Files you explicitly accepted to Inbox stay here across app restarts. Check intact files before relying on them. Nothing opens automatically.</p>
      <form onSubmit={event => { event.preventDefault(); setFilter(query); setRefresh(next => next + 1); }}>
        <label>Find a file <input value={query} maxLength={64} onChange={event => setQuery(event.target.value)} /></label>
        <Button type="submit" disabled={!!checking || !!saving}>Search or refresh</Button>
      </form>
      {contextualEnabled && explorerView && <div aria-label="Explorer destination confirmation">
        {explorerView.state === "armed" && <p>Open the destination in File Explorer and press Ctrl + Alt + Shift + F within 30 seconds. Then return here to confirm.</p>}
        {explorerView.state === "resolving" && <p>Checking the focused Explorer folder…</p>}
        {explorerView.state === "review" && <>
          <p>Save a verified copy of <strong>{explorerView.name}</strong> to:</p>
          <p><strong>{explorerView.folder}</strong></p>
          <Button disabled={explorerBusy} onClick={() => void confirmExplorer(explorerView.id)}>Save to this folder</Button>
        </>}
        {explorerView.state === "saving" && <p>Verifying and saving the copy…</p>}
        <Button variant="quiet" onClick={() => void cancelExplorer()}>Cancel Explorer save</Button>
      </div>}
      {explorerNotice && <p role="status">{explorerNotice}</p>}
      {listing && <p role="status">Loading Inbox…</p>}
      {listError && <p role="alert">Could not read the Inbox. Your regular receive folder is unaffected.</p>}
      {!!list?.truncated && <p>Showing a bounded recovery scan. Not all files may be listed.</p>}
      {list?.entries.length === 0 && <p>No matching files.</p>}
      {!!list?.entries.length && <ul>{list.entries.map(entry => {
        const key = keyOf(entry);
        return <li key={key}>
          <strong>{entry.name}</strong> · {entry.sizeBytes.toLocaleString()} bytes
          {entry.requestedDestination === "external_requires_authorization" && <p>Saved here because external delivery needs approval.</p>}
          <Button variant="quiet" disabled={!!checking || !!saving} onClick={() => void verify(entry)}>
            {checking === key ? "Checking…" : "Check integrity"}
          </Button>
          <Button variant="quiet" disabled={!!checking || !!saving} onClick={() => void save(entry)}>
            {saving === key ? "Saving…" : "Save a copy"}
          </Button>
          {contextualEnabled && <Button variant="quiet" disabled={explorerBusy || !!explorerView}
            onClick={() => void armExplorer(entry)}>Choose Explorer folder</Button>}
          {saved?.key === key && <p role="status">{saved.ok ? "Verified copy saved." : "No copy was saved. Choose a new filename and check the file’s integrity."}</p>}
          {result?.key === key && <p role="status">{result.ok ? "File integrity verified." : "Could not verify this file. It was not opened or moved."}</p>}
        </li>;
      })}</ul>}
    </section>
  </GlassSurface>;
}

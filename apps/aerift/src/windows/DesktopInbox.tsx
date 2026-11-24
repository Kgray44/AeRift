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

export function DesktopInbox() {
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
          {saved?.key === key && <p role="status">{saved.ok ? "Verified copy saved." : "No copy was saved. Choose a new filename and check the file’s integrity."}</p>}
          {result?.key === key && <p role="status">{result.ok ? "File integrity verified." : "Could not verify this file. It was not opened or moved."}</p>}
        </li>;
      })}</ul>}
    </section>
  </GlassSurface>;
}

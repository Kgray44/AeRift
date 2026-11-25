import { useEffect, useRef, useState } from "react";
import { Button, IconAction } from "@aerift/ui";
import { ReceivedActivity } from "../ReceivedActivity";
import { command } from "../nativeAppPort";

type Candidate = {
  peer: string;
  id: string;
  name: string;
  sizeBytes: number;
  requestedDestination: "inbox" | "external_requires_authorization";
  receivedAtUnixMs?: number;
};
type Page = { entries: Candidate[]; truncated: boolean };
const keyOf = (entry: Candidate) => `${entry.peer}:${entry.id}`;
// Descriptive availability only; the native command performs all security checks.
const canReadText = (entry: Candidate) => /\.(txt|text|md|csv|tsv|log)$/iu.test(entry.name) &&
  Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0 && entry.sizeBytes <= 65_536;

type ExplorerDelivery = { state: "idle" | "armed" | "resolving" | "saving" } |
  { state: "review"; id: string; name: string; folder: string };

export function DesktopInbox({ contextualEnabled = false, openVerified, previewVerified }: {
  contextualEnabled?: boolean;
  openVerified?: (entry: Pick<Candidate, "peer" | "id">) => boolean | Promise<boolean>;
  previewVerified?: (entry: Pick<Candidate, "peer" | "id">) => boolean | Promise<boolean>;
}) {
  const [explorerBusy, setExplorerBusy] = useState(false);
  const [explorerView, setExplorerView] = useState<ExplorerDelivery>();
  const [explorerNotice, setExplorerNotice] = useState("");
  const [filter, setFilter] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<Page>();
  const [timelineEntries, setTimelineEntries] = useState<readonly Candidate[]>([]);
  const [listing, setListing] = useState(true);
  const [listError, setListError] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [saved, setSaved] = useState<{ key: string; ok: boolean }>();
  const [result, setResult] = useState<{ key: string; ok: boolean }>();
  const [textPreview, setTextPreview] = useState<{ key: string; text: string }>();
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
    setTextPreview(undefined);
    void command<Page>("list_ambient_inbox", { query: filter }).then(response => {
      if (stale) return;
      setListing(false);
      if (response.ok) {
        setList(response.value);
        if (!filter) setTimelineEntries(response.value.entries);
      }
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
    else setExplorerNotice("Couldn't arm that Inbox item. Check that the Explorer shortcut is available and try again.");
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

  async function preview(entry: Candidate) {
    setTextPreview(undefined);
    if (previewVerified) return previewVerified({ peer: entry.peer, id: entry.id });
    if (!canReadText(entry)) return false;
    const response = await command<string | null>("preview_ambient_inbox_text", { peer: entry.peer, id: entry.id });
    if (!live.current || !response.ok || typeof response.value !== "string") return false;
    setTextPreview({ key: keyOf(entry), text: response.value });
    return true;
  }

  function toRow(entry: Candidate) {
    const time = entry.receivedAtUnixMs;
    const receivedAt = typeof time === "number" && Number.isSafeInteger(time) && time > 0 &&
      time <= 8_640_000_000_000_000 ? new Date(time).toISOString() : undefined;
    return {
      id: keyOf(entry),
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      receivedAt,
      note: entry.requestedDestination === "external_requires_authorization" ?
        "External delivery needs approval." : undefined,
      receipt: entry,
    };
  }
  return <ReceivedActivity title="Inbox" rows={(list?.entries ?? []).map(toRow)} timelineRows={timelineEntries.map(toRow)} loading={listing} truncated={list?.truncated}
    disabled={!!checking || !!saving}
    error={listError ? "Could not read the Inbox. Your regular receive folder is unaffected." : undefined}
    onSearch={query => { setFilter(query.trim()); setRefresh(next => next + 1); }}
    onRefresh={() => setRefresh(next => next + 1)}
    onOpen={openVerified ? ({ receipt }) => openVerified({ peer: receipt.peer, id: receipt.id }) : undefined}
    canPreview={({ receipt }) => !!previewVerified || canReadText(receipt)}
    onPreview={({ receipt }) => preview(receipt)}
    renderPreview={row => textPreview?.key === row.id && <pre className="aw-received-text"><code>{textPreview.text}</code></pre>}
    renderActions={row => {
      const entry = row.receipt;
      const key = row.id;
      return <>
          <div className="aerift-inbox-tools">
            <IconAction icon="check" label={`Check integrity for ${entry.name}`} disabled={(!!checking && checking !== key) || !!saving}
              loading={checking === key} onClick={() => void verify(entry)} />
            <IconAction icon="drop" label={`Save a copy of ${entry.name}`} disabled={!!checking || (!!saving && saving !== key)}
              loading={saving === key} onClick={() => void save(entry)} />
            {contextualEnabled && <IconAction icon="folder" label={`Choose Explorer folder for ${entry.name}`}
              disabled={explorerBusy || !!explorerView} onClick={() => void armExplorer(entry)} />}
          </div>
          {saved?.key === key && <p role="status">{saved.ok ? "Verified copy saved." : "No copy was saved. Choose a new filename and check the file’s integrity."}</p>}
          {result?.key === key && <p role="status">{result.ok ? "File integrity verified." : "Could not verify this file. It was not opened or moved."}</p>}
      </>;
    }}>
      {contextualEnabled && explorerView && <div className="aerift-inbox-review" aria-label="Explorer destination confirmation">
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
  </ReceivedActivity>;
}

import type { Transfer } from "@aerift/app-contract";
import { useEffect, useRef, useState } from "react";
import { IconAction } from "@aerift/ui";
import { ReceivedActivity } from "../ReceivedActivity";
import { mobileReceivedRows } from "./mobile-received-activity";
import type { MobileOperations, ReceivedCopy } from "./mobile-platform";

export function MobileReceivedActivity({ transfers, liveTransfers, operations, receivedTip }: {
  transfers: readonly Transfer[];
  liveTransfers: readonly Transfer[];
  operations: Pick<MobileOperations, "listReceived" | "presentReceived" | "previewReceivedText">;
  receivedTip: string;
}) {
  const [catalog, setCatalog] = useState<readonly ReceivedCopy[]>();
  const [loading, setLoading] = useState(!!operations.listReceived);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const latestArrival = JSON.stringify(transfers.filter(item => item.direction === "incoming" && item.state === "completed").map(item => item.id).sort());
  useEffect(() => {
    if (!operations.listReceived) return;
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void operations.listReceived().then(result => {
      if (disposed) return;
      if (result.ok && Array.isArray(result.value)) setCatalog(result.value);
      else setError("Could not refresh files on this device.");
      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setLoading(false);
      setError("Could not refresh files on this device.");
    });
    return () => { disposed = true; };
  }, [latestArrival, operations, refresh]);

  const open = catalog && operations.presentReceived
    ? async (item: {id: string}) => (await operations.presentReceived?.(item.id, "preview"))?.ok === true
    : undefined;
  const textPreview = operations.previewReceivedText;
  const liveCompleted = new Set(liveTransfers.filter(item => item.direction === "incoming" && item.state === "completed")
    .map(item => item.id));
  return <ReceivedActivity rows={mobileReceivedRows(transfers, catalog)} loading={loading} error={error}
    renderPreview={textPreview ? item => liveCompleted.has(item.id) && item.sizeBytes <= 64 * 1024 &&
      /\.(?:txt|md|csv|json|log)$/iu.test(item.name)
      ? <IosReceivedTextPreview key={item.id} receiptId={item.id} preview={textPreview} />
      : undefined : undefined}
    onOpen={open} onRefresh={operations.listReceived ? () => setRefresh(value => value + 1) : undefined}>
    <p>{receivedTip}</p>
    {textPreview && <p>In-app text preview is available for eligible verified receipts from this app session only.</p>}
  </ReceivedActivity>;
}


function IosReceivedTextPreview({ receiptId, preview }: {
  receiptId: string;
  preview: NonNullable<MobileOperations["previewReceivedText"]>;
}) {
  const generation = useRef(0);
  const [state, setState] = useState<{ kind: "idle" | "loading" | "unavailable" | "failed" } |
    { kind: "ready"; text: string }>({ kind: "idle" });
  useEffect(() => () => { ++generation.current; }, []);
  async function open() {
    const request = ++generation.current;
    setState({ kind: "loading" });
    try {
      const result = await preview(receiptId);
      if (generation.current !== request) return;
      setState(!result.ok ? { kind: "failed" } : typeof result.value === "string" && result.value.length <= 64 * 1024
        ? { kind: "ready", text: result.value } : { kind: "unavailable" });
    } catch {
      if (generation.current === request) setState({ kind: "failed" });
    }
  }
  return <div>
    <IconAction label="Preview verified text" icon="maximize" loading={state.kind === "loading"}
      onClick={() => { if (state.kind !== "loading") void open(); }} />
    {state.kind === "ready" && <pre aria-label="Verified plain text"
      style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxBlockSize: "18rem", overflow: "auto" }}>
      {state.text || "(Empty text file)"}
    </pre>}
    {state.kind === "unavailable" && <p role="status">This copy is not supported as plain text.</p>}
    {state.kind === "failed" && <p role="alert">AeRift could not verify and preview this copy. It was not changed.</p>}
  </div>;
}

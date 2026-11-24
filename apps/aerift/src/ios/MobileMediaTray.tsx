import { isWorkspaceDocument } from "../workspace-categories";
import type { MobilePlatformCopy } from "./mobile-platform";
import { useEffect, useRef, useState } from "react";
import { getObjectPresentation } from "@aerift/app-contract/digital-objects";
import { Button, formatFileSize, type TransferWorkspaceRegions } from "@aerift/ui";
import type { Result } from "@aerift/app-contract";
import type { ImportedMedia, MediaSource } from "./mobile-media";
import type { ObservedMediaPort } from "./mobile-media-observer";

const mediaNames = { file: "File", photo: "Photo", video: "Video" };

export function MobileMediaTray({ source, documents = false, port, regions, copy }: {
  source: MediaSource;
  documents?: boolean;
  copy: MobilePlatformCopy;
  port: ObservedMediaPort;
  regions: TransferWorkspaceRegions;
}) {
  const [imports, setImports] = useState<readonly ImportedMedia[]>();
  const [busy, setBusy] = useState(false);
  const [initialFailure, setInitialFailure] = useState(false);
  const [reload, setReload] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const running = useRef(false);

  useEffect(() => {
    let current = true;
    setInitialFailure(false);
    const unsubscribe = port.subscribe(items => {
      setImports(items);
      setInitialFailure(false);
    });
    void port.list().then(result => {
      if (!current) return;
      if (result.ok) setImports(result.value);
      else setInitialFailure(true);
    }).catch(() => {
      if (current) setInitialFailure(true);
    });
    return () => { current = false; unsubscribe(); };
  }, [port, reload]);

  async function run(action: () => Promise<Result<unknown>>, errorMessage: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const result = await action();
      if (!result.ok) setError(result.error.code === "conflict" ?
        "The import library is full. Remove items before importing more." : errorMessage);
    } catch {
      setError(errorMessage);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function importItems() {
    const result = await port.import(source);
    if (result.ok) {
      const count = result.value.length - (imports?.length ?? 0);
      setImports(result.value);
      if (count > 0) setFeedback(count === 1 ? "1 item imported." : `${count} items imported.`);
    }
    return result;
  }

  function remove(item: ImportedMedia) {
    void run(async () => {
      const result = await port.remove(item.assetId);
      if (result.ok) setImports(result.value);
      return result;
    }, "AeRift couldn’t remove this imported copy.");
  }

  function select(item: ImportedMedia) {
    void run(async () => {
      const ready = await regions.select(async () => {
        const result = await port.select(item.assetId);
        return result.ok && !result.value ? { ok: false, error: { code: "cancelled" } } : result;
      });
      if (ready) setFeedback(`${item.name} is ready in Rift.`);
      return ready ? { ok: true, value: undefined } : { ok: false, error: { code: "cancelled" } };
    }, "AeRift couldn’t select this item for Rift.");
  }

  const items = (imports ?? []).filter(item => (item.kind === "file") === (source === "files") && (!documents || isWorkspaceDocument(item.name)));

  return <section className="ae-surface ios-section ios-imports aw-focused-surface" data-material="content" aria-label={documents ? "Imported documents" : source === "files" ? "Imported files" : "Imported photos and videos"} aria-busy={busy}>
    <h3>{documents ? "Imported documents" : "Imported copies"}</h3>
    <p>Keep up to 24 copies on {copy.device}. Your originals stay in place.</p>
    {initialFailure ?
      <Button variant="quiet" onClick={() => setReload(attempts => attempts + 1)}>Retry loading imports</Button> : !documents &&
      <Button disabled={busy || regions.selecting || !imports || imports.length >= 24} onClick={() =>
        void run(importItems, `AeRift couldn’t import these items. Check that they’re available and that there’s space on ${copy.device}.`)}>
        {source === "files" ? "Import files" : "Import photos or videos"}
      </Button>}
    {imports && imports.length >= 24 && <p>The library holds 24 items. Remove an imported copy to make space.</p>}
    {documents && imports && !items.length && <p>No imported documents. Import files in File Browser to see them here.</p>}
    {items.length > 0 && <ol className="ios-object-list">
      {items.map(item => <li key={item.assetId}>
        <strong>{getObjectPresentation(item).label}</strong>
        <small>{mediaNames[item.kind]} · {formatFileSize(item.sizeBytes)}</small>
        <div className="ae-actions">
          <Button disabled={busy || !regions.canSelect} onClick={() => select(item)}>Select for Rift</Button>
          <Button variant="quiet" disabled={busy} onClick={() =>
            void run(() => port.present(item.assetId, "preview"), `${copy.previewer} couldn’t preview this item.`)}>Preview</Button>
          <Button variant="quiet" disabled={busy} onClick={() =>
            void run(() => port.present(item.assetId, "export"), "AeRift couldn’t open sharing for this item.")}>Export copy</Button>
          <Button variant="quiet" disabled={busy} aria-label={`Remove ${item.name}`} onClick={() => remove(item)}>Remove</Button>
        </div>
      </li>)}
    </ol>}
    {feedback && <p role="status">{feedback}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

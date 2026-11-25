import { useEffect, useState } from "react";
import type { TransferWorkspaceRegions } from "@aerift/ui";
import { WorkspaceDocumentsGallery } from "../WorkspaceDocumentsGallery";
import { isWorkspaceDocument } from "../workspace-categories";
import type { ImportedMedia } from "./mobile-media";
import type { ObservedMediaPort } from "./mobile-media-observer";
import type { MobilePlatform } from "./mobile-platform";

const isDocument = (item: ImportedMedia) => item.kind === "file" &&
  isWorkspaceDocument(item.name, item.mediaType);

export function MobileDocumentsGallery({ port, platform, regions }: {
  port: ObservedMediaPort;
  platform: MobilePlatform;
  regions: TransferWorkspaceRegions;
}) {
  const [imports, setImports] = useState<readonly ImportedMedia[]>();
  const [failure, setFailure] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setFailure(false);
    const stop = port.subscribe(items => { if (live) { setImports(items); setFailure(false); } });
    void port.list().then(result => {
      if (!live) return;
      if (result.ok) setImports(result.value);
      else setFailure(true);
    }, () => { if (live) setFailure(true); });
    return () => { live = false; stop(); };
  }, [port, revision]);

  const catalog = (imports ?? []).filter(isDocument).map(item => ({
    id: item.assetId, name: item.name, sizeBytes: item.sizeBytes,
  }));
  const onPick = async () => {
    const before = new Set((imports ?? []).map(item => item.assetId));
    const result = await port.import("files");
    if (!result.ok) {
      if (result.error.code === "cancelled") return [];
      throw new Error("The document picker could not add copies.");
    }
    const added = result.value.filter(item => !before.has(item.assetId));
    if (added.length > 0 && added.every(item => !isDocument(item))) {
      throw new Error("No supported documents were selected. Other imports are available in File Browser.");
    }
    return added.filter(isDocument).map(item => item.assetId);
  };
  return <>
    {failure && <p role="alert">AeRift couldn’t load document copies. <button type="button" onClick={() => setRevision(n => n + 1)}>Retry</button></p>}
    {!failure && !imports && <p role="status">Loading documents…</p>}
    <WorkspaceDocumentsGallery catalog={catalog} scope={platform} disabled={!imports || regions.selecting}
      onPick={imports && imports.length < 24 ? onPick : undefined}
      onPreview={async row => (await port.present(row.id, "preview")).ok}
      onExport={async row => (await port.present(row.id, "export")).ok}
      onRemove={async id => (await port.remove(id)).ok}
      onSelect={regions.canSelect ? row => regions.select(() => port.select(row.id)) : undefined}
      selectLabel="Select for Rift"
      emptyText="No documents here yet. Use the plus icon to import a copy." />
    {imports && imports.length >= 24 && <p>The library holds 24 items. Remove an imported copy to make space.</p>}
  </>;
}

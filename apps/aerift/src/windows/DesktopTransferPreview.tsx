import type { Transfer } from "@aerift/app-contract";
import { GlassSurface, RiftExperience, ThemeProvider } from "@aerift/ui";
import { useEffect, useState } from "react";
import { command } from "../nativeAppPort";
import { readDesktopPreferences } from "./preferences";
import "./desktop.css";

export function DesktopTransferPreview() {
  const [appearance] = useState(() => readDesktopPreferences().experience);
  const [transfer, setTransfer] = useState<Transfer | null>();
  useEffect(() => {
    let disposed = false;
    let transferId: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      const result = await command<Transfer | null>("desktop_transfer_preview", { transferId });
      if (disposed) return;
      const value = result.ok ? result.value : null;
      setTransfer(value);
      transferId = value?.id;
      timer = setTimeout(update, 400);
    }
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  return <ThemeProvider {...appearance}>
    <GlassSurface material="overlay" className="aerift-transfer-preview" role="region" aria-labelledby="preview-title">
      <h1 id="preview-title">Transfer preview</h1>
      {transfer ? <RiftExperience transfer={transfer} compactPath /> :
        <p>{transfer === undefined ? "Checking transfers…" : "No active transfers."}</p>}
    </GlassSurface>
  </ThemeProvider>;
}

import { advanceAmbientChoreography, isAmbientTerminal, type AmbientChoreographyFrame, type AmbientPhase } from "@aerift/app-contract/ambient-experience";
import { Channel } from "@tauri-apps/api/core";
import { ThemeProvider } from "@aerift/ui";
import { useEffect, useState } from "react";
import { command } from "../nativeAppPort";
import { AmbientLiquid } from "./AmbientLiquid";
import { readDesktopPreferences } from "./preferences";
import "./desktop.css";

const labels: Record<AmbientPhase, string> = {
  hand: "Ready to pick up", context: "Object ready", "picked-up": "Picked up", held: "Carrying",
  ambiguous: "More than one destination", "destination-ready": "Destination ready",
  released: "Released", offering: "Offering transfer", "awaiting-acceptance": "Waiting for acceptance",
  transferring: "Sending", receiving: "Receiving", arriving: "Arriving", completed: "Delivery verified",
  cancelled: "Transfer cancelled", expired: "Transfer expired", rejected: "Transfer declined",
  disconnected: "Connection lost", interrupted: "Transfer interrupted", failed: "Transfer failed",
};

/** One opt-in read-only observation subscription. No sender, camera, or capture actions. */
export function DesktopTransferPreview() {
  const [appearance] = useState(() => readDesktopPreferences().experience);
  const [frame, setFrame] = useState<AmbientChoreographyFrame>();

  useEffect(() => {
    let disposed = false;
    let current: AmbientChoreographyFrame | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    document.documentElement.dataset.aeriftAmbientPreview = "";
    const updates = new Channel<unknown>((value) => {
      if (disposed) return;
      if (value === null) {
        setFrame(undefined);
        return;
      }
      const next = advanceAmbientChoreography(current, value);
      if (next === current) return;
      setFrame(next);
      current = next;
      if (current && isAmbientTerminal(current.phase)) {
        // Never hold up transport ACKs or writes for this transient animation.
        timer = setTimeout(() => setFrame(undefined), 1100);
      }
    });
    const startup = setTimeout(() => { void command("desktop_transfer_preview", { updates }); }, 0);
    return () => {
      disposed = true;
      updates.onmessage = () => {};
      clearTimeout(startup);
      clearTimeout(timer);
      delete document.documentElement.dataset.aeriftAmbientPreview;
    };
  }, []);
  if (!frame) return null;

  return <ThemeProvider {...appearance}>
    <div className="ae-ambient-overlay" data-ambient-phase={frame.phase}
      role="status" aria-live="polite">
      <AmbientLiquid reduce={appearance.motion === "reduce"} />
      <div className="ae-ambient-label">
        <strong>{labels[frame.phase]}</strong>
        {frame.count !== undefined && <small>{frame.count} {frame.count === 1 ? "object" : "objects"}</small>}
        {frame.progress !== undefined && <progress max={1} value={frame.progress} aria-label="Transfer progress" />}
      </div>
    </div>
  </ThemeProvider>;
}

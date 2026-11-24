import { Button } from "@aerift/ui";
import { useEffect, useRef, useState } from "react";
import { command } from "../nativeAppPort";

type View = { state: "unavailable" | "ready" | "waiting" | "held" } |
  { state: "review"; id: string; kind: string; literal: string };

export function BrowserPickupSettings() {
  const [view, setView] = useState<View>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    let live = true;
    async function read() {
      const request = ++revision.current;
      const result = await command<View>("browser_review_status");
      if (live && revision.current === request) setView(result.ok ? result.value : { state: "unavailable" });
    }
    void read();
    // No monitoring or browser requests. Refresh on explicit return to Settings.
    function hide() {
      revision.current++;
      setView(current => current?.state === "review" ? undefined : current);
    }
    window.addEventListener("focus", read);
    window.addEventListener("blur", hide);
    return () => {
      live = false;
      revision.current++;
      window.removeEventListener("focus", read);
      window.removeEventListener("blur", hide);
    };
  }, []);

  async function retain(id: string) {
    const request = ++revision.current;
    setBusy(true);
    setError(false);
    const result = await command<View>("retain_browser_review", { id });
    setBusy(false);
    if (revision.current !== request) return;
    if (result.ok) setView(result.value);
    else { setView(undefined); setError(true); }
  }
  async function clear() {
    const request = ++revision.current;
    setView(undefined); // Immediately retire the visible literal.
    setBusy(true);
    const result = await command("clear_browser_review");
    const current = await command<View>("browser_review_status");
    setBusy(false);
    if (revision.current !== request) return;
    setError(!result.ok);
    if (current.ok) setView(current.value);
  }

  return <section aria-labelledby="browser-pickup-heading">
    <h3 id="browser-pickup-heading">Browser pickup</h3>
    {view?.state === "unavailable" && <p>Browser pickup is not connected. This build does not include a trusted Chrome or Edge companion. You can still add links manually in Workspace → Web Browser.</p>}
    {view?.state === "ready" && <p>Connected. Waiting for an explicitly authorized browser pickup.</p>}
    {view?.state === "waiting" && <p>Waiting for the browser selection.</p>}
    {view?.state === "review" && <>
      <p>Review the exact browser selection. Nothing is opened, saved or sent.</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "12rem", overflow: "auto" }}>{view.literal}</pre>
      <Button disabled={busy} onClick={() => void retain(view.id)}>Keep this selection</Button>
    </>}
    {view?.state === "held" && <p role="status">Selection held locally. Not sent.</p>}
    {(view?.state === "review" || view?.state === "waiting" || view?.state === "held") &&
      <Button variant="quiet" disabled={busy} onClick={() => void clear()}>Discard selection</Button>}
    {error && <p role="alert">The browser selection is no longer available or was not confirmed.</p>}
  </section>;
}

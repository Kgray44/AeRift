import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppShell, Button, ThemeProvider } from "@aerift/ui";
import type { ReactNode } from "react";
import { PrivateRemoteDev } from "./PrivateRemoteDev";
import { readDesktopPreferences } from "./preferences";

type Mode = { current: "nearby" | "remote" | "unavailable"; nextEndpoint: string | null; restartNeeded: boolean };

export function WindowsTransferMode({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode | "error">();
  useEffect(() => {
    let live = true;
    void invoke<Mode>("windows_remote_mode").then((value) => {
      if (live) setMode(value);
    }).catch(() => { if (live) setMode("error"); });
    return () => { live = false; };
  }, []);
  if (mode && mode !== "error" && mode.current === "nearby") return <>{children}</>;
  return <ThemeProvider {...readDesktopPreferences().experience}>
    <AppShell brand={<h1 className="aerift-title">AeRift</h1>}>
      {mode === undefined ? <p role="status">Checking transfer mode…</p>
        : mode === "error" ? <p role="alert">Transfer mode is unavailable. Exit and reopen AeRift to retry.</p>
        : <>
          {mode.current === "remote" && <PrivateRemoteDev product />}
          {mode.current === "unavailable" && <p role="alert">Windows could not read the saved transfer mode. No listener was started.</p>}
          <RemoteModeSettings />
        </>}
    </AppShell>
  </ThemeProvider>;
}

export function RemoteModeSettings() {
  const [mode, setMode] = useState<Mode>();
  const [endpoint, setEndpoint] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void invoke<Mode>("windows_remote_mode").then((value) => {
      if (live) { setMode(value); setEndpoint(value.nextEndpoint ?? ""); }
    }).catch(() => { if (live) setError("Remote settings are unavailable."); });
    return () => { live = false; };
  }, []);
  async function save(next: string | null) {
    setError("");
    setBusy(true);
    try {
      await invoke("windows_set_remote_mode", { endpoint: next, confirmed: next === null || authorized });
      const value = await invoke<Mode>("windows_remote_mode");
      setMode(value); setEndpoint(value.nextEndpoint ?? ""); setAuthorized(false);
    } catch {
      setError("Could not save the transfer mode. Use a local private overlay IPv4 address and a port from 1024 through 65535.");
    } finally { setBusy(false); }
  }
  return <section className="ae-private-remote-dev" aria-label="Remote transfer settings">
    <h2>Remote transfers over a private VPN</h2>
    <p>Use a private VPN you already control, such as Tailscale. AeRift never searches that network for devices.
      Remote invitations and permissions are separate from Nearby pairing.</p>
    <p>Nearby and Remote cannot run together on Windows yet. The choice applies after you exit and reopen AeRift.
      Remote does not start listening until you choose to start it.</p>
    <form onSubmit={(event) => { event.preventDefault(); void save(endpoint.trim()); }}>
      <label>This computer’s VPN IPv4 address and port
        <input value={endpoint} placeholder="100.x.y.z:48888" maxLength={22} spellCheck={false} autoComplete="off"
          onChange={(event) => { setEndpoint(event.target.value); setAuthorized(false); }} />
      </label>
      <label><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />
        I authorize this private VPN address and want to use Remote instead of Nearby.
      </label>
      <Button type="submit" disabled={!mode || !authorized || !endpoint.trim() || busy}>Use Remote after reopening</Button>
    </form>
    <Button disabled={!mode || (mode.current === "nearby" && !mode.nextEndpoint) || busy}
      onClick={() => void save(null)}>Use Nearby after reopening</Button>
    {mode?.restartNeeded && <p role="status">Saved. Finish any transfers before exiting and reopening AeRift.
      <Button disabled={busy} onClick={() => {
        void invoke("windows_exit_for_remote_mode").catch(() => setError("Could not exit. Quit AeRift from the system tray or close the Remote window."));
      }}>Exit AeRift</Button>
    </p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

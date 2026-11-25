import { Button, GlassSurface } from "@aerift/ui";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  clearWorkspaceBrowserHistory, readWorkspaceBrowserHistory, recordWorkspaceBrowserLaunch,
  setWorkspaceBrowserHistory, workspaceBrowserDestination, workspaceBrowserHistoryEvent, workspaceBrowserSearch,
} from "./workspace-browser-tools";

interface BrowserToolsProps {
  storageKey: string;
  /** Use the platform's isolated browser or system opener; never navigate the app WebView. */
  onOpen: (url: string) => Promise<boolean>;
  labels?: { open?: string; description?: string };
  disabled?: boolean;
}

const historyDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function WorkspaceBrowserTools({ storageKey, onOpen, labels, disabled = false }: BrowserToolsProps) {
  const heading = useId();
  const historyHeading = useId();
  const [value, setValue] = useState("");
  const [history, setHistory] = useState(() => readWorkspaceBrowserHistory(storageKey));
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const launching = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    function refresh() { setHistory(readWorkspaceBrowserHistory(storageKey)); }
    function otherWindow(event: StorageEvent) { if (!event.key || event.key === storageKey) refresh(); }
    function sameWindow(event: Event) {
      if (event instanceof CustomEvent && event.detail === storageKey) refresh();
    }
    refresh();
    window.addEventListener("storage", otherWindow);
    window.addEventListener(workspaceBrowserHistoryEvent, sameWindow);
    return () => {
      window.removeEventListener("storage", otherWindow);
      window.removeEventListener(workspaceBrowserHistoryEvent, sameWindow);
    };
  }, [storageKey]);

  async function launch(url: string, remember: boolean) {
    if (launching.current || disabled) return;
    const keep = remember && readWorkspaceBrowserHistory(storageKey).enabled;
    launching.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!await onOpen(url)) {
        setError("Could not open the page.");
        return;
      }
      if (keep && !recordWorkspaceBrowserLaunch(storageKey, url)) {
        setError("The page opened, but AeRift could not save this visit.");
      }
    } catch {
      setError("Could not open the page.");
    } finally {
      launching.current = false;
      setBusy(false);
    }
  }

  function navigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const search = submitter instanceof HTMLButtonElement && submitter.value === "search";
    const destination = search ? workspaceBrowserSearch(value) : workspaceBrowserDestination(value);
    if (!destination) {
      setNotice("");
      setError(search ? "Enter search words, not a web address." : "Enter a valid HTTP or HTTPS address without credentials.");
      return;
    }
    void launch(destination, !search);
  }

  function setRemember(enabled: boolean) {
    setError("");
    setNotice("");
    if (setWorkspaceBrowserHistory(storageKey, enabled)) {
      if (!enabled) {
        setShowHistory(false);
        setNotice("Browser history is off and previous visits were cleared.");
      }
    } else setError("AeRift could not update browser history.");
  }

  function clearHistory() {
    setError("");
    setNotice("");
    if (clearWorkspaceBrowserHistory(storageKey)) setNotice("Browser history cleared.");
    else setError("AeRift could not clear browser history.");
  }

  const visible = showHistory ? history.items : history.items.slice(0, 6);
  return <GlassSurface material="content" className="aw-browser-tools aw-focused-surface">
    <section aria-labelledby={heading}>
      <h4 id={heading}>Browse the web</h4>
      {labels?.description && <p>{labels.description}</p>}
      <form className="aw-browser-address" onSubmit={navigate}>
        <label>Address or search terms
          <input type="text" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false}
            value={value} maxLength={4096} placeholder="example.org" onChange={event => setValue(event.currentTarget.value)} />
        </label>
        <div className="ae-actions">
          <Button type="submit" value="open" disabled={disabled || busy}>{labels?.open ?? "Open page"}</Button>
          <Button type="submit" variant="quiet" value="search" disabled={disabled || busy}>Search Google</Button>
        </div>
      </form>
      <label className="aw-browser-remember">
        <input type="checkbox" checked={history.enabled} disabled={busy}
          onChange={event => setRemember(event.currentTarget.checked)} /> Remember addresses opened in AeRift
      </label>
      <p>Off by default. AeRift does not keep search terms, query strings, page fragments, or history from outside AeRift.</p>
      {history.enabled && <section aria-labelledby={historyHeading}>
        <div className="ae-actions">
          <h5 id={historyHeading}>{showHistory ? "AeRift browser history" : "Recent pages"}</h5>
          {history.items.length > 0 && <>
            <Button variant="quiet" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? "Show recents" : "Show history"}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={clearHistory}>Clear history</Button>
          </>}
        </div>
        {visible.length ? <ul className="aw-browser-history">
          {visible.map(item => <li key={item.url}>
            <Button variant="quiet" disabled={disabled || busy} onClick={() => void launch(item.url, true)}>{item.url}</Button>
            <time dateTime={new Date(item.openedAt).toISOString()}>{historyDate.format(item.openedAt)}</time>
          </li>)}
        </ul> : <p>No addresses opened in AeRift yet.</p>}
      </section>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  </GlassSurface>;
}

import { Button, GlassSurface } from "@aerift/ui";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { workspaceBrowserDestination } from "../workspace-browser-tools";
import { createTrustedBrowserSession, type NativeBrowserLifecycle, type TrustedBrowserState } from "./trusted-browser-session";

type Link = Readonly<{ id: string; title: string; url: string; categoryId?: string }>;

export function TrustedWorkspaceBrowserChrome({ native, saved, recents, categories, openDefault, saveLink }: {
  /** Omit until a platform composition has a qualified native host. */
  native?: NativeBrowserLifecycle;
  saved: readonly Link[];
  /** Pass only opt-in, already sanitized recents from the app history model. */
  recents: readonly Link[];
  categories: readonly { id: string; label: string }[];
  openDefault: (url: string) => Promise<boolean>;
  saveLink?: (link: { url: string; categoryId?: string }) => boolean;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [view, setView] = useState<"saved" | "recents">("saved");
  const [category, setCategory] = useState("");
  const [feedback, setFeedback] = useState("");
  const [state, setState] = useState<TrustedBrowserState>({ kind: "external-only" });
  const session = useMemo(() => createTrustedBrowserSession(native, setState), [native]);
  useEffect(() => {
    setState(session.state());
    return () => { void session.close(); };
  }, [session]);

  const appOpen = native?.witness.state === "verified";
  const destination = workspaceBrowserDestination(value);
  const visible = state.kind === "presented";
  const pending = state.kind === "pending";
  const items = view === "recents" ? recents : saved.filter(item => !category || item.categoryId === category);

  async function external(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback("");
    if (!destination) { setFeedback("Enter a valid HTTP or HTTPS address without credentials."); return; }
    try {
      if (!await openDefault(destination)) setFeedback("Could not open the default browser.");
    } catch { setFeedback("Could not open the default browser."); }
  }

  function save() {
    if (!destination || !saveLink) return;
    try {
      setFeedback(saveLink({ url: destination, categoryId: category || undefined })
        ? "Page saved." : "Could not save this page.");
    } catch { setFeedback("Could not save this page."); }
  }

  return <GlassSurface className="aw-browser-tools" material="content">
    <form className="aw-browser-address" onSubmit={event => void external(event)}>
      <label htmlFor={id}>Web address
        <input id={id} value={value} type="text" spellCheck={false} autoComplete="off" maxLength={4096}
          onChange={event => setValue(event.currentTarget.value)} />
      </label>
      <Button type="submit" variant="secondary">Open in default browser</Button>
      {saveLink && <Button type="button" variant="quiet" disabled={!destination} onClick={save}>Save page</Button>}
      {appOpen && <Button type="button" disabled={!destination || pending}
        onClick={() => { setFeedback(""); void session.command("open", value); }}>Open in Workspace</Button>}
    </form>
    {appOpen && <div className="ae-actions" role="group" aria-label="Workspace browser navigation">
      <Button type="button" variant="quiet" disabled={!visible || !state.canBack} onClick={() => void session.command("back")}>Back</Button>
      <Button type="button" variant="quiet" disabled={!visible || !state.canForward} onClick={() => void session.command("forward")}>Forward</Button>
      <Button type="button" variant="quiet" disabled={!visible} onClick={() => void session.command("reload")}>Reload</Button>
      <Button type="button" variant="quiet" disabled={!visible && !pending} onClick={() => void session.close()}>Close</Button>
    </div>}
    <p role="status">{feedback || (state.kind === "presented"
      ? `Native pane presented (${state.viewport.widthPx} × ${state.viewport.heightPx}); page load not confirmed.`
      : pending ? "Waiting for the native pane…"
      : state.kind === "denied" ? "This address isn’t approved for the Workspace pane. You can open it in your default browser."
      : state.kind === "unavailable" || state.kind === "external-only" ? "Pages open in your default browser." : "")}</p>
    <div className="ae-actions" role="group" aria-label="Browser library">
      <Button type="button" variant="quiet" aria-pressed={view === "saved"} onClick={() => setView("saved")}>Saved</Button>
      <Button type="button" variant="quiet" aria-pressed={view === "recents"} onClick={() => setView("recents")}>Recents</Button>
      {view === "saved" && <label>Category <select value={category} onChange={event => setCategory(event.currentTarget.value)}>
        <option value="">All categories</option>
        {categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>}
    </div>
    <ul className="aw-browser-history">{items.map(item => <li key={item.id}>
      <Button type="button" variant="quiet" onClick={() => { setValue(item.url); setFeedback(""); }}>{item.title}</Button>
    </li>)}</ul>
  </GlassSurface>;
}

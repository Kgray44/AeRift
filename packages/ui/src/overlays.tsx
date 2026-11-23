import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./components";
import type { ColorScheme, Preference, Reduction } from "./theme";

export function Sheet({ open, title, onClose, children }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (open && node && !node.open) node.showModal();
    if (!open && node?.open) node.close();
  }, [open]);
  return (
    <dialog ref={dialog} className="ae-sheet ae-surface" data-material="overlay" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="ae-sheet-header">
        <h2 id={titleId}>{title}</h2><Button variant="quiet" onClick={onClose}>Close</Button>
      </div>
      {children}
    </dialog>
  );
}

export interface AppearanceSettings {
  theme: string;
  scheme: ColorScheme;
  contrast: Preference;
  transparency: Reduction;
  motion: Reduction;
}

export function SettingsPanel({ value, onChange, themes }: {
  value: AppearanceSettings; onChange: (settings: AppearanceSettings) => void;
  themes: readonly { id: string; label: string }[];
}) {
  return <div className="ae-settings">
    <label>Theme<select value={value.theme} onChange={event => onChange({ ...value, theme: event.target.value })}>
      {themes.map(theme => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
    </select></label>
    <label>Appearance<select value={value.scheme}
      onChange={event => onChange({ ...value, scheme: event.target.value as ColorScheme })}>
      <option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option>
    </select></label>
    <label><input type="checkbox" checked={value.contrast === "increase"}
      onChange={event => onChange({ ...value, contrast: event.target.checked ? "increase" : "system" })} />
      Increase contrast</label>
    <label><input type="checkbox" checked={value.transparency === "reduce"}
      onChange={event => onChange({ ...value, transparency: event.target.checked ? "reduce" : "system" })} />
      Reduce transparency</label>
    <label><input type="checkbox" checked={value.motion === "reduce"}
      onChange={event => onChange({ ...value, motion: event.target.checked ? "reduce" : "system" })} />
      Reduce motion</label>
  </div>;
}

export function Popover({ label, actions }: {
  label: string;
  actions: readonly { id: string; label: string; disabled?: boolean; onSelect: () => void }[];
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="ae-menu">
    <Button ref={trigger} popoverTarget={id} onClick={() => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect && panel.current) {
        const { clientWidth, clientHeight } = document.documentElement;
        const below = clientHeight - rect.bottom;
        const above = rect.top;
        const openBelow = below >= Math.min(256, above);
        panel.current.style.top = openBelow ? `${rect.bottom + 8}px` : "auto";
        panel.current.style.bottom = openBelow ? "auto" : `${clientHeight - rect.top + 8}px`;
        panel.current.style.maxHeight = `${Math.max(0, Math.min(clientHeight / 2, (openBelow ? below : above) - 20))}px`;
        panel.current.style.right = `${Math.max(12, clientWidth - rect.right)}px`;
      }
    }}>{label}</Button>
    <div id={id} ref={panel} popover="auto" className="ae-popover ae-surface" data-material="overlay"
      role="group" aria-label={label}>
      {actions.map(action => <Button key={action.id} variant="quiet" disabled={action.disabled}
        onClick={() => { panel.current?.hidePopover(); trigger.current?.focus(); action.onSelect(); }}>{action.label}</Button>)}
    </div>
  </div>;
}

export function Toast({ message, kind = "info", onDismiss }: {
  message?: string; kind?: "info" | "success" | "error"; onDismiss?: () => void;
}) {
  return <div className="ae-toast-slot">
    <div className={message ? "ae-toast ae-surface" : undefined} data-material="overlay" data-kind={kind}>
      <span role="status">{kind !== "error" ? message : ""}</span>
      <span role="alert">{kind === "error" ? message : ""}</span>
      {message && onDismiss && <Button variant="quiet" onClick={onDismiss}>Dismiss</Button>}
    </div>
  </div>;
}

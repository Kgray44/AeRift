import { useEffect, useId, useRef, type PointerEvent, type ReactNode } from "react";
import { Button } from "./components";
import { SpatialIcon } from "./SpatialScene";
import { transitionAppearance, type ColorScheme, type Preference, type Reduction } from "./theme";

export function Sheet({ open, title, onClose, children, id, className, closeIcon = false, onAfterClose }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode;
  id?: string; className?: string; closeIcon?: boolean; onAfterClose?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const drag = useRef<{ pointer: number; startY: number } | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (open && node && !node.open) {
      node.removeAttribute("data-swipe-dismiss");
      node.style.removeProperty("--ae-sheet-swipe");
      node.showModal();
    }
    if (!open && node?.open) node.close();
  }, [open]);

  function dragSheet(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (state?.pointer === event.pointerId) {
      const distance = Math.max(0, event.clientY - state.startY);
      dialog.current?.style.setProperty("--ae-sheet-swipe", `${distance}px`);
    }
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>, dismissed: boolean) {
    const state = drag.current;
    if (state?.pointer !== event.pointerId) return;
    drag.current = null;
    dialog.current?.removeAttribute("data-dragging");
    if (dismissed && event.clientY - state.startY > 72) {
      dialog.current?.setAttribute("data-swipe-dismiss", "");
      onClose();
    } else dialog.current?.style.removeProperty("--ae-sheet-swipe");
  }
  return (
    <dialog ref={dialog} id={id} className={["ae-sheet ae-surface", className].filter(Boolean).join(" ")}
      data-material="overlay" aria-labelledby={titleId}
      onClose={event => { if (!event.currentTarget.open) onAfterClose?.(); }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="ae-sheet-grip" aria-hidden="true"
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, startY: event.clientY };
          dialog.current?.setAttribute("data-dragging", "");
        }}
        onPointerMove={dragSheet} onPointerUp={event => finishDrag(event, true)}
        onPointerCancel={event => finishDrag(event, false)} onLostPointerCapture={event => finishDrag(event, false)} />
      <div className="ae-sheet-header">
        <h2 id={titleId}>{title}</h2>
        {closeIcon ? <Button variant="quiet" autoFocus className="ae-sheet-close-icon" title="Close" aria-label={`Close ${title}`} onClick={onClose}>
          <SpatialIcon name="close" size={18} />
        </Button> : <Button variant="quiet" onClick={onClose}>Close</Button>}
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
  const appearanceName = useId();
  function switchRow(label: string, checked: boolean, toggle: (enabled: boolean) => void) {
    return <label className="ae-setting-switch">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={event => toggle(event.target.checked)} />
      <span className="ae-switch-track" aria-hidden="true" />
    </label>;
  }
  return <div className="ae-settings">
      <div className="ae-settings-group" role="group" aria-label="Visual theme">
      <label>Theme<select value={value.theme} onChange={event => onChange({ ...value, theme: event.target.value })}>
        {themes.map(theme => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
      </select></label>
    </div>
      <fieldset className="ae-appearance-picker">
        <legend>Appearance</legend>
        <div className="ae-appearance-options">
          {([["system", "System"], ["light", "Light"], ["dark", "Dark"]] as const).map(([scheme, label]) => (
            <label key={scheme} className="ae-appearance-card" data-preview={scheme}>
              <input type="radio" name={appearanceName} checked={value.scheme === scheme}
                onChange={() => transitionAppearance(() => onChange({ ...value, scheme }), value.motion)} />
              <span className="ae-appearance-sample" aria-hidden="true"><span /></span>
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    <div className="ae-settings-group" role="group" aria-label="Accessibility preferences">
      {switchRow("Increase contrast", value.contrast === "increase",
        enabled => onChange({ ...value, contrast: enabled ? "increase" : "system" }))}
      {switchRow("Reduce transparency", value.transparency === "reduce",
        enabled => onChange({ ...value, transparency: enabled ? "reduce" : "system" }))}
      {switchRow("Reduce motion", value.motion === "reduce",
        enabled => onChange({ ...value, motion: enabled ? "reduce" : "system" }))}
    </div>
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
        panel.current.dataset.anchorSide = openBelow ? "below" : "above";
        panel.current.style.transformOrigin = openBelow ? "top right" : "bottom right";
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

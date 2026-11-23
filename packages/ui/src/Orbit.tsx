import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject,
} from "react";
import { resolveMotion } from "@aerift/app-contract/experience";
import { orbitNeighbor, orbitSlots, type OrbitArrow, type OrbitPoint } from "./orbit-geometry";
import { useOrbitMorph } from "./orbit-surface";
import { SpatialIcon } from "./SpatialScene";

export interface OrbitDestination<Id extends string = string> {
  id: Id;
  label: string;
  icon?: string;
}

export type OrbitShortcut = "alt-o" | "alt-shift-o" | "off";

export interface OrbitProps<Id extends string> {
  destinations: readonly OrbitDestination<Id>[];
  active: Id;
  onNavigate: (destination: Id) => void;
  surfaceRef: RefObject<HTMLElement | null>;
  presentation?: "orbit" | "conventional";
  shortcut?: OrbitShortcut;
  reducedMotion?: boolean;
  status?: Partial<Record<Id, string>>;
}

function DestinationIcon({ id }: { id: string }) {
  const name = id === "home" || id === "rift" || id === "devices" || id === "activity" || id === "settings"
    ? id : "workspace";
  return <SpatialIcon name={name} size={23} />;
}

function reflect(event: PointerEvent<HTMLButtonElement>) {
  const button = event.currentTarget;
  const box = button.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width - .5;
  const y = (event.clientY - box.top) / box.height - .5;
  button.style.setProperty("--orbit-pointer-x", `${(x + .5) * 100}%`);
  button.style.setProperty("--orbit-pointer-y", `${(y + .5) * 100}%`);
  button.style.setProperty("--orbit-magnet-x", `${x * 5}px`);
  button.style.setProperty("--orbit-magnet-y", `${y * 5}px`);
}

function appReducesMotion(root: HTMLElement | null, explicit: boolean) {
  return explicit || Boolean(root?.closest("[data-motion='reduce']")) ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Orbit<Id extends string>({
  destinations, active, onNavigate, surfaceRef, presentation = "orbit",
  shortcut = "alt-o", reducedMotion = false, status,
}: OrbitProps<Id>) {
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const names = useRef<(HTMLButtonElement | null)[]>([]);
  const popupId = useId();
  const pending = useRef<{ id: Id; source?: { bounds: DOMRect; glyph: SVGSVGElement | null } }>(undefined);
  const committed = useRef(active);
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<OrbitPoint[] | null>(null);
  const [focusFirst, setFocusFirst] = useState(false);
  const [morphFrom, setMorphFrom] = useState<Id>();
  const { start, cancel } = useOrbitMorph();
  const current = destinations.find(destination => destination.id === active);
  const visibleTrigger = !open && morphFrom
    ? destinations.find(destination => destination.id === morphFrom) ?? current
    : current;
  const siblings = destinations.filter(destination => destination.id !== active);
  const radial = presentation === "orbit" && slots !== null;
  const first = slots?.[0];
  const last = slots?.at(-1);

  useLayoutEffect(() => {
    const anchor = trigger.current;
    const orb = anchor?.querySelector<HTMLElement>(".ae-orbit-orb");
    if (!anchor || !orb || presentation !== "orbit") return;
    function measure() {
      const box = anchor!.getBoundingClientRect();
      const centerX = box.left + orb!.offsetWidth / 2;
      const centerY = box.top + box.height / 2;
      const viewport = window.visualViewport;
      const next = orbitSlots(siblings.length, {
        right: (viewport ? viewport.offsetLeft + viewport.width : window.innerWidth) - centerX,
        bottom: (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - centerY,
        diameter: orb!.offsetWidth,
      });
      setSlots(previous => {
        if (previous === null || next === null) return next;
        return previous.length === next.length && previous.every((point, index) =>
          point.x === next[index].x && point.y === next[index].y) ? previous : next;
      });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(document.documentElement);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [presentation, siblings.length]);

  useLayoutEffect(() => {
    if (committed.current === active) return;
    const previous = committed.current;
    committed.current = active;
    const next = pending.current;
    pending.current = undefined;
    cancel.current?.();
    setOpen(false);
    const surface = surfaceRef.current;
    if (!surface) return;
    const motion = resolveMotion("spatial", appReducesMotion(root.current, reducedMotion));
    if (next?.id === active && next.source && motion === "spatial" &&
        start(surface, next.source, () => setMorphFrom(undefined))) {
      setMorphFrom(previous);
    }
    const heading = surface.querySelector<HTMLElement>("[data-orbit-focus]");
    (heading ?? surface).focus({ preventScroll: true });
  }, [active, cancel, reducedMotion, start, surfaceRef]);

  useLayoutEffect(() => {
    if (!open) return;
    setMorphFrom(undefined);
    if (!focusFirst) return;
    names.current[0]?.focus();
    setFocusFirst(false);
  }, [open, focusFirst]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => { if (preference.matches) cancel.current?.(); };
    preference.addEventListener("change", reduce);
    return () => {
      preference.removeEventListener("change", reduce);
      cancel.current?.();
    };
  }, [cancel]);

  useLayoutEffect(() => {
    if (reducedMotion) cancel.current?.();
    if (presentation === "conventional") setOpen(false);
  }, [cancel, presentation, reducedMotion]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: globalThis.PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    function blur() { setOpen(false); }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);
    };
  }, [open]);

  useEffect(() => {
    if (shortcut === "off" || presentation !== "orbit") return;
    function activate(event: globalThis.KeyboardEvent) {
      if (event.repeat || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey ||
          !event.altKey || event.shiftKey !== (shortcut === "alt-shift-o") || event.code !== "KeyO") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("dialog[open], [aria-modal='true'], input, select, textarea, [contenteditable]")) return;
      event.preventDefault();
      if (open) {
        setOpen(false);
        trigger.current?.focus();
      } else {
        setFocusFirst(true);
        setOpen(true);
      }
    }
    document.addEventListener("keydown", activate);
    return () => document.removeEventListener("keydown", activate);
  }, [open, presentation, shortcut]);

  function select(id: Id, button: HTMLButtonElement) {
    if (id === active) return;
    const orb = radial ? button.querySelector<HTMLElement>(".ae-orbit-orb") : null;
    const source = orb ? { bounds: orb.getBoundingClientRect(), glyph: orb.querySelector("svg") } : undefined;
    pending.current = { id, source };
    setOpen(false);
    onNavigate(id);
  }

  function navigateKey(event: KeyboardEvent, index: number) {
    if (!(event.key === "Home" || event.key === "End" ||
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key))) return;
    event.preventDefault();
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = siblings.length - 1;
    else if (radial && slots) next = orbitNeighbor(slots.length, index, event.key as OrbitArrow);
    else next = Math.max(0, Math.min(siblings.length - 1,
      index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1)));
    names.current[next]?.focus();
  }

  if (!current || !visibleTrigger) return null;

  if (presentation === "conventional") return <nav className="ae-orbit-conventional" aria-label="Desktop navigation" ref={root}>
    {destinations.map(({ id, label, icon }) => <button key={id} type="button"
      aria-current={id === active ? "page" : undefined}
      aria-label={status?.[id] ? `${label}, ${status[id]}` : undefined} onClick={event => select(id, event.currentTarget)}>
      <DestinationIcon id={icon ?? id} /><span>{label}</span>
      {status?.[id] && <span className="ae-orbit-indicator" aria-hidden="true" />}
    </button>)}
  </nav>;

  return <nav className="ae-orbit" aria-label="Desktop navigation" data-open={open} data-radial={radial}
    data-reduced={reducedMotion} ref={root}>
    {radial && <div className="ae-orbit-veil" aria-hidden="true" />}
    <button type="button" className="ae-orbit-trigger" ref={trigger} data-destination={active}
      aria-label={`Current destination: ${visibleTrigger.label}${status?.[visibleTrigger.id] ? `, ${status[visibleTrigger.id]}` : ""}`}
      aria-expanded={open} aria-controls={popupId}
      aria-keyshortcuts={shortcut === "off" ? undefined : shortcut === "alt-shift-o" ? "Alt+Shift+O" : "Alt+O"}
      onPointerMove={reflect}
      onClick={event => {
        if (!open && event.detail === 0) setFocusFirst(true);
        setOpen(!open);
      }}
      onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setFocusFirst(true);
        setOpen(true);
      }}>
      <span className="ae-orbit-orb ae-surface" data-material="chrome" data-ae-lens-role="orb"><DestinationIcon id={visibleTrigger.icon ?? visibleTrigger.id} />
        {status?.[visibleTrigger.id] && <span className="ae-orbit-indicator" aria-hidden="true" />}</span>
      <span className="ae-orbit-current">{visibleTrigger.label}<span aria-hidden="true">⌄</span></span>
    </button>
    <div className="ae-orbit-fan" id={popupId} inert={!open} aria-hidden={!open}>
      {radial && first && last && first !== last && <svg className="ae-orbit-guide" aria-hidden="true"
        width="1" height="1">
        <path d={`M ${first.x} ${first.y} A ${Math.hypot(first.x, first.y)} ${Math.hypot(first.x, first.y)} 0 0 1 ${last.x} ${last.y}`} />
      </svg>}
      {siblings.map(({ id, label, icon }, index) => {
        const position = slots?.[index];
        const coordinates = {
          "--orbit-x": `${position?.x ?? 0}px`,
          "--orbit-y": `${position?.y ?? 0}px`,
          "--orbit-delay": `${index * 28}ms`,
        } as CSSProperties;
        return <button key={id} type="button" className="ae-orbit-choice" style={coordinates}
          ref={element => { names.current[index] = element; }}
          onPointerMove={reflect}
          onKeyDown={event => navigateKey(event, index)}
          onClick={event => select(id, event.currentTarget)}
          aria-label={status?.[id] ? `${label}, ${status[id]}` : label}>
          <span className="ae-orbit-orb ae-surface" data-material="chrome" data-ae-lens-role="orb"><DestinationIcon id={icon ?? id} />
            {status?.[id] && <span className="ae-orbit-indicator" aria-hidden="true" />}</span>
          <span className="ae-orbit-label">{label}</span>
        </button>;
      })}
    </div>
  </nav>;
}

import * as m from "motion/react-m";
import "./workspace-panel-motion.css";

export type PanelBox = { left: number; top: number; width: number; height: number };
export type PanelHandoff = { id: number; from: PanelBox; to: PanelBox; host: PanelBox; tint: string; direction: "forward" | "back" };
export function workspacePanelBox(node?: Element | null): PanelBox | undefined {
  if (!node?.isConnected) return;
  const { left, top, right, bottom } = node.getBoundingClientRect();
  const x = Math.max(0, left), y = Math.max(0, top);
  const width = Math.min(innerWidth, right) - x, height = Math.min(innerHeight, bottom) - y;
  if ([x, y, width, height].every(Number.isFinite) && width > 8 && height > 8) return { left: x, top: y, width, height };
}

export function WorkspacePanelMotion({ handoff, onComplete }: { handoff: PanelHandoff; onComplete: (id: number) => void }) {
  const { from, to: destination, host, direction, tint, id } = handoff;
  const left = Math.min(from.left, destination.left), top = Math.min(from.top, destination.top);
  const right = Math.max(from.left + from.width, destination.left + destination.width);
  const bottom = Math.max(from.top + from.height, destination.top + destination.height);
  const clip = (box: PanelBox, radius: number) => `inset(${box.top - top}px ${right - box.left - box.width}px ${bottom - box.top - box.height}px ${box.left - left}px round ${radius}px)`;
  const opening = direction === "forward";
  const to = { clipPath: [clip(from, 22), clip(destination, opening ? 17 : 22), clip(destination, opening ? 17 : 22)],
    opacity: opening ? [.9, .85, 0] : [.72, .95, 0] };
  const geometry = (box: PanelBox, radius: number) => ({
    x: box.left - left + .75, y: box.top - top + .75,
    width: box.width - 1.5, height: box.height - 1.5, rx: radius,
  });
  const style = { left: left - host.left, top: top - host.top, width: right - left, height: bottom - top };
  const duration = opening ? .53 : .43;
  const ease = [0.23, 0.72, 0.25, 1] as const;
  return <>
    <m.div className="aw-handoff-glass" data-aw-tint={tint} data-aw-handoff={direction} aria-hidden="true"
      style={style} initial={{ clipPath: clip(from, 22), opacity: .87 }} animate={to}
      transition={{ duration, times: [0, .78, 1], ease }} onAnimationComplete={() => onComplete(id)} />
    <svg className="aw-handoff-rim" aria-hidden="true" style={style} data-aw-tint={tint}>
      <m.rect initial={{ ...geometry(from, 22), opacity: .75 }}
        animate={{ ...geometry(destination, opening ? 17 : 22), opacity: [.75, .58, 0] }}
        transition={{ default: { duration: duration * .78, ease }, opacity: { duration, times: [0, .65, 1], ease } }} />
    </svg>
  </>;
}

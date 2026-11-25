import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { useMotionValue, useSpring, useTransform, useVelocity, type MotionStyle } from "motion/react";
import * as m from "motion/react-m";
import { MotionFeedbackProvider, useQuietMotion } from "./MotionAffordance";
import { dockPointerPosition, dockSpring, dockSquash, DOCK_SETTLE_LIMIT_MS, isDockScrub } from "./dock-motion-math";

type Touch = { id: number; x: number; y: number; left: number; width: number; rtl: boolean; horizontal: boolean; vertical: boolean };

function Dock({ label, children, index, count }: {
  label: string; children: ReactNode; index: number; count: number;
}) {
  const quiet = useQuietMotion();
  const selected = Math.max(0, index);
  const target = useMotionValue(selected);
  const spring = useSpring(target, dockSpring);
  const velocity = useVelocity(spring);
  const strain = useTransform(velocity, dockSquash);
  const offset = useTransform(spring, position => Math.min(count - 1, Math.max(0, position)));
  const scaleX = useTransform(strain, stretch => 1 + stretch);
  const scaleY = useTransform(strain, stretch => 1 - 0.72 * stretch);
  const gesture = useRef<Touch | null>(null);
  const suppressTouchClick = useRef(false);
  const timeout = useRef<number | undefined>(undefined);
  const lastCount = useRef(count);

  const clearDeadline = () => window.clearTimeout(timeout.current);
  function snapAt(index: number) {
    clearDeadline();
    target.jump(index);
    spring.jump(index);
  }
  function settleAt(index: number) {
    clearDeadline();
    if (target.get() === index && spring.get() === index) return;
    target.set(index);
    // This is only a hard stop for interrupted/stalled frames, not a clock for
    // translation or refraction. The spring controls both and usually settles earlier.
    timeout.current = window.setTimeout(() => snapAt(index), DOCK_SETTLE_LIMIT_MS);
  }
  useLayoutEffect(() => {
    gesture.current = null;
    if (quiet || index < 0 || count !== lastCount.current) snapAt(selected);
    else settleAt(selected);
    lastCount.current = count;
    return clearDeadline;
  }, [quiet, selected, count, index]);

  function down(event: PointerEvent<HTMLElement>) {
    if (!event.isPrimary) return;
    suppressTouchClick.current = false;
    if (quiet || event.pointerType !== "touch" || index < 0) return;
    const nav = event.currentTarget;
    const { left, width } = nav.getBoundingClientRect();
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left, width,
      rtl: getComputedStyle(nav).direction === "rtl", horizontal: false, vertical: false };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const touch = gesture.current;
    if (quiet || touch?.id !== event.pointerId || touch.vertical) return;
    const dx = event.clientX - touch.x;
    const dy = event.clientY - touch.y;
    if (!touch.horizontal) {
      if (Math.abs(dy) >= 8 && Math.abs(dy) >= Math.abs(dx)) { touch.vertical = true; return; }
      if (!isDockScrub(dx, dy)) return;
      touch.horizontal = true;
      suppressTouchClick.current = true;
      clearDeadline();
    }
    // No capture, preventDefault, or on-frame React updates. Natural vertical
    // scrolling/pinch and native tab activation retain their default handling.
    target.set(dockPointerPosition(event.clientX, touch.left, touch.width, count, touch.rtl));
  }
  function finish(event: PointerEvent<HTMLElement>) {
    const touch = gesture.current;
    if (touch?.id !== event.pointerId) return;
    gesture.current = null;
    if (touch.horizontal) {
      if (quiet || event.type === "pointercancel") snapAt(selected);
      else settleAt(selected);
    }
  }
  function keepScrubDecorative(event: MouseEvent<HTMLElement>) {
    if (event.detail === 0 || !suppressTouchClick.current) return;
    suppressTouchClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  return <nav aria-label={label} onPointerDown={down} onPointerMove={move}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onClickCapture={keepScrubDecorative}>
    {index >= 0 && <m.span className="af-dock-fluid" aria-hidden="true" data-dock-quiet={quiet || undefined}
      style={quiet ? undefined : ({ "--af-dock-offset": offset } as MotionStyle)}>
      <m.span className="af-dock-bead" style={quiet ? undefined : { scaleX, scaleY }} />
    </m.span>}
    {children}
  </nav>;
}

export function MobileDockMotion(props: Parameters<typeof Dock>[0]) {
  return <MotionFeedbackProvider><Dock {...props} /></MotionFeedbackProvider>;
}

import { useLayoutEffect, useRef, type RefObject } from "react";

type ContentScope = "orbit" | "workspace";

export function beginDesktopContentEnter(node: HTMLElement, scope: ContentScope) {
  // Orbit runs its child layout effect before the desktop app's route effect.
  // Only coexist with Orbit when it did not actually start the spatial morph.
  if (scope === "orbit" && node.dataset.morphing === "true") return;
  const target = scope === "orbit" ? node.querySelector<HTMLElement>(":scope > .ae-orbit-content") : node;
  const document = node.ownerDocument;
  const preference = document.defaultView?.matchMedia("(prefers-reduced-motion: reduce)");
  if (!target || document.hidden || !target.getClientRects().length ||
      target.closest('[data-motion="reduce"]') ||
      preference?.matches) return;

  target.setAttribute("data-ae-route-enter", "neutral");
  const clear = () => target.removeAttribute("data-ae-route-enter");
  // The shared CSS is the clock. Observe the actual effects rather than a
  // duplicate timeout, and remove the marker when interrupted or unsupported.
  const animations = target.getAnimations?.() ?? [];
  if (!animations.length) {
    clear();
    return;
  }
  let live = true;
  const cancel = () => {
    if (!live) return;
    live = false;
    clear();
    document.removeEventListener("visibilitychange", onVisibility);
    preference?.removeEventListener?.("change", onPreference);
  };
  const onVisibility = () => { if (document.hidden) cancel(); };
  const onPreference = () => { if (preference?.matches) cancel(); };
  document.addEventListener("visibilitychange", onVisibility);
  preference?.addEventListener?.("change", onPreference);
  void Promise.allSettled(animations.map(animation => animation.finished)).then(cancel);
  return cancel;
}

export function useDesktopContentEnter(
  identity: string | undefined,
  ref: RefObject<HTMLElement | null>,
  scope: ContentScope = "workspace",
) {
  const previous = useRef(identity);
  useLayoutEffect(() => {
    const changed = previous.current !== identity;
    previous.current = identity;
    if (changed && identity && ref.current) return beginDesktopContentEnter(ref.current, scope);
  }, [identity, ref, scope]);
}

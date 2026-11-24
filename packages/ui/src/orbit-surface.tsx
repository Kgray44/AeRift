import { useRef, type ComponentPropsWithRef } from "react";
import { GlassSurface } from "./components";

export function OrbitSurface({ children, className = "", ...props }: ComponentPropsWithRef<"section">) {
  return <section tabIndex={-1} {...props} className={`ae-orbit-surface ${className}`}>
    <GlassSurface className="ae-orbit-skin" material="raised" data-ae-lens-role="panel" aria-hidden="true" />
    <div className="ae-orbit-content">{children}</div>
  </section>;
}

export function motionMilliseconds(style: string, fallback: number) {
  const match = style.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/);
  return match ? Number(match[1]) * (match[2] === "s" ? 1000 : 1) : fallback;
}

function inset(from: DOMRect, to: DOMRect) {
  return [
    from.top - to.top,
    to.right - from.right,
    to.bottom - from.bottom,
    from.left - to.left,
  ].map(value => `${value}px`).join(" ");
}

export function useOrbitMorph() {
  const cleanup = useRef<() => void>(undefined);

  function start(surface: HTMLElement, origin: { bounds: DOMRect; glyph: SVGSVGElement | null }, onFinish: () => void) {
    cleanup.current?.();
    const skin = surface.querySelector<HTMLElement>(":scope > .ae-orbit-skin");
    const content = surface.querySelector<HTMLElement>(":scope > .ae-orbit-content");
    const target = surface.getBoundingClientRect();
    if (!skin || !content || !target.width || !target.height || !surface.animate) return false;

    const source = origin.bounds;
    const skinStyle = getComputedStyle(skin);
    const morphDuration = motionMilliseconds(skinStyle.getPropertyValue("--ae-motion-orbit-morph"), 460);
    if (!morphDuration) return false;
    const compressionFraction = .185;
    const radius = skinStyle.borderTopLeftRadius;
    const unfold = skinStyle.getPropertyValue("--ae-ease").trim() || "ease-out";
    const spring = skinStyle.getPropertyValue("--ae-motion-spring").trim() || unfold;
    const startInset = inset(source, target);
    const shrink = Math.min(source.width, source.height) * .045;
    const compressed = new DOMRect(source.x + shrink, source.y + shrink, source.width - shrink * 2, source.height - shrink * 2);
    const lensRadius = `${source.width / 2}px`;
    const compressedRadius = `${compressed.width / 2}px`;
    const motion = { duration: morphDuration, fill: "both" } as const;
    const compress = spring;

    let glyphMotion: Animation | undefined;
    const glyph = origin.glyph?.cloneNode(true) as SVGSVGElement | undefined;
    if (glyph) {
      glyph.classList.add("ae-orbit-morph-glyph");
      skin.append(glyph);
      glyphMotion = glyph.animate([
        { opacity: 1 },
        { opacity: 1, offset: .23 },
        { opacity: 0, offset: .47 },
        { opacity: 0 },
      ], motion);
    }
    surface.dataset.morphing = "true";
    const shape = surface.animate([
      { clipPath: `inset(${startInset} round ${lensRadius})`, easing: compress },
      { clipPath: `inset(${inset(compressed, target)} round ${compressedRadius})`, offset: compressionFraction, easing: unfold },
      { clipPath: `inset(0px round ${radius})` },
    ], motion);
    const material = skin.animate([
      { inset: startInset, borderRadius: lensRadius, backdropFilter: "blur(3px) saturate(1.2)",
        boxShadow: "inset 0 1px 2px var(--ae-optical-rim), inset 0 -3px 7px var(--ae-optical-cool)", easing: compress },
      { inset: inset(compressed, target), borderRadius: compressedRadius, offset: compressionFraction, easing: unfold },
      { inset: "0px", borderRadius: radius },
    ], motion);
    const settle = skin.animate([
      { opacity: 1 },
      { opacity: 1, offset: .58 },
      { opacity: 0 },
    ], motion);
    const contentOffset = (box: DOMRect) =>
      `${Math.max(0, box.left - target.left) + 8}px ${Math.max(0, box.top - target.top) + 8}px`;
    const position = content.animate([
      { translate: contentOffset(source), easing: compress },
      { translate: contentOffset(compressed), offset: compressionFraction, easing: unfold },
      { translate: "0 0" },
    ], motion);
    const reveal = content.animate([
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: .33, easing: unfold },
      { opacity: 1, offset: .92 },
      { opacity: 1 },
    ], motion);

    const finish = () => {
      if (cleanup.current !== finish) return;
      cleanup.current = undefined;
      shape.cancel();
      material.cancel();
      position.cancel();
      reveal.cancel();
      settle.cancel();
      glyphMotion?.cancel();
      glyph?.remove();
      delete surface.dataset.morphing;
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("scroll", finish, true);
      onFinish();
    };
    function resize() {
      // The layout may change while this element is clipped. Finish into the
      // new layout immediately so the clip cannot strand controls offscreen.
      const bounds = surface.getBoundingClientRect();
      if (bounds.width !== target.width || bounds.height !== target.height ||
          bounds.left !== target.left || bounds.top !== target.top) finish();
    }

    const visibility = () => { if (document.hidden) finish(); };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : undefined;
    observer?.observe(surface);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener("scroll", finish, { passive: true, capture: true });
    cleanup.current = finish;
    void shape.finished.then(finish, finish);
    return true;
  }

  return { start, cancel: cleanup };
}

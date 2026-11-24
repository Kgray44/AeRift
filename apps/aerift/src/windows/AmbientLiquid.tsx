import { aeRiftGlassRecipe as glass } from "@aerift/ui";
import { useEffect, useRef, type CSSProperties } from "react";

/** One continuous, tangent-matched contour, shared by the film and the light. */
function contour(time: number) {
  const points = Array.from({ length: 12 }, (_, i) => {
    const a = i * Math.PI / 6;
    const r = 1 + .105 * Math.sin(a * 3 + time) + .07 * Math.cos(a * 2 - time * 1.3) +
      .047 * Math.sin(a * 5 + time * 1.53);
    return [72 + Math.cos(a) * 43 * r, 52 + Math.sin(a) * 38 * r] as const;
  });
  const f = (x: number) => x.toFixed(2);
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length; i++) {
    const v = (j: number) => points[(j + points.length) % points.length];
    const [p, a, b, n] = [v(i - 1), v(i), v(i + 1), v(i + 2)];
    d += ` C ${f(a[0] + (b[0] - p[0]) / 6)} ${f(a[1] + (b[1] - p[1]) / 6)} ${f(b[0] - (n[0] - a[0]) / 6)} ${f(b[1] - (n[1] - a[1]) / 6)} ${f(b[0])} ${f(b[1])}`;
  }
  return d + " Z";
}

export function AmbientLiquid({ reduce }: { reduce: boolean }) {
  const shape = useRef<SVGPathElement>(null);
  const light = useRef<SVGLinearGradientElement>(null);
  const patch = useRef<SVGRadialGradientElement>(null);
  useEffect(() => {
    const path = shape.current;
    if (!path) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let previous = 0;
    let phase = 0;
    function draw(now: number) {
      raf = 0;
      if (!path) return;
      const still = reduce || motion.matches;
      if (previous && !still) phase += Math.min(.05, (now - previous) / 1000) * (glass.speed / 65);
      previous = now;
      path.setAttribute("d", contour(still ? 0 : phase));
      light.current?.setAttribute("gradientTransform", `rotate(${glass.light + Math.sin(phase) * glass.sweep * .36} .5 .5)`);
      patch.current?.setAttribute("cx", `${34 + Math.sin(phase * .7) * 15}%`);
      patch.current?.setAttribute("cy", `${28 + Math.cos(phase * .84) * 12}%`);
      if (!still && !document.hidden) raf = requestAnimationFrame(draw);
    }
    function refresh() {
      cancelAnimationFrame(raf);
      previous = 0;
      draw(performance.now());
    }
    refresh();
    motion.addEventListener("change", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelAnimationFrame(raf);
      motion.removeEventListener("change", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reduce]);

  return <svg viewBox="0 0 144 104" className="ae-ambient-liquid" aria-hidden="true"
    style={{ "--ae-liquid-tint": glass.opacity / 900 } as CSSProperties}>
    <defs>
      <path ref={shape} id="ambient-liquid-shape" d={contour(0)} />
      <linearGradient id="ambient-liquid-edge" ref={light} x1="0%" x2="100%" y1="0%" y2="100%">
        <stop stopColor="white" stopOpacity={glass.gloss / 100} />
        <stop offset=".23" stopColor="white" stopOpacity={glass.reflection / 100} />
        <stop offset=".51" stopColor="#a892ff" stopOpacity={glass.iridescence / 155} />
        <stop offset=".71" stopColor="#8278bf" stopOpacity={glass.edge / 100} />
        <stop offset=".86" stopColor="#d7f6ff" stopOpacity={glass.edging / 112} />
        <stop offset="1" stopColor="white" stopOpacity=".88" />
      </linearGradient>
      <radialGradient id="ambient-liquid-patch" ref={patch} cx="34%" cy="40%" r={`${glass.patches / 4}%`}
        gradientTransform="translate(0 .18) scale(1 .55)">
        <stop stopColor="white" stopOpacity=".78" />
        <stop offset=".27" stopColor="#f5faff" stopOpacity=".49" />
        <stop offset="1" stopColor="#b6cdff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="ambient-liquid-film">
        <stop offset=".48" stopColor="white" stopOpacity="0" />
        <stop offset=".76" stopColor="white" stopOpacity={glass.opacity / 400} />
        <stop offset="1" stopColor="#9b9eff" stopOpacity={glass.dispersion / 250} />
      </radialGradient>
    </defs>
    <use href="#ambient-liquid-shape" className="ae-liquid-center" />
    <use href="#ambient-liquid-shape" fill="url(#ambient-liquid-film)" />
    <use href="#ambient-liquid-shape" fill="url(#ambient-liquid-patch)" />
    <use href="#ambient-liquid-shape" fill="none" stroke="url(#ambient-liquid-edge)"
      strokeWidth={1 + glass.depth / 20} />
  </svg>;
}

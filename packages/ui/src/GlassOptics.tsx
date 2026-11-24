import { useEffect, useId, useRef } from "react";
import { appearanceCommitEvent } from "./theme";
import { atmosphereIntensity, atmosphereTarget, blendAtmosphere, paintAtmosphere, ribbonGeometry } from "./atmosphere";

/** Source values from the owner's approved Liquid Glass Lab recipe. */
export const aeRiftGlassRecipe = Object.freeze({
  opacity: 2, warmth: 0, softness: 2, exposure: 108, depth: 9, radius: 26,
  roundness: 69, distortion: 40, dispersion: 100, magnify: 80, shadow: 61,
  reflection: 76, gloss: 100, patches: 60, patchSize: 58, iridescence: 30,
  edging: 77, edge: 44, light: 315, sweep: 53, drift: 48, speed: 116,
  scroll: 44, scene: "ribbons", surface: "all", showLens: true,
});

const orbitGlass = ".ae-orbit[data-radial='true'] .ae-orbit-trigger [data-ae-lens-role='orb']";
const openOrbitGlass = ".ae-orbit[data-radial='true'][data-open='true'] .ae-orbit-choice [data-ae-lens-role='orb']";
const lensSelector = [
  orbitGlass, openOrbitGlass,
  ".ae-nav-brand", ".ae-nav-destinations", ".ae-nav-tools", ".ae-transfer-dock",
  ".ios-dock .ae-nav-indicator", ".ae-spatial-local .ae-spatial-glyph",
  ".ae-spatial-peer[data-selected='true'] .ae-spatial-glyph",
  ".ae-workspace-nav", ".ae-panel", ".ae-file-slot",
  "[data-ae-lens-role='control']:not(:disabled, [aria-disabled='true'])",
].join(",");

const R = aeRiftGlassRecipe;
export interface GlassAppearanceRecipe {
  softness: number;
  exposure: number;
  refraction: number;
  dispersion: number;
  reflection: number;
  reflectionColor: readonly [number, number, number];
  ribbonIntensity: number;
}

export const glassAppearanceRecipes: Readonly<Record<"dark" | "light", GlassAppearanceRecipe>> = Object.freeze({
  dark: Object.freeze({ softness: R.softness, exposure: R.exposure, refraction: R.distortion, dispersion: R.dispersion,
    reflection: R.reflection, reflectionColor: [249, 253, 255] as const, ribbonIntensity: 1 }),
  light: Object.freeze({ softness: 1.35, exposure: 102, refraction: 36, dispersion: 77,
    reflection: 86, reflectionColor: [252, 251, 255] as const, ribbonIntensity: .90 }),
});

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
type Surface = { x: number; y: number; width: number; height: number; radius: number; kind: "control" | "panel" | "stage" };

export function opticalViewportScale(width: number, height: number, dpr: number) {
  return Math.min(Math.max(1, dpr), 800 / width, Math.sqrt(390000 / (width * height)));
}

export function shadeLens(out: Uint8ClampedArray, source: Uint8ClampedArray, w: number, h: number, box: Surface, resolution: number, t: number,
  appearance: GlassAppearanceRecipe = glassAppearanceRecipes.dark) {
  const { x, y, width, height, radius, kind } = box;
  const scrX = Math.max(0, Math.floor(x)), scrY = Math.max(0, Math.floor(y));
  const endX = Math.min(w, Math.ceil(x + width)), endY = Math.min(h, Math.ceil(y + height));
  const halfW = width / 2, halfH = height / 2, centerX = x + halfW, centerY = y + halfH;
  const r = Math.min(radius, halfW, halfH);
  const stage = kind === "stage", panel = kind === "panel";
  const depth = Math.max(1.25, R.depth * resolution * (stage ? 1.40 : panel ? 1.05 : .72));
  // Cap the studio warp and zoom next to retained app text; file-stage glass
  // uses the strongest refraction, while functional labels are drawn by React.
  const warpMax = appearance.refraction * resolution * (stage ? .57 : panel ? .38 : .43);
  const mag = R.magnify * .01 * (stage ? .033 : panel ? .015 : .027);
  const angle = R.light * Math.PI / 180 + .23 * R.sweep / 53 * Math.sin(t * 1.31);
  const lx = Math.cos(angle), ly = Math.sin(angle);
  const cu = 1 - r / width, cv = 1 - r / height;
  const spread = R.patchSize / 100;
  const patchW = Math.max(.048, r / width * 2.05 + spread * .052);
  const patchH = Math.max(.08, r / height * 1.65 + spread * .061);
  const shift = .038 * Math.sin(t * 1.7);
  const signX = Math.sign(lx), signY = Math.sign(ly);
  const reflect = appearance.reflection / 100;
  const [reflectRed, reflectGreen, reflectBlue] = appearance.reflectionColor;
  const softness = clamp(appearance.softness, 0, 4);
  const softStep = softness ? Math.max(1, Math.round(softness * resolution)) : 0;
  const softMix = softness * .060;
  const gloss = Math.max(.78, (1 + (100 - R.gloss) * .028) * resolution);
  const grazingWidth = Math.max(1.3, 3.15 * resolution);
  for (let py = scrY; py < endY; py++) {
    const iy = py + .5 - centerY, ay = Math.abs(iy) - halfH + r, dy = Math.max(0, ay), v = iy / halfH;
    for (let px = scrX; px < endX; px++) {
      const ix = px + .5 - centerX, ax = Math.abs(ix) - halfW + r, dx = Math.max(0, ax);
      // No normals, exponentials or chromatic samples are needed in the clear
      // interior, except for the intentionally stronger file-stage lens.
      const hyp = dx || dy ? Math.sqrt(dx * dx + dy * dy) : 0;
      const d = r - hyp - Math.min(Math.max(ax, ay), 0);
      if (d <= -.5) continue;
      const idx = (py * w + px) * 4;
      if (!stage && d > depth * 1.42 + 2) {
        if (softStep > 0) {
          // A small, symmetric sample softens only the backdrop in the clear lens interior.
          const a = (Math.max(0, py - softStep) * w + px) * 4;
          const b = (Math.min(h - 1, py + softStep) * w + px) * 4;
          const c = (py * w + Math.max(0, px - softStep)) * 4;
          const e = (py * w + Math.min(w - 1, px + softStep)) * 4;
          for (let channel = 0; channel < 3; channel++) {
            out[idx + channel] = (1 - 4 * softMix) * source[idx + channel] +
              softMix * (source[a + channel] + source[b + channel] + source[c + channel] + source[e + channel]);
          }
        }
        continue;
      }
      const u = ix / halfW;
      const nx = hyp ? Math.sign(ix) * dx / hyp : ax > ay ? Math.sign(ix) : 0;
      const ny = hyp ? Math.sign(iy) * dy / hyp : ax <= ay ? Math.sign(iy) : 0;
      const outer = clamp(1 - d / depth), sq = outer * outer;
      const warp = warpMax * Math.pow(outer, 1.1 + 1.4 * R.roundness / 100);
      const zoom = stage ? mag * clamp(1 - u * u - v * v) : mag * sq;
      const X = clamp(px + nx * warp - ix * zoom, 0, w - 1.001);
      const Y = clamp(py + ny * warp - iy * zoom, 0, h - 1.001);
      const sx = Math.floor(X), sy = Math.floor(Y), i = (sy * w + sx) * 4, next = i + w * 4;
      const fx = X - sx, fy = Y - sy, a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
      let red = source[i] * a + source[i + 4] * b + source[next] * c + source[next + 4] * e;
      let green = source[i + 1] * a + source[i + 5] * b + source[next + 1] * c + source[next + 5] * e;
      let blue = source[i + 2] * a + source[i + 6] * b + source[next + 2] * c + source[next + 6] * e;
      if (sq > .045) {
        const separation = 2.65 * resolution * sq * appearance.dispersion / 100;
        const ar = (Math.round(clamp(Y + ny * separation, 0, h - 1)) * w + Math.round(clamp(X + nx * separation, 0, w - 1))) * 4;
        const ab = (Math.round(clamp(Y - ny * separation, 0, h - 1)) * w + Math.round(clamp(X - nx * separation, 0, w - 1))) * 4 + 2;
        red += (source[ar] - red) * .43 * sq; blue += (source[ab] - blue) * .43 * sq;
      }
      const dot = nx * lx + ny * ly, front = Math.max(0, dot), back = Math.max(0, -dot);
      const inEdge = clamp(1 - d / Math.max(1.15, 2.45 * resolution));
      let white = R.opacity / 100 + .44 * R.edging / 100 * front ** 3 * inEdge * inEdge;
      let color = 0;
      if (d < depth + 2) {
        const delta = (d - .6 * resolution) / gloss;
        white += reflect * (.035 + .19 * front ** 3) * Math.exp(-delta * delta);
        if (Math.abs(u) > .68 && Math.abs(v) > .58) {
          const nearX = (u - signX * (cu + shift)) / patchW;
          const nearY = (v - signY * cv) / patchH;
          const farX = (u + signX * (cu - shift)) / (patchW * .88);
          const farY = (v + signY * cv) / patchH;
          const near = nearX * nearX + nearY * nearY, far = farX * farX + farY * farY;
          const neck = (d - 1.8 * resolution) / grazingWidth;
          const lobe = Math.exp(-neck * neck) * (.38 + .62 * Math.abs(nx * ny) * 2);
          const hot = (.74 * Math.exp(-near) + .26 * Math.exp(-.45 * near)) * (.39 + .61 * front);
          const echo = Math.exp(-far) * (.41 + .59 * back);
          white += reflect * R.patches / 100 * lobe * (1.12 * hot + .56 * echo);
          color = lobe * R.iridescence / 100 * reflect * (hot - .63 * echo);
        }
      }
      const shade = clamp((.30 * R.edge / 100 * back + R.shadow / 100 * .045 * back ** 2) * sq);
      const alpha = clamp(d + .5);
      const wr = clamp(white);
      out[idx] += ((red + (reflectRed - red) * wr - 25 * color) * (1 - shade) - out[idx]) * alpha;
      out[idx + 1] += ((green + (reflectGreen - green) * wr + 7 * color) * (1 - shade) - out[idx + 1]) * alpha;
      out[idx + 2] += ((blue + (reflectBlue - blue) * wr + 57 * color) * (1 - shade) - out[idx + 2]) * alpha;
    }
  }
}

function AtmosphereFallback() {
  const id = useId();
  const artwork = ribbonGeometry();
  return <svg className="ae-glass-fallback" aria-hidden="true" viewBox="0 0 1000 640" preserveAspectRatio="none">
    <defs>
      <linearGradient id={`${id}-sheer`} x1="0" x2="35%" y1="0" y2="100%">
        <stop stopColor="var(--ae-static-violet)" stopOpacity=".45" />
        <stop offset="55%" stopColor="var(--ae-static-silk)" stopOpacity=".15" />
        <stop offset="100%" stopColor="var(--ae-static-silk)" stopOpacity=".52" />
      </linearGradient>
      <linearGradient id={`${id}-silk`} x1="0" x2="100%" y1="0" y2="100%">
        <stop stopColor="var(--ae-static-violet)" stopOpacity=".5" />
        <stop offset="50%" stopColor="var(--ae-static-silk)" stopOpacity=".14" />
        <stop offset="100%" stopColor="var(--ae-static-violet)" stopOpacity=".74" />
      </linearGradient>
      <linearGradient id={`${id}-light`}>
        <stop stopColor="var(--ae-static-lip)" stopOpacity="0" />
        <stop offset="57%" stopColor="var(--ae-static-lip)" stopOpacity=".12" />
        <stop offset="86%" stopColor="var(--ae-static-lip)" stopOpacity=".92" />
        <stop offset="100%" stopColor="var(--ae-static-lip)" stopOpacity=".16" />
      </linearGradient>
    </defs>
    <path d={artwork.rear} fill={`url(#${id}-sheer)`} />
    <path d={artwork.lower} fill={`url(#${id}-sheer)`} />
    <path d={artwork.returning} fill={`url(#${id}-silk)`} />
    <path d={artwork.front} fill={`url(#${id}-silk)`} />
    <path d={artwork.cyan} fill="none" stroke={`url(#${id}-light)`} strokeWidth="2.4" />
  </svg>;
}

/**
 * One visible, decorative canvas. Samples only the app-owned optical field.
 * Normal DOM and native dialogs remain the interactive/content/accessibility layer.
 */
export function GlassOptics({ appearanceRecipe }: { appearanceRecipe?: Partial<GlassAppearanceRecipe> } = {}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const shell = canvas?.parentElement;
    const theme = shell?.closest<HTMLElement>(".ae-theme");
    if (!canvas || !shell || !theme || typeof window.matchMedia !== "function") return;
    const ctx = canvas.getContext("2d", { alpha: false });
    const backing = document.createElement("canvas");
    const paint = backing.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx || !paint) return;
    const media = ["(forced-colors: active)", "(prefers-contrast: more)", "(prefers-reduced-transparency: reduce)", "(prefers-reduced-motion: reduce)"].map(query => window.matchMedia(query));
    const marked = new Set<HTMLElement>();
    let frame = 0, timer = 0, lastAdvanced = 0, phase = 0, deadline = 0, faulted = false;
    let atmosphere = atmosphereTarget();
    let output: ImageData | undefined;
    const tag = (next: Set<HTMLElement>) => {
      for (const element of marked) if (!next.has(element)) { delete element.dataset.aeLens; marked.delete(element); }
      for (const element of next) if (!marked.has(element)) { element.dataset.aeLens = "sampled"; marked.add(element); }
    };
    const clear = () => { delete shell.dataset.aeOptics; tag(new Set()); if (!canvas.hidden) canvas.hidden = true; };
    const paintFrame = (now: number) => {
      frame = 0;
      const explicit = theme.dataset;
      if (explicit.aeTheme !== "glass" || explicit.contrast === "increase" || explicit.transparency === "reduce"
        || media[0].matches || media[1].matches || media[2].matches || faulted) { clear(); return; }
      if (document.hidden || !shell.isConnected) return;
      const reduced = explicit.motion === "reduce" || media[3].matches;
      const seconds = lastAdvanced ? Math.min((now - lastAdvanced) / 1000, .25) : .14;
      phase += seconds * R.speed / 100;
      lastAdvanced = now;
      const bounds = shell.getBoundingClientRect();
      const top = Math.max(0, -bounds.top), left = Math.max(0, -bounds.left);
      const width = Math.min(bounds.right, window.innerWidth) - Math.max(0, bounds.left);
      const height = Math.min(bounds.bottom, window.innerHeight) - Math.max(0, bounds.top);
      if (width < 12 || height < 12) { clear(); return; }
      const scale = opticalViewportScale(width, height, window.devicePixelRatio || 1);
      const pw = Math.max(2, Math.round(width * scale)), ph = Math.max(2, Math.round(height * scale));
      if (backing.width !== pw || backing.height !== ph) { backing.width = pw; backing.height = ph; }
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; output = undefined; }
      canvas.style.left = left + "px"; canvas.style.top = top + "px";
      canvas.style.width = width + "px"; canvas.style.height = height + "px";
      const originX = bounds.left + left, originY = bounds.top + top;
      const elements = new Map<HTMLElement, Surface>();
      for (const element of shell.querySelectorAll<HTMLElement>(lensSelector)) {
        if (elements.size >= 24) break;
        const bb = element.getBoundingClientRect();
        if (bb.width < 2 || bb.height < 2 || bb.right <= originX || bb.bottom <= originY
          || bb.left >= originX + width || bb.top >= originY + height) continue;
        const style = getComputedStyle(element);
        const fanButton = element.closest<HTMLElement>(".ae-orbit-choice");
        if (style.visibility !== "visible" || style.display === "none" || +style.opacity === 0
          || (fanButton && +getComputedStyle(fanButton).opacity < .98)) continue;
        const corner = Number.parseFloat(style.borderTopLeftRadius);
        const kind = element.matches(".ae-file-slot") ? "stage" :
          element.matches(".ae-panel, .ae-transfer-dock") ? "panel" : "control";
        elements.set(element, { x: (bb.left - originX) * scale, y: (bb.top - originY) * scale,
          width: bb.width * scale, height: bb.height * scale,
          radius: Math.min(Number.isFinite(corner) ? corner : R.radius, bb.height / 2, bb.width / 2) * scale, kind });
      }
      try {
        const light = explicit.appearance === "light";
        const preset = glassAppearanceRecipes[light ? "light" : "dark"];
        const appearance = appearanceRecipe ? { ...preset, ...appearanceRecipe } : preset;
        const rift = Array.from(shell.querySelectorAll<HTMLElement>(".ae-transfer-space:not([hidden])"))
          .find(space => space.querySelector(".ae-workspace-view:not([hidden])"));
        const status = rift?.dataset;
        const target = atmosphereTarget(status?.experiencePhase, Number(status?.experienceProgress),
          Number(status?.experienceX), Number(status?.experienceY));
        const moving = Math.abs(target.energy - atmosphere.energy) > .01
          || Math.abs(target.bend - atmosphere.bend) > .03 || Math.abs(target.x - atmosphere.x) > .015
          || Math.abs(target.y - atmosphere.y) > .015;
        atmosphere = reduced ? target : blendAtmosphere(atmosphere, target, seconds);
        const t = reduced ? 0 : phase;
        const intensity = atmosphereIntensity(!!rift, atmosphere.energy, light) * clamp(appearance.ribbonIntensity, .25, 1.35);
        paintAtmosphere(paint, pw, ph, t, light, atmosphere, intensity, clamp(appearance.exposure, 50, 150));
        const source = paint.getImageData(0, 0, pw, ph).data;
        if (!output) output = ctx.createImageData(pw, ph);
        output.data.set(source);
        // Do not compound white reflections in nested controls: each surface
        // works against the original scene; later DOM children own their rims.
        for (const box of elements.values()) shadeLens(output.data, source, pw, ph, box, scale, t, appearance);
        ctx.putImageData(output, 0, 0);
        tag(new Set(elements.keys()));
        if (canvas.hidden) canvas.hidden = false;
        shell.dataset.aeOptics = "ready";
        // Schedule only an in-flight interaction/transition, never an idle loop.
        if (!reduced && (moving || deadline > now)) timer = window.setTimeout(queue, 55);
        else lastAdvanced = 0;
      } catch {
        faulted = true;
        clear();
        return;
      }
    };
    const onContextLost = () => { faulted = true; clear(); };
    const queue = () => {
      window.clearTimeout(timer);
      if (frame || document.hidden) return;
      const delay = Math.max(0, 50 - (performance.now() - lastAdvanced));
      if (delay > 4) timer = window.setTimeout(queue, delay);
      else frame = requestAnimationFrame(paintFrame);
    };
    const animate = () => { deadline = performance.now() + 680; queue(); };
    const opticalHover = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".ae-orbit")) animate();
    };
    const settle = () => queue();
    const appearanceChanged = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      paintFrame(performance.now());
    };
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame); window.clearTimeout(timer);
        frame = 0; lastAdvanced = 0;
      } else queue();
    };
    const onScroll = () => queue();
    const changes = new MutationObserver(records => {
      if (records.some(record => record.attributeName === "data-open" || record.attributeName === "data-morphing")) animate();
      else settle();
    });
    changes.observe(theme, { attributes: true, attributeFilter: ["data-ae-theme", "data-appearance", "data-contrast", "data-transparency", "data-motion"] });
    changes.observe(shell, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-current", "aria-disabled", "data-destination", "data-selected", "data-open", "data-morphing", "hidden", "disabled",
        "data-experience-phase", "data-experience-progress", "data-experience-x", "data-experience-y"] });
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(settle) : undefined;
    resize?.observe(shell);
    for (const mq of media) {
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", settle);
      else mq.addListener(settle);
    }
    canvas.addEventListener("contextlost", onContextLost);
    backing.addEventListener("contextlost", onContextLost);
    window.addEventListener("resize", settle);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", settle);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener(appearanceCommitEvent, appearanceChanged);
    shell.addEventListener("pointerdown", animate, { passive: true });
    shell.addEventListener("focusin", animate);
    shell.addEventListener("pointerover", opticalHover, { passive: true });
    shell.addEventListener("pointerout", opticalHover, { passive: true });
    deadline = performance.now() + 840;
    queue();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      changes.disconnect(); resize?.disconnect();
      for (const mq of media) {
        if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", settle);
        else mq.removeListener(settle);
      }
      canvas.removeEventListener("contextlost", onContextLost);
      backing.removeEventListener("contextlost", onContextLost);
      window.removeEventListener("resize", settle); window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener(appearanceCommitEvent, appearanceChanged);
      shell.removeEventListener("pointerdown", animate); shell.removeEventListener("focusin", animate);
      shell.removeEventListener("pointerover", opticalHover); shell.removeEventListener("pointerout", opticalHover);
      clear();
    };
  }, [appearanceRecipe]);
  return <><AtmosphereFallback /><canvas ref={ref} className="ae-glass-optics" aria-hidden="true" hidden /></>;
}

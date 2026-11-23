import { useEffect, useRef } from "react";

/** Source values from the owner's approved Liquid Glass Lab recipe. */
export const aeRiftGlassRecipe = Object.freeze({
  opacity: 2, warmth: 0, softness: 2, exposure: 108, depth: 9, radius: 26,
  roundness: 69, distortion: 40, dispersion: 100, magnify: 80, shadow: 61,
  reflection: 76, gloss: 100, patches: 60, patchSize: 58, iridescence: 30,
  edging: 77, edge: 44, light: 315, sweep: 53, drift: 48, speed: 116,
  scroll: 44, scene: "ribbons", surface: "all", showLens: true,
});

const lensSelector = [
  ".ae-workspace-nav", ".ae-panel", ".ae-file-slot", ".ae-file", ".ae-transfer", ".ae-activity-empty",
  ".ae-panel .ae-button:not([data-variant='primary'], [data-variant='quiet'], :disabled, [aria-disabled='true'])",
].join(",");

const R = aeRiftGlassRecipe;
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
type Surface = { x: number; y: number; width: number; height: number; radius: number; kind: "control" | "panel" | "stage" };

export function opticalViewportScale(width: number, height: number, dpr: number) {
  return Math.min(Math.max(1, dpr), 800 / width, Math.sqrt(390000 / (width * height)));
}

function backdrop(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, light: boolean) {
  const scene = ctx.createLinearGradient(0, 0, w, h);
  const stops = light ? ["#e0f1f7", "#e6e7f8", "#cfe8ef"] : ["#12273f", "#202751", "#173240"];
  scene.addColorStop(0, stops[0]); scene.addColorStop(.48, stops[1]); scene.addColorStop(1, stops[2]);
  ctx.fillStyle = scene; ctx.fillRect(0, 0, w, h);
  const drift = Math.sin(t * .86) * R.drift / 100;
  const glow = (x: number, y: number, radius: number, solid: string, clear: string) => {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, solid); gradient.addColorStop(1, clear);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  };
  glow(w * (.77 + .11 * drift), h * .21, Math.max(w * .45, 100), light ? "#c4e2e9b0" : "#21485ac9", "#3687bd00");
  glow(w * (.24 - .08 * drift), h * .71, Math.max(w * .47, 120), light ? "#c9c8ee8a" : "#3c346eb0", "#725db300");
  const colors = light ? ["#6b9bb23b", "#fff9", "#6c65ab31", "#f8fbffbf"] : ["#6ecbd025", "#c8f8fa28", "#a696de27", "#8fb7ff32"];
  ctx.lineCap = "round";
  for (let i = -8; i < 21; i++) {
    const x = w * (.075 * i + .10 * drift), y = h * (i % 2 ? -.12 : -.13);
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + .50 * w, .34 * h, x - .22 * w, .64 * h, x + .97 * w, h * 1.15);
    ctx.lineWidth = Math.max(.75, w / 1050) * (i % 7 === 0 ? 2 : 1);
    ctx.strokeStyle = colors[(i + 40) % colors.length]; ctx.stroke();
  }
  // The studio exposure applies to the background, not foreground labels.
  ctx.fillStyle = light ? `rgb(255 255 255 / ${(R.exposure - 100) * .0075})` : `rgb(143 183 224 / ${(R.exposure - 100) * .0044})`;
  ctx.fillRect(0, 0, w, h);
}

export function shadeLens(out: Uint8ClampedArray, source: Uint8ClampedArray, w: number, h: number, box: Surface, resolution: number, t: number) {
  const { x, y, width, height, radius, kind } = box;
  const scrX = Math.max(0, Math.floor(x)), scrY = Math.max(0, Math.floor(y));
  const endX = Math.min(w, Math.ceil(x + width)), endY = Math.min(h, Math.ceil(y + height));
  const halfW = width / 2, halfH = height / 2, centerX = x + halfW, centerY = y + halfH;
  const r = Math.min(radius, halfW, halfH);
  const stage = kind === "stage", panel = kind === "panel";
  const depth = Math.max(1.25, R.depth * resolution * (stage ? 1.40 : panel ? 1.05 : .72));
  // Cap the studio warp and zoom next to retained app text; file-stage glass
  // uses the strongest refraction, while functional labels are drawn by React.
  const warpMax = R.distortion * resolution * (stage ? .57 : panel ? .42 : .35);
  const mag = R.magnify * .01 * (stage ? .033 : panel ? .015 : .027);
  const angle = R.light * Math.PI / 180 + .23 * R.sweep / 53 * Math.sin(t * 1.31);
  const lx = Math.cos(angle), ly = Math.sin(angle);
  const cu = 1 - r / width, cv = 1 - r / height;
  const spread = R.patchSize / 100;
  const patchW = Math.max(.038, r / width * 1.9 + spread * .046);
  const patchH = Math.max(.079, r / height * 1.55 + spread * .055);
  const shift = .038 * Math.sin(t * 1.7);
  const signX = Math.sign(lx), signY = Math.sign(ly);
  const reflect = R.reflection / 100;
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
      if (d <= -.5 || (!stage && d > depth * 1.42 + 2)) continue;
      const idx = (py * w + px) * 4;
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
        const separation = 2.65 * resolution * sq * R.dispersion / 100;
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
          const lobe = Math.exp(-neck * neck) * (.51 + .49 * Math.abs(nx * ny) * 2);
          const hot = (.74 * Math.exp(-near) + .26 * Math.exp(-.45 * near)) * (.39 + .61 * front);
          const echo = Math.exp(-far) * (.41 + .59 * back);
          white += reflect * R.patches / 100 * lobe * (.91 * hot + .51 * echo);
          color = lobe * R.iridescence / 100 * reflect * (hot - .63 * echo);
        }
      }
      const shade = clamp((.30 * R.edge / 100 * back + R.shadow / 100 * .045 * back ** 2) * sq);
      const alpha = clamp(d + .5);
      const wr = clamp(white);
      out[idx] += ((red + (249 - red) * wr - 25 * color) * (1 - shade) - out[idx]) * alpha;
      out[idx + 1] += ((green + (253 - green) * wr + 7 * color) * (1 - shade) - out[idx + 1]) * alpha;
      out[idx + 2] += ((blue + (255 - blue) * wr + 57 * color) * (1 - shade) - out[idx + 2]) * alpha;
    }
  }
}

/**
 * One visible, decorative canvas. Samples only the app-owned optical field.
 * Normal DOM and native dialogs remain the interactive/content/accessibility layer.
 */
export function GlassOptics() {
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
    const media = ["(forced-colors: active)", "(prefers-contrast: more)", "(prefers-reduced-transparency: reduce)", "(prefers-reduced-motion: reduce)", "(prefers-color-scheme: light)"].map(query => window.matchMedia(query));
    const marked = new Set<HTMLElement>();
    let frame = 0, last = 0, lastAdvanced = 0, phase = 0, deadline = 0, faulted = false;
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
      if (last && now - last < 43) { frame = requestAnimationFrame(paintFrame); return; }
      last = now;
      if (!reduced && deadline > now) {
        phase += lastAdvanced ? Math.min((now - lastAdvanced) / 1000, .086) * R.speed / 100 : 0;
        lastAdvanced = now;
      } else lastAdvanced = 0;
      const bounds = shell.getBoundingClientRect();
      const top = Math.max(0, -bounds.top), left = Math.max(0, -bounds.left);
      const width = Math.min(bounds.right, window.innerWidth) - Math.max(0, bounds.left);
      const height = Math.min(bounds.bottom, window.innerHeight) - Math.max(0, bounds.top);
      if (width < 12 || height < 12) { clear(); return; }
      const scale = opticalViewportScale(width, height, window.devicePixelRatio || 1);
      const pw = Math.max(2, Math.round(width * scale)), ph = Math.max(2, Math.round(height * scale));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = backing.width = pw; canvas.height = backing.height = ph; output = undefined; }
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
        if (style.visibility !== "visible" || style.display === "none" || +style.opacity === 0) continue;
        const corner = Number.parseFloat(style.borderTopLeftRadius);
        const kind = element.matches(".ae-file-slot") ? "stage" : element.matches(".ae-panel, .ae-transfer, .ae-file, .ae-activity-empty") ? "panel" : "control";
        elements.set(element, { x: (bb.left - originX) * scale, y: (bb.top - originY) * scale,
          width: bb.width * scale, height: bb.height * scale,
          radius: Math.min(Number.isFinite(corner) ? corner : R.radius, bb.height / 2, bb.width / 2) * scale, kind });
      }
      try {
        const light = explicit.scheme === "light" || (explicit.scheme !== "dark" && media[4].matches);
        const t = reduced ? 0 : phase;
        backdrop(paint, pw, ph, t, light);
        const source = paint.getImageData(0, 0, pw, ph).data;
        if (!output) output = ctx.createImageData(pw, ph);
        output.data.set(source);
        // Do not compound white reflections in nested controls: each surface
        // works against the original scene; later DOM children own their rims.
        for (const box of elements.values()) shadeLens(output.data, source, pw, ph, box, scale, t);
        ctx.putImageData(output, 0, 0);
        tag(new Set(elements.keys()));
        if (canvas.hidden) canvas.hidden = false;
        shell.dataset.aeOptics = "ready";
      } catch {
        faulted = true;
        clear();
        return;
      }
      if (!reduced && deadline > now) frame = requestAnimationFrame(paintFrame);
      else lastAdvanced = 0;
    };
    const onContextLost = () => { faulted = true; clear(); };
    const queue = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(paintFrame); };
    const animate = () => { deadline = performance.now() + 480; queue(); };
    const settle = () => queue();
    const onScroll = () => queue();
    const changes = new MutationObserver(settle);
    changes.observe(theme, { attributes: true, attributeFilter: ["data-ae-theme", "data-scheme", "data-contrast", "data-transparency", "data-motion"] });
    changes.observe(shell, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-current", "data-destination", "data-selected", "hidden", "disabled"] });
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
    document.addEventListener("visibilitychange", settle);
    shell.addEventListener("pointerdown", animate, { passive: true });
    shell.addEventListener("focusin", animate);
    deadline = performance.now() + 840;
    queue();
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect(); resize?.disconnect();
      for (const mq of media) {
        if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", settle);
        else mq.removeListener(settle);
      }
      canvas.removeEventListener("contextlost", onContextLost);
      backing.removeEventListener("contextlost", onContextLost);
      window.removeEventListener("resize", settle); window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", settle);
      shell.removeEventListener("pointerdown", animate); shell.removeEventListener("focusin", animate);
      clear();
    };
  }, []);
  return <canvas ref={ref} className="ae-glass-optics" aria-hidden="true" hidden />;
}
